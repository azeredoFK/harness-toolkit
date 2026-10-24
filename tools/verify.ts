import { spawn } from "node:child_process";
import { coreFacade } from "../src/core/index.ts";
import { emitJson, takeJsonFlag } from "../src/platform/cli-output.ts";
import { gitRootOf, workingTreeId } from "../src/platform/git.ts";
import { findProjectRoot } from "../src/platform/paths.ts";

const OUTPUT_KEEP_CHARS = 64 * 1024;

export type VerifyGate = { gate: string; command: string[] };

export type VerifyOutcome = {
  gate: string;
  command: string[];
  exitCode: number;
  durationMs: number;
  recorded: boolean;
  treeChanged: boolean;
};

export function gatesToVerify(policy: ReturnType<typeof coreFacade.policy.loadPolicy>): VerifyGate[] {
  const gates: VerifyGate[] = [];
  if (policy.grind.enabled && policy.grind.lintCommand && policy.grind.lintCommand.length > 0) {
    gates.push({ gate: "lint", command: policy.grind.lintCommand });
  }
  if (policy.grind.enabled && policy.grind.testCommand && policy.grind.testCommand.length > 0) {
    gates.push({ gate: "test", command: policy.grind.testCommand });
  }
  if (policy.docs.command && policy.docs.command.length > 0 && policy.docs.severity === "deny") {
    gates.push({ gate: "docs", command: policy.docs.command });
  }
  return gates;
}

function runStreaming(
  command: string[],
  cwd: string,
  echo: boolean,
): Promise<{ exitCode: number; output: string; durationMs: number }> {
  const started = Date.now();
  const [file, ...args] = command;
  return new Promise((resolve) => {
    let output = "";
    const keep = (chunk: Buffer, sink: NodeJS.WriteStream) => {
      if (echo) {
        sink.write(chunk);
      }
      output = (output + chunk.toString("utf8")).slice(-OUTPUT_KEEP_CHARS);
    };
    const child = spawn(file ?? "", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk: Buffer) => keep(chunk, process.stdout));
    child.stderr.on("data", (chunk: Buffer) => keep(chunk, process.stderr));
    child.on("error", (error) => {
      resolve({ exitCode: 127, output: `${output}\n${error.message}`, durationMs: Date.now() - started });
    });
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, output, durationMs: Date.now() - started });
    });
  });
}

export async function verify(args: {
  root: string;
  cwd: string;
  gates: VerifyGate[];
  echo?: boolean;
  log?: (line: string) => void;
}): Promise<{ tree: string | null; outcomes: VerifyOutcome[] }> {
  const log = args.log ?? ((line: string) => console.log(line));
  const gitRoot = (await gitRootOf(args.cwd)) ?? args.cwd;
  const outcomes: VerifyOutcome[] = [];
  let tree = await workingTreeId(gitRoot);
  for (const { gate, command } of args.gates) {
    const before = tree;
    log(`▸ ${gate}: ${command.join(" ")}`);
    const result = await runStreaming(command, gitRoot, args.echo ?? true);
    tree = await workingTreeId(gitRoot);
    const treeChanged = before === null || tree !== before;
    if (!treeChanged && before !== null) {
      await coreFacade.gate.recordShipVerdict(args.root, {
        gate,
        command,
        tree: before,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        output: result.output,
      });
    }
    outcomes.push({
      gate,
      command,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      recorded: !treeChanged,
      treeChanged,
    });
    log(
      `${result.exitCode === 0 ? "✔" : "✖"} ${gate} — exit ${result.exitCode} in ${Math.round(result.durationMs / 1000)}s`,
    );
    if (result.exitCode !== 0) {
      break;
    }
  }
  return { tree, outcomes };
}

export async function main(argv: string[]): Promise<void> {
  const { json } = takeJsonFlag(argv);
  const root = process.env.TLC_PROJECT_DIR ?? findProjectRoot(process.cwd()) ?? process.cwd();
  const policy = coreFacade.policy.loadPolicy(root);
  const gates = gatesToVerify(policy);
  if (gates.length === 0) {
    const message = "verify: no lint, test or docs gate is configured — nothing to verify";
    if (json) {
      emitJson({ tree: null, outcomes: [], message });
    } else {
      console.log(message);
    }
    return;
  }
  const { tree, outcomes } = await verify({
    root,
    cwd: process.cwd(),
    gates,
    echo: !json,
    ...(json ? { log: (line: string) => console.error(line) } : {}),
  });
  const failed = outcomes.find((outcome) => outcome.exitCode !== 0);
  const changed = outcomes.find((outcome) => outcome.treeChanged);
  if (json) {
    emitJson({ tree, outcomes });
  } else if (failed) {
    console.log(`verify: ${failed.gate} failed — fix it and run \`tlc harness verify\` again`);
  } else if (changed) {
    console.log(
      `verify: ${changed.gate} changed files while it ran, so its result describes a tree that no longer exists — review the changes and run \`tlc harness verify\` again`,
    );
  } else {
    console.log(`verify: all gates passed for tree ${tree?.slice(0, 12)} — commit, push and PR may proceed`);
  }
  process.exit(failed || changed ? 1 : 0);
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
