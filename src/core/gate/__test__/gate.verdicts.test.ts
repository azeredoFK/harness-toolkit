import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  findShipVerdict,
  lastShipVerdictFor,
  readShipVerdicts,
  recordShipVerdict,
  SHIP_VERDICT_LIMIT,
} from "../gate.verdicts.ts";

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function dir(): string {
  const path = mkdtempSync(join(tmpdir(), "tlc-verdicts-"));
  cleanup.push(path);
  return path;
}

const lint = ["biome", "check"];

describe("ship verdicts", () => {
  test("a verdict is found by gate, command and tree, and by nothing less", async () => {
    const root = dir();
    await recordShipVerdict(root, {
      gate: "lint",
      command: lint,
      tree: "t1",
      exitCode: 0,
      durationMs: 5,
      output: "ok",
    });

    assert.equal(findShipVerdict(root, "lint", lint, "t1")?.passed, true);
    assert.equal(findShipVerdict(root, "lint", lint, "t2"), null);
    assert.equal(findShipVerdict(root, "test", lint, "t1"), null);
    assert.equal(findShipVerdict(root, "lint", ["biome", "lint"], "t1"), null);
  });

  test("a later run of the same gate on the same tree replaces the earlier one", async () => {
    const root = dir();
    await recordShipVerdict(root, {
      gate: "lint",
      command: lint,
      tree: "t1",
      exitCode: 1,
      durationMs: 5,
      output: "bad",
    });
    await recordShipVerdict(root, {
      gate: "lint",
      command: lint,
      tree: "t1",
      exitCode: 0,
      durationMs: 7,
      output: "ok",
    });

    assert.equal(readShipVerdicts(root).length, 1);
    assert.equal(findShipVerdict(root, "lint", lint, "t1")?.passed, true);
  });

  test("the store keeps only the most recent verdicts", async () => {
    const root = dir();
    for (let n = 0; n < SHIP_VERDICT_LIMIT + 5; n++) {
      await recordShipVerdict(root, {
        gate: "lint",
        command: lint,
        tree: `t${n}`,
        exitCode: 0,
        durationMs: n,
        output: "",
      });
    }

    assert.equal(readShipVerdicts(root).length, SHIP_VERDICT_LIMIT);
    assert.equal(findShipVerdict(root, "lint", lint, "t0"), null);
    assert.equal(lastShipVerdictFor(root, "lint", lint)?.durationMs, SHIP_VERDICT_LIMIT + 4);
  });

  test("a linked worktree and its main checkout share one store", async () => {
    const main = dir();
    execFileSync("git", ["init", "-q"], { cwd: main });
    writeFileSync(join(main, "a.txt"), "a\n");
    execFileSync("git", ["add", "."], { cwd: main });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "i"], {
      cwd: main,
    });
    const linked = `${main}-wt`;
    cleanup.push(linked);
    execFileSync("git", ["worktree", "add", "-q", linked], { cwd: main });

    await recordShipVerdict(linked, {
      gate: "test",
      command: lint,
      tree: "t9",
      exitCode: 0,
      durationMs: 1,
      output: "",
    });

    assert.equal(findShipVerdict(main, "test", lint, "t9")?.passed, true);
  });
});
