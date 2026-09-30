import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { ANTIGRAVITY_EVENT_PREFIX } from "../antigravity.events.ts";
import {
  ANTIGRAVITY_GROUP_NAME,
  antigravityProjectWiringTargets,
  antigravityRecoveryNotice,
  antigravityWiring,
  antigravityWiringProblems,
  antigravityWiringTargets,
  applyAntigravityWiring,
  mergeAntigravityGroup,
  renderAntigravityGroup,
  unwireAntigravityHooks,
} from "../antigravity.wiring.ts";

const LAUNCHER = "/opt/tlc/bin/tlc-exec.mjs";
const RUNTIME = { launcherPath: LAUNCHER };
const exists = () => true;

function expectedGroupText(launcher: string): string {
  return `{"PreToolUse":[{"matcher":".*","hooks":[{"type":"command","command":"node ${launcher} tool-before antigravity:PreToolUse","timeout":10}]}],"PostToolUse":[{"matcher":".*","hooks":[{"type":"command","command":"node ${launcher} tool-after antigravity:PostToolUse","timeout":10}]}],"Stop":[{"type":"command","command":"node ${launcher} stop antigravity:Stop","timeout":120}]}`;
}

function installed(launcher = LAUNCHER, before: Record<string, unknown> = {}): string {
  const merged = mergeAntigravityGroup(
    JSON.stringify(before),
    antigravityWiring({ launcherPath: launcher }).entries,
  );
  assert.ok(merged.ok);
  return merged.text;
}

test("AGH-30: wiring targets the global hooks file with exactly three entries", () => {
  const wiring = antigravityWiring(RUNTIME);
  assert.equal(wiring.target, join(homedir(), ".gemini", "config", "hooks.json"));
  assert.equal(wiring.strategy, "named-group");
  assert.equal(wiring.presencePath, join(homedir(), ".gemini", "antigravity-cli"));
  assert.deepEqual(wiring.entries, [
    {
      hookEvent: "PreToolUse",
      handler: "tool-before",
      command: "node",
      args: [LAUNCHER, "tool-before", "antigravity:PreToolUse"],
      timeoutSeconds: 10,
      matcher: ".*",
    },
    {
      hookEvent: "PostToolUse",
      handler: "tool-after",
      command: "node",
      args: [LAUNCHER, "tool-after", "antigravity:PostToolUse"],
      timeoutSeconds: 10,
      matcher: ".*",
    },
    {
      hookEvent: "Stop",
      handler: "stop",
      command: "node",
      args: [LAUNCHER, "stop", "antigravity:Stop"],
      timeoutSeconds: 120,
    },
  ]);
  for (const entry of wiring.entries) {
    assert.ok(entry.args[2]?.startsWith(ANTIGRAVITY_EVENT_PREFIX));
  }
});

test("AGH-31: the group written is the literal from the spec, unquoted and without enabled", () => {
  const group = renderAntigravityGroup(antigravityWiring(RUNTIME).entries);
  assert.equal(JSON.stringify(group), expectedGroupText(LAUNCHER));
  assert.ok(!("enabled" in group));
});

test("AGH-32: an absent or empty file becomes a document holding only the group", () => {
  for (const text of [null, "", "  \n"]) {
    const merged = mergeAntigravityGroup(text, antigravityWiring(RUNTIME).entries);
    assert.ok(merged.ok && merged.changed);
    assert.deepEqual(Object.keys(JSON.parse(merged.text)), [ANTIGRAVITY_GROUP_NAME]);
    assert.equal(
      JSON.stringify(JSON.parse(merged.text)[ANTIGRAVITY_GROUP_NAME]),
      expectedGroupText(LAUNCHER),
    );
  }
});

test("AGH-33: other root keys keep their value and their order", () => {
  const before = { first: { PreToolUse: [] }, [ANTIGRAVITY_GROUP_NAME]: { stale: true }, last: [1, 2] };
  const doc = JSON.parse(installed(LAUNCHER, before));
  assert.deepEqual(Object.keys(doc), ["first", ANTIGRAVITY_GROUP_NAME, "last"]);
  assert.deepEqual(doc.first, before.first);
  assert.deepEqual(doc.last, before.last);

  const appended = JSON.parse(installed(LAUNCHER, { mine: { Stop: [] } }));
  assert.deepEqual(Object.keys(appended), ["mine", ANTIGRAVITY_GROUP_NAME]);
});

test("AGH-34: a second merge with the same launcher changes nothing, byte for byte", () => {
  const text = installed();
  const again = mergeAntigravityGroup(text, antigravityWiring(RUNTIME).entries);
  assert.ok(again.ok);
  assert.equal(again.changed, false);
  assert.equal(again.text, text);
});

test("AGH-35: a new launcher replaces the group, leaving exactly one", () => {
  const moved = mergeAntigravityGroup(
    installed(),
    antigravityWiring({ launcherPath: "/new/bin/tlc-exec.mjs" }).entries,
  );
  assert.ok(moved.ok && moved.changed);
  assert.equal(moved.text.split(`"${ANTIGRAVITY_GROUP_NAME}"`).length - 1, 1);
  assert.ok(!moved.text.includes(LAUNCHER));
  assert.equal(
    JSON.stringify(JSON.parse(moved.text)[ANTIGRAVITY_GROUP_NAME]),
    expectedGroupText("/new/bin/tlc-exec.mjs"),
  );
});

test("AGH-36: invalid JSON or a non-object root is refused", () => {
  for (const text of ["{not json", "[]", '"text"', "7"]) {
    assert.equal(mergeAntigravityGroup(text, antigravityWiring(RUNTIME).entries).ok, false, text);
  }
});

test("AGF-26: a launcher with a space is refused with the measured reason and the file is left as it was", () => {
  const spaced = "C:\\Program Files\\x\\tlc-exec.mjs";
  const root = mkdtempSync(join(tmpdir(), "agy-space-"));
  try {
    const absent = join(root, "absent", "hooks.json");
    const present = join(root, "hooks.json");
    const before = `${JSON.stringify({ "outro-hook": { Stop: [] } }, null, 2)}\n`;
    writeFileSync(present, before);
    const reason = `launcher path contains a space — not wiring antigravity: ${spaced}. Quoting does not help on agy 1.2.14: the host splits the hook command on spaces, a quote stays a literal character in the argument, and the hook runs with its working directory set to the hooks.json directory.`;
    for (const target of [absent, present]) {
      const wiring = { ...antigravityWiring({ launcherPath: spaced }), target };
      assert.deepEqual(applyAntigravityWiring(wiring), { status: "refused", target, reason });
    }
    assert.equal(existsSync(absent), false);
    assert.equal(existsSync(dirname(absent)), false);
    assert.equal(readFileSync(present, "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("AGF-28: the rendered command stays unquoted, one space between the parts", () => {
  const group = renderAntigravityGroup(antigravityWiring(RUNTIME).entries) as Record<
    string,
    [{ command?: string; hooks?: [{ command: string }] }]
  >;
  const commands = [
    group.PreToolUse?.[0].hooks?.[0].command,
    group.PostToolUse?.[0].hooks?.[0].command,
    group.Stop?.[0].command,
  ];
  assert.deepEqual(commands, [
    `node ${LAUNCHER} tool-before antigravity:PreToolUse`,
    `node ${LAUNCHER} tool-after antigravity:PostToolUse`,
    `node ${LAUNCHER} stop antigravity:Stop`,
  ]);
  assert.ok(commands.every((command) => !command?.includes('"')));
});

test("AGH-40: unwire removes only the group, and reports an only-key file as empty", () => {
  assert.deepEqual(unwireAntigravityHooks(null), { kind: "absent" });
  assert.deepEqual(unwireAntigravityHooks(JSON.stringify({ other: {} })), { kind: "absent" });
  assert.deepEqual(unwireAntigravityHooks("{broken"), { kind: "unparsed" });
  assert.deepEqual(unwireAntigravityHooks(installed()), { kind: "empty" });

  const before = { first: { a: 1 }, second: [2] };
  const result = unwireAntigravityHooks(installed(LAUNCHER, before));
  assert.equal(result.kind, "rewritten");
  if (result.kind === "rewritten") {
    assert.equal(result.text, `${JSON.stringify(before, null, 2)}\n`);
  }
});

test("AGH-42: the global hooks file is the wiring target; the workspace file is a project target", () => {
  assert.deepEqual(antigravityWiringTargets(), [join(homedir(), ".gemini", "config", "hooks.json")]);
  assert.deepEqual(antigravityProjectWiringTargets("/w"), [join("/w", ".agents", "hooks.json")]);
});

test("AGH-64: a group exactly as install writes it has no problems", () => {
  assert.deepEqual(antigravityWiringProblems(installed(), RUNTIME, exists), []);
});

test("AGH-64: every way the group can be wrong is named", () => {
  const group = JSON.parse(installed())[ANTIGRAVITY_GROUP_NAME];
  const cases: [string | null, string, string][] = [
    [null, "(file)", "no hooks file at the expected path"],
    ["{bad", "(file)", "the hooks file is not valid JSON"],
    [JSON.stringify({ other: {} }), ANTIGRAVITY_GROUP_NAME, "no harness group"],
    [
      JSON.stringify({ [ANTIGRAVITY_GROUP_NAME]: { ...group, enabled: false } }),
      ANTIGRAVITY_GROUP_NAME,
      "disabled (enabled: false)",
    ],
    [JSON.stringify({ [ANTIGRAVITY_GROUP_NAME]: { ...group, Stop: [] } }), "Stop", "no harness entry"],
    [
      JSON.stringify({
        [ANTIGRAVITY_GROUP_NAME]: {
          ...group,
          Stop: [{ type: "command", command: `node ${LAUNCHER} stop Stop`, timeout: 120 }],
        },
      }),
      "Stop",
      "command lacks antigravity:Stop",
    ],
    [
      JSON.stringify({
        [ANTIGRAVITY_GROUP_NAME]: {
          ...group,
          Stop: [{ type: "command", command: `node ${LAUNCHER} stop antigravity:Stop`, timeout: 30 }],
        },
      }),
      "Stop",
      "differs from what install writes",
    ],
  ];
  for (const [text, hookEvent, reason] of cases) {
    assert.deepEqual(antigravityWiringProblems(text, RUNTIME, exists), [{ hookEvent, reason }], reason);
  }
  const missing = antigravityWiringProblems(installed(), RUNTIME, () => false);
  assert.equal(missing.length, 3);
  assert.ok(missing.every((problem) => problem.reason === `the script does not exist: ${LAUNCHER}`));
});

test("AGH-85: the recovery notice is three lines in order, and never offers the uninstall as recovery", () => {
  const target = join(homedir(), ".gemini", "config", "hooks.json");
  const lines = antigravityRecoveryNotice(target);
  assert.equal(lines.length, 3);
  assert.ok(lines[0]?.includes("unverified surfaces may deny every tool"));
  assert.ok(lines[0]?.includes("a CLI newer than 1.2.14"));
  assert.ok(lines[1]?.includes(`recovery: remove only the "tlc-harness" key from ${target}`));
  assert.ok(
    lines[2]?.includes(
      "last resort: tlc harness uninstall --yes also removes the Claude and Cursor harness hooks, the harness-init skill links, tlc from PATH and ~/.tlc/harness",
    ),
  );
  assert.ok(lines.every((line) => !line.includes("recovery: tlc harness uninstall --yes")));
});
