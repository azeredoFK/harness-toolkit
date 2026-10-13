import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const launcher = join(repoRoot, "bin", "tlc-exec.mjs");

const workspace = mkdtempSync(join(tmpdir(), "tlc-cloud-agent-"));
mkdirSync(join(workspace, ".tlc", "harness"), { recursive: true });
writeFileSync(
  join(workspace, ".tlc", "harness", "config.json"),
  JSON.stringify({ version: 1, mode: "focus" }),
);

after(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function launch(handler: string, stdin: string, env: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, [launcher, handler], {
    input: stdin,
    encoding: "utf8",
    cwd: workspace,
    env: { ...process.env, TLC_HOME: repoRoot, CURSOR_PROJECT_DIR: undefined, ...env },
  });
}

function cloudPayload(hookEventName: string, fields: Record<string, unknown>): Record<string, unknown> {
  return {
    hook_event_name: hookEventName,
    conversation_id: "bc-cloud-conversation",
    generation_id: "gen-1",
    model: "composer-2.5",
    cursor_version: "3.0.0",
    user_email: null,
    transcript_path: null,
    ...fields,
  };
}

function verdictOf(stdout: string): Record<string, unknown> {
  assert.notEqual(stdout.trim(), "", "a fail-closed Cursor hook must never answer with empty stdout");
  return JSON.parse(stdout) as Record<string, unknown>;
}

const toolCalls: Array<[string, Record<string, unknown>]> = [
  ["Shell", { command: "tlc harness status" }],
  ["Read", { file_path: join(workspace, ".tlc", "harness", "config.json") }],
  ["Grep", { pattern: "harness", path: "/tmp" }],
  ["Write", { file_path: join(workspace, "notes.txt"), content: "hello\n" }],
  ["MCP:environment-info", {}],
];

const payloadShapes: Array<[string, Record<string, unknown>]> = [
  ["without workspace_roots", {}],
  ["with workspace_roots", { workspace_roots: [workspace] }],
];

describe("Cursor Cloud Agent: preToolUse answers every tool with a verdict", () => {
  for (const [shape, extra] of payloadShapes) {
    for (const [toolName, toolInput] of toolCalls) {
      test(`${toolName} ${shape}`, () => {
        const payload = cloudPayload("preToolUse", { tool_name: toolName, tool_input: toolInput, ...extra });
        const result = launch("tool-before", JSON.stringify(payload));

        assert.equal(result.status, 0, result.stderr);
        assert.notEqual(verdictOf(result.stdout).permission, "deny", result.stdout);
      });
    }
  }
});

describe("Cursor Cloud Agent: shell, read and subagent hooks answer with a verdict", () => {
  for (const [shape, extra] of payloadShapes) {
    test(`beforeShellExecution ${shape}`, () => {
      const payload = cloudPayload("beforeShellExecution", { command: "ls -la", cwd: workspace, ...extra });
      const result = launch("tool-before", JSON.stringify(payload));

      assert.equal(result.status, 0, result.stderr);
      assert.notEqual(verdictOf(result.stdout).permission, "deny", result.stdout);
    });

    test(`beforeReadFile ${shape}`, () => {
      const payload = cloudPayload("beforeReadFile", {
        file_path: join(workspace, ".tlc", "harness", "config.json"),
        content: "{}",
        ...extra,
      });
      const result = launch("tool-before", JSON.stringify(payload));

      assert.equal(result.status, 0, result.stderr);
      assert.notEqual(verdictOf(result.stdout).permission, "deny", result.stdout);
    });

    test(`subagentStart ${shape}`, () => {
      const payload = cloudPayload("subagentStart", {
        subagent_type: "generalPurpose",
        task: "run status",
        ...extra,
      });
      const result = launch("subagent-start", JSON.stringify(payload));

      assert.equal(result.status, 0, result.stderr);
      verdictOf(result.stdout);
    });
  }

  test("the project directory comes from CURSOR_PROJECT_DIR when workspace_roots is absent", () => {
    const payload = cloudPayload("beforeShellExecution", { command: "ls", cwd: "/" });
    const result = launch("tool-before", JSON.stringify(payload), { CURSOR_PROJECT_DIR: workspace });

    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(verdictOf(result.stdout).permission, "deny", result.stdout);
  });
});

describe("Cursor Cloud Agent: the guard still guards", () => {
  for (const [shape, extra] of payloadShapes) {
    test(`a destructive command is still denied ${shape}`, () => {
      const payload = cloudPayload("beforeShellExecution", { command: "rm -rf /", cwd: workspace, ...extra });
      const result = launch("tool-before", JSON.stringify(payload));

      assert.equal(result.status, 0, result.stderr);
      assert.equal(verdictOf(result.stdout).permission, "deny", result.stdout);
    });
  }
});

describe("Cursor Cloud Agent: an input no provider can read still gets an answer", () => {
  const inputs: Array<[string, string]> = [
    ["empty stdin", ""],
    ["whitespace stdin", "  \n"],
    ["invalid JSON", "{ not json"],
    ["a JSON array", "[]"],
    ["an object with no hook_event_name", JSON.stringify({ tool_name: "Shell" })],
    ["an unknown camelCase event", JSON.stringify(cloudPayload("someFutureHook", {}))],
  ];

  for (const [label, stdin] of inputs) {
    test(label, () => {
      const result = launch("tool-before", stdin);

      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(verdictOf(result.stdout), {});
    });
  }
});
