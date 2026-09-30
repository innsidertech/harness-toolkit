import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { sanitizeSegment } from "../../../platform/sanitize.ts";
import { antigravityToEvent } from "../antigravity.inbound.ts";
import { ANTIGRAVITY_TOOLS } from "../antigravity.tools.ts";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as Record<string, unknown>;
}

function argsOf(raw: Record<string, unknown>): Record<string, unknown> {
  return (raw.toolCall as { args: Record<string, unknown> }).args;
}

function withToolCall(raw: Record<string, unknown>, name: string, args: Record<string, unknown>) {
  return { ...raw, toolCall: { name, args } };
}

test("AGH-16: a PreToolUse view_file is read.before of Read at AbsolutePath", () => {
  const raw = fixture("allow-PreToolUse-view_file--.json");
  const event = antigravityToEvent(raw, "antigravity:PreToolUse");
  assert.equal(event?.event, "read.before");
  assert.equal(event?.toolName, "Read");
  assert.equal(event?.filePath, argsOf(raw).AbsolutePath);
  assert.equal(event?.toolInput, undefined);
});

test("AGH-17: a PreToolUse write_to_file is tool.before of Write carrying the proposed content", () => {
  const raw = fixture("allow-PreToolUse-write_to_file--.json");
  const event = antigravityToEvent(raw, "antigravity:PreToolUse");
  assert.equal(event?.event, "tool.before");
  assert.equal(event?.toolName, "Write");
  assert.equal(event?.filePath, argsOf(raw).TargetFile);
  assert.equal(event?.proposedContent, "ok");
});

test("AGH-18: a PreToolUse replace_file_content is tool.before of Edit with old and new content", () => {
  const raw = fixture("allow-PreToolUse-replace_file_content--.json");
  const event = antigravityToEvent(raw, "antigravity:PreToolUse");
  assert.equal(event?.event, "tool.before");
  assert.equal(event?.toolName, "Edit");
  assert.equal(event?.filePath, argsOf(raw).TargetFile);
  assert.equal(event?.proposedOldContent, "capture-line-one");
  assert.equal(event?.proposedContent, "capture-line-two");
});

test("AGH-19: a PreToolUse run_command is shell.before with the command and its Cwd", () => {
  const raw = fixture("allow-PreToolUse-run_command--.json");
  const event = antigravityToEvent(raw, "antigravity:PreToolUse");
  assert.equal(event?.event, "shell.before");
  assert.equal(event?.command, 'Write-Output "hello-capture"');
  assert.equal(event?.cwd, argsOf(raw).Cwd);
  assert.equal(event?.toolName, undefined);
});

test("AGH-20: a PreToolUse invoke_subagent with one subagent is tool.before of Task with its type", () => {
  const event = antigravityToEvent(
    fixture("allow-PreToolUse-invoke_subagent--.json"),
    "antigravity:PreToolUse",
  );
  assert.equal(event?.event, "tool.before");
  assert.equal(event?.toolName, "Task");
  assert.equal(event?.spawnSubagentType, "probe");
});

test("AGH-21: invoke_subagent with no, zero or several subagents carries no spawn type", () => {
  const raw = fixture("allow-PreToolUse-invoke_subagent--.json");
  const native = (raw.toolCall as { name: string }).name;
  const one = { TypeName: "probe" };
  for (const args of [{}, { Subagents: [] }, { Subagents: [one, { TypeName: "other" }] }]) {
    const event = antigravityToEvent(withToolCall(raw, native, args), "antigravity:PreToolUse");
    assert.equal(event?.toolName, "Task");
    assert.equal(event?.spawnSubagentType, undefined, JSON.stringify(args));
  }
});

test("AGH-22: a tool outside the table is tool.before under its native name with args as toolInput", () => {
  const raw = fixture("allow-PreToolUse-define_subagent--.json");
  const event = antigravityToEvent(raw, "antigravity:PreToolUse");
  assert.equal(event?.event, "tool.before");
  assert.equal(event?.toolName, "define_subagent");
  assert.deepEqual(event?.toolInput, argsOf(raw));
});

test("AGH-23: the synthetic multi-replace fixture is tool.before of MultiEdit at TargetFile, marked unverified", () => {
  const raw = fixture("synthetic-PreToolUse-multi_replace_file_content--.json");
  const event = antigravityToEvent(raw, "antigravity:PreToolUse");
  assert.equal(event?.event, "tool.before");
  assert.equal(event?.toolName, "MultiEdit");
  assert.equal(event?.filePath, argsOf(raw).TargetFile);
  assert.equal(event?.proposedContent, undefined);
  const native = (raw.toolCall as { name: string }).name;
  assert.equal(ANTIGRAVITY_TOOLS.find((entry) => entry.native === native)?.verified, false);
  assert.ok(ANTIGRAVITY_TOOLS.filter((entry) => entry.native !== native).every((entry) => entry.verified));
});

test("AGH-24: PostToolUse maps through the same table", () => {
  const shell = antigravityToEvent(
    fixture("allow-PostToolUse-run_command--.json"),
    "antigravity:PostToolUse",
  );
  assert.equal(shell?.event, "shell.after");
  assert.equal(shell?.command, 'Write-Output "hello-capture"');
  assert.equal(shell?.cwd, undefined);

  for (const [name, toolName] of [
    ["allow-PostToolUse-write_to_file--.json", "Write"],
    ["allow-PostToolUse-replace_file_content--.json", "Edit"],
  ] as const) {
    const raw = fixture(name);
    const event = antigravityToEvent(raw, "antigravity:PostToolUse");
    assert.equal(event?.event, "edit.after", name);
    assert.equal(event?.toolName, toolName, name);
    assert.equal(event?.filePath, argsOf(raw).TargetFile, name);
    assert.equal(event?.proposedContent, undefined, name);
  }

  for (const [name, toolName] of [
    ["allow-PostToolUse-view_file--.json", "Read"],
    ["allow-PostToolUse-invoke_subagent--.json", "Task"],
    ["allow-PostToolUse-define_subagent--.json", "define_subagent"],
  ] as const) {
    const raw = fixture(name);
    const event = antigravityToEvent(raw, "antigravity:PostToolUse");
    assert.equal(event?.event, "tool.after", name);
    assert.equal(event?.toolName, toolName, name);
    assert.deepEqual(event?.toolInput, argsOf(raw), name);
  }
});

test("AGH-25: no after-event carries toolOutput, and an error field does not make a tool.failure", () => {
  for (const name of readdirSync(FIXTURE_DIR).filter((file) => file.startsWith("allow-PostToolUse-"))) {
    const raw = { ...fixture(name), error: "the tool failed" };
    const event = antigravityToEvent(raw, "antigravity:PostToolUse");
    assert.equal(event?.toolOutput, undefined, name);
    assert.notEqual(event?.event, "tool.failure", name);
  }
});

test("AGH-26: both captured Stops are the canonical stop", () => {
  for (const name of ["allow-Stop--NO_TOOL_CALL-.json", "allow-Stop--NO_TOOL_CALL-idle.json"]) {
    assert.equal(antigravityToEvent(fixture(name), "antigravity:Stop")?.event, "stop", name);
  }
});

test("AGH-15: the event comes from the argv token, never from the payload", () => {
  const raw = fixture("allow-PreToolUse-view_file--.json");
  assert.equal(antigravityToEvent(raw, "antigravity:Stop")?.event, "stop");
  assert.equal(antigravityToEvent(raw, "antigravity:PostToolUse")?.event, "tool.after");
  assert.equal(antigravityToEvent(raw, "antigravity:PreToolUse")?.event, "read.before");
});

test("AGH-27: base fields come from the payload even when the working directory is .agents", () => {
  const scratch = mkdtempSync(join(tmpdir(), "tlc-agy-cwd-"));
  const agents = join(scratch, ".agents");
  mkdirSync(agents);
  const previous = process.cwd();
  process.chdir(agents);
  try {
    for (const name of readdirSync(FIXTURE_DIR).filter((file) =>
      /-(PreToolUse|PostToolUse|Stop)-/.test(file),
    )) {
      const raw = fixture(name);
      const token = `antigravity:${/-(PreToolUse|PostToolUse|Stop)-/.exec(name)?.[1]}`;
      const event = antigravityToEvent(raw, token);
      assert.equal(event?.provider, "antigravity", name);
      assert.equal(event?.sessionKey, `antigravity-${sanitizeSegment(String(raw.conversationId))}`, name);
      assert.equal(event?.model, raw.modelName, name);
      assert.equal(event?.transcriptPath, raw.transcriptPath, name);
      assert.equal(event?.projectDir, resolve((raw.workspacePaths as string[])[0] ?? ""), name);
      assert.notEqual(event?.projectDir, agents, name);
      assert.equal(event?.raw, raw, name);
    }
  } finally {
    process.chdir(previous);
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("AGH-28: an empty workspace list or an unwired token translates to null", () => {
  const raw = fixture("allow-PreToolUse-view_file--.json");
  assert.equal(antigravityToEvent({ ...raw, workspacePaths: [] }, "antigravity:PreToolUse"), null);
  assert.equal(antigravityToEvent({ ...raw, workspacePaths: [""] }, "antigravity:PreToolUse"), null);
  for (const token of [
    "antigravity:PreInvocation",
    "antigravity:PostInvocation",
    "antigravity:Other",
    "PreToolUse",
    "Stop",
    "",
    undefined,
  ]) {
    assert.equal(antigravityToEvent(raw, token), null, String(token));
  }
  assert.equal(antigravityToEvent(fixture("allow-PreInvocation---.json"), "antigravity:PreInvocation"), null);
  assert.equal(
    antigravityToEvent(fixture("allow-PostInvocation---.json"), "antigravity:PostInvocation"),
    null,
  );
});

test("toEvent never throws on a malformed payload", () => {
  for (const raw of [
    {},
    { workspacePaths: "x" },
    { workspacePaths: ["/w"], toolCall: "x" },
    { toolCall: null },
  ]) {
    assert.doesNotThrow(() => antigravityToEvent(raw, "antigravity:PreToolUse"));
  }
  const event = antigravityToEvent(
    { workspacePaths: ["/w"], toolCall: { args: 5 } },
    "antigravity:PreToolUse",
  );
  assert.equal(event?.event, "tool.before");
  assert.deepEqual(event?.toolInput, {});
});
