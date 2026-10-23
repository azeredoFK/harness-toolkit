import { existsSync } from "node:fs";
import { join } from "node:path";
import { linkedWorktreeMainRoot } from "../../platform/git.ts";
import { flagsDir } from "../../platform/paths.ts";
import { divergedPaths } from "./policy.integrity.ts";

export const PAUSE_FLAG = "skip-verify";

export function pauseFlagPath(root: string): string {
  return join(flagsDir(root), PAUSE_FLAG);
}

export function isPaused(root: string, sessionKey: string): boolean {
  const roots = [root, linkedWorktreeMainRoot(root)].filter(
    (candidate): candidate is string => candidate !== null,
  );
  return roots.some((candidate) => {
    const flag = pauseFlagPath(candidate);
    return existsSync(flag) && !divergedPaths(candidate, sessionKey).includes(flag);
  });
}
