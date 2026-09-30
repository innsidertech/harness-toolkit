import assert from "node:assert/strict";
import { join, parse, resolve } from "node:path";
import { test } from "node:test";
import type { HarnessEvent, HarnessEventKind } from "../../../contracts/index.ts";
import { antigravityFloorHostFacts } from "../antigravity.floor-facts.ts";

const WORKSPACE = resolve("/work/space");
const HOME = resolve("/users/dev");
const TARGETS = [join(HOME, ".gemini", "config", "hooks.json"), join(WORKSPACE, ".agents", "hooks.json")];

function event(kind: HarnessEventKind, extra: Partial<HarnessEvent> = {}): HarnessEvent {
  return { provider: "antigravity", event: kind, sessionKey: "k", projectDir: WORKSPACE, raw: {}, ...extra };
}

function toolCall(name: string, args: unknown): Record<string, unknown> {
  return { toolCall: { name, args } };
}

test("the wiring names are the host's two hooks files and their file name", () => {
  const facts = antigravityFloorHostFacts(event("tool.before"), TARGETS, { home: HOME });
  assert.deepEqual(facts.wiringTextNames, [".agents/hooks.json", ".gemini/config/hooks.json"]);
  assert.deepEqual(facts.wiringFileNames, ["hooks.json"]);
  assert.equal(facts.foldCase, true);
});

test("an untranslated tool hands over every string of its arguments, at any depth", () => {
  const raw = toolCall("mcp_fs_write", {
    target: { file: "~/.gemini/config/hooks.json" },
    files: ["a.txt", ["b"]],
    n: 3,
  });
  const facts = antigravityFloorHostFacts(event("tool.before", { raw }), TARGETS, { home: HOME });
  assert.deepEqual(facts.untranslatedToolStrings, ["~/.gemini/config/hooks.json", "a.txt", "b"]);
});

test("a translated tool, and any event that is not tool.before, hands over no argument strings", () => {
  const translated = antigravityFloorHostFacts(
    event("tool.before", { raw: toolCall("write_to_file", { TargetFile: "x" }) }),
    TARGETS,
    { home: HOME },
  );
  assert.equal(translated.untranslatedToolStrings, undefined);
  const shell = antigravityFloorHostFacts(
    event("shell.before", { raw: toolCall("x_tool", { a: "b" }) }),
    TARGETS,
    {
      home: HOME,
    },
  );
  assert.equal(shell.untranslatedToolStrings, undefined);
});

test("a run_command Cwd resolves against the workspace, with ~ expanded and no realpath", () => {
  const cases: Array<[string, string]> = [
    [".agents", join(WORKSPACE, ".agents")],
    [join(WORKSPACE, "docs"), join(WORKSPACE, "docs")],
    ["~", HOME],
    ["~/.gemini/config", join(HOME, ".gemini", "config")],
    ["does/not/exist", join(WORKSPACE, "does", "not", "exist")],
  ];
  for (const [cwd, base] of cases) {
    const facts = antigravityFloorHostFacts(event("shell.before", { cwd }), TARGETS, { home: HOME });
    assert.equal(facts.shellBase, base, cwd);
    assert.equal(facts.shellBaseUnresolvable, undefined, cwd);
  }
});

test("a Cwd with $, % or a backtick is unresolvable and gives no base", () => {
  for (const cwd of [
    "$HOME/.gemini/config",
    "%USERPROFILE%\\.gemini\\config",
    "$env:USERPROFILE\\.gemini\\config",
    "`pwd`",
  ]) {
    const facts = antigravityFloorHostFacts(event("shell.before", { cwd }), TARGETS, { home: HOME });
    assert.equal(facts.shellBaseUnresolvable, true, cwd);
    assert.equal(facts.shellBase, undefined, cwd);
  }
});

test("without a Cwd, or outside run_command, the floor keeps the workspace as its base", () => {
  assert.equal(
    antigravityFloorHostFacts(event("shell.before"), TARGETS, { home: HOME }).shellBase,
    undefined,
  );
  const write = antigravityFloorHostFacts(event("tool.before", { cwd: ".agents" }), TARGETS, { home: HOME });
  assert.equal(write.shellBase, undefined);
  assert.equal(write.shellBaseUnresolvable, undefined);
});

test("protected ancestors hold a target strictly and exclude the workspace, the home and a filesystem root", () => {
  const { protectedAncestors } = antigravityFloorHostFacts(event("shell.before"), TARGETS, { home: HOME });
  for (const expected of [
    join(WORKSPACE, ".agents"),
    join(HOME, ".gemini", "config"),
    join(HOME, ".gemini"),
  ]) {
    assert.ok(protectedAncestors.includes(expected), expected);
  }
  for (const excluded of [WORKSPACE, HOME, parse(WORKSPACE).root, ...TARGETS]) {
    assert.ok(!protectedAncestors.includes(excluded), excluded);
  }
});

test("the canonical form is offered only for run_command on Windows, and expands a short name", () => {
  const deps = {
    platform: "win32" as const,
    home: "C:\\Users\\dev",
    exists: (path: string) =>
      ["C:\\", "C:\\Users", "C:\\Users\\dev", "C:\\Users\\dev\\GEMINI~1"].includes(path),
    realpath: (path: string) => (path === "C:\\Users\\dev\\GEMINI~1" ? "C:\\Users\\dev\\.gemini" : path),
  };
  const shell = antigravityFloorHostFacts(event("shell.before", { projectDir: "C:\\w" }), TARGETS, deps);
  assert.equal(shell.canonical?.("C:\\Users\\dev\\GEMINI~1\\config"), "C:\\Users\\dev\\.gemini\\config");
  const write = antigravityFloorHostFacts(event("tool.before", { projectDir: "C:\\w" }), TARGETS, deps);
  assert.equal(write.canonical, undefined);
  const posix = antigravityFloorHostFacts(event("shell.before"), TARGETS, { ...deps, platform: "linux" });
  assert.equal(posix.canonical, undefined);
});

test("a canonical form that cannot resolve throws, so the entrypoint refuses", () => {
  const facts = antigravityFloorHostFacts(event("shell.before", { projectDir: "C:\\w" }), TARGETS, {
    platform: "win32",
    home: "C:\\Users\\dev",
    exists: () => false,
    realpath: (path: string) => path,
  });
  assert.throws(() => facts.canonical?.("\\\\?\\Volume{00000000-0000-0000-0000-000000000000}\\x"));
});
