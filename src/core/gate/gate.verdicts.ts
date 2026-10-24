import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { updateJsonAtomic } from "../../platform/fs-atomic.ts";
import { linkedWorktreeMainRoot } from "../../platform/git.ts";
import { projectStateDir } from "../../platform/paths.ts";
import { trimOutputTail } from "./gate.artifact.ts";

const SHIP_VERDICT_SCHEMA = "harness.ship-verdicts.v1";
export const SHIP_VERDICT_LIMIT = 50;
export const VERIFY_SOURCE = "verify";

export type ShipVerdict = {
  gate: string;
  command: string[];
  tree: string;
  passed: boolean;
  exitCode: number;
  durationMs: number;
  outputTail: string;
  at: string;
  timedOut?: boolean;
  source?: string;
};

type ShipVerdictFile = { schema: string; verdicts: ShipVerdict[] };

function shipVerdictsPath(root: string): string {
  return join(projectStateDir(linkedWorktreeMainRoot(root) ?? root), "ship-verdicts.json");
}

function sameCommand(left: string[], right: string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function readShipVerdicts(root: string): ShipVerdict[] {
  const path = shipVerdictsPath(root);
  if (!existsSync(path)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ShipVerdictFile>;
    return Array.isArray(parsed.verdicts) ? parsed.verdicts : [];
  } catch {
    return [];
  }
}

export function findShipVerdict(
  root: string,
  gate: string,
  command: string[],
  tree: string,
  sources?: readonly string[],
): ShipVerdict | null {
  const matches = readShipVerdicts(root).filter(
    (verdict) =>
      verdict.timedOut !== true &&
      (sources === undefined || (verdict.source !== undefined && sources.includes(verdict.source))) &&
      verdict.gate === gate &&
      verdict.tree === tree &&
      sameCommand(verdict.command, command),
  );
  return matches.at(-1) ?? null;
}

export function lastShipVerdictFor(root: string, gate: string, command: string[]): ShipVerdict | null {
  const matches = readShipVerdicts(root).filter(
    (verdict) => verdict.gate === gate && sameCommand(verdict.command, command),
  );
  return matches.at(-1) ?? null;
}

export async function recordShipVerdict(
  root: string,
  input: Omit<ShipVerdict, "at" | "outputTail" | "passed"> & { output: string; at?: string },
): Promise<ShipVerdict> {
  const verdict: ShipVerdict = {
    gate: input.gate,
    command: input.command,
    tree: input.tree,
    passed: input.exitCode === 0 && input.timedOut !== true,
    exitCode: input.exitCode,
    durationMs: input.durationMs,
    outputTail: trimOutputTail(input.output),
    at: input.at ?? new Date().toISOString(),
    ...(input.timedOut === true ? { timedOut: true } : {}),
    ...(input.source !== undefined ? { source: input.source } : {}),
  };
  const path = shipVerdictsPath(root);
  await updateJsonAtomic<ShipVerdictFile>(
    path,
    (current) => {
      const kept = (current?.verdicts ?? []).filter(
        (existing) =>
          !(
            existing.gate === verdict.gate &&
            existing.tree === verdict.tree &&
            existing.source === verdict.source &&
            sameCommand(existing.command, verdict.command)
          ),
      );
      return { schema: SHIP_VERDICT_SCHEMA, verdicts: [...kept, verdict].slice(-SHIP_VERDICT_LIMIT) };
    },
    { lockPath: `${path}.lock` },
  );
  return verdict;
}
