import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { coreFacade } from "../../src/core/index.ts";
import { workingTreeId } from "../../src/platform/git.ts";
import { verify } from "../verify.ts";

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "tlc-verify-"));
  cleanup.push(dir);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  execFileSync("git", ["init", "-q"], { cwd: dir, env });
  writeFileSync(join(dir, ".gitignore"), ".tlc/\n");
  writeFileSync(join(dir, "app.ts"), "export const a = 1;\n");
  execFileSync("git", ["add", "."], { cwd: dir, env });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir, env });
  return dir;
}

function exits(code: number): string[] {
  return [process.execPath, "-e", `process.stdout.write("ran"); process.exit(${code});`];
}

const quiet = { echo: false, log: () => {} };

describe("tlc harness verify", () => {
  test("a passing gate is recorded against the tree it ran on", async () => {
    const dir = repo();
    const { tree, outcomes } = await verify({
      root: dir,
      cwd: dir,
      gates: [{ gate: "test", command: exits(0) }],
      ...quiet,
    });

    assert.equal(tree, await workingTreeId(dir));
    assert.equal(outcomes[0]?.recorded, true);
    const verdict = coreFacade.gate.findShipVerdict(dir, "test", exits(0), tree ?? "");
    assert.equal(verdict?.passed, true);
    assert.equal(verdict?.outputTail, "ran");
  });

  test("a failing gate is recorded as failing and the gates after it do not run", async () => {
    const dir = repo();
    const { tree, outcomes } = await verify({
      root: dir,
      cwd: dir,
      gates: [
        { gate: "lint", command: exits(1) },
        { gate: "test", command: exits(0) },
      ],
      ...quiet,
    });

    assert.deepEqual(
      outcomes.map((outcome) => outcome.gate),
      ["lint"],
    );
    assert.equal(coreFacade.gate.findShipVerdict(dir, "lint", exits(1), tree ?? "")?.passed, false);
    assert.equal(coreFacade.gate.findShipVerdict(dir, "test", exits(0), tree ?? ""), null);
  });

  test("a gate that rewrites files is not recorded, because its verdict describes a tree that is gone", async () => {
    const dir = repo();
    const formatter = [
      process.execPath,
      "-e",
      `require("node:fs").writeFileSync(${JSON.stringify(join(dir, "app.ts"))}, "x\\n");`,
    ];
    const before = await workingTreeId(dir);
    const { outcomes } = await verify({
      root: dir,
      cwd: dir,
      gates: [{ gate: "lint", command: formatter }],
      ...quiet,
    });

    assert.equal(outcomes[0]?.treeChanged, true);
    assert.equal(outcomes[0]?.recorded, false);
    assert.equal(coreFacade.gate.findShipVerdict(dir, "lint", formatter, before ?? ""), null);
  });

  test("a command that cannot start is a failure, not a pass", async () => {
    const dir = repo();
    const { outcomes } = await verify({
      root: dir,
      cwd: dir,
      gates: [{ gate: "test", command: ["tlc-no-such-binary-anywhere"] }],
      ...quiet,
    });

    assert.notEqual(outcomes[0]?.exitCode, 0);
  });

  test("a tree git cannot identify records nothing and is not reported as a changed tree", async () => {
    const plain = mkdtempSync(join(tmpdir(), "tlc-verify-plain-"));
    cleanup.push(plain);
    const { outcomes } = await verify({
      root: plain,
      cwd: plain,
      gates: [{ gate: "test", command: exits(0) }],
      ...quiet,
    });

    assert.equal(outcomes[0]?.unidentified, true);
    assert.equal(outcomes[0]?.treeChanged, false);
    assert.equal(outcomes[0]?.recorded, false);
  });
});
