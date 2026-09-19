import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { projectConfigPath } from "../../../platform/paths.ts";
import { DEFAULT_UNTRUSTED_JUDGE } from "../../untrusted/untrusted.types.ts";
import { loadPolicy, resolveJudgeConfigErrors } from "../policy.loader.ts";

let runtimeSandbox: string;
let previousHome: string | undefined;

before(() => {
  runtimeSandbox = mkdtempSync(join(tmpdir(), "tlc-policy-judge-home-"));
  previousHome = process.env.TLC_HOME;
  process.env.TLC_HOME = runtimeSandbox;
});

after(() => {
  if (previousHome === undefined) {
    delete process.env.TLC_HOME;
  } else {
    process.env.TLC_HOME = previousHome;
  }
  rmSync(runtimeSandbox, { recursive: true, force: true });
});

function projectWith(judge: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "tlc-policy-judge-"));
  const path = projectConfigPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ version: 1, untrustedContent: { enabled: true, mode: "enforce", judge } }),
  );
  return root;
}

test("C25 a judge block setting only some of its fields leaves every other field at its default", () => {
  const root = projectWith({ enabled: true, thresholds: { contentInstructsAgent: 0.8 } });
  try {
    const { judge } = loadPolicy(root).untrustedContent;
    assert.equal(judge.enabled, true);
    assert.equal(judge.thresholds.contentInstructsAgent, 0.8);
    // invariant: the sibling threshold keeps its default rather than becoming undefined — the defect a two-level
    // merge would produce, and the one that would route on `undefined >= undefined`.
    assert.equal(
      judge.thresholds.commandFollowsContent,
      DEFAULT_UNTRUSTED_JUDGE.thresholds.commandFollowsContent,
    );
    for (const field of [
      "mode",
      "timeoutMs",
      "concurrency",
      "maxEntryChars",
      "maxOperatorPromptChars",
      "model",
    ] as const) {
      assert.equal(judge[field], DEFAULT_UNTRUSTED_JUDGE[field], field);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("C25 a config with no judge block at all resolves to the shipped defaults, judge off", () => {
  const root = mkdtempSync(join(tmpdir(), "tlc-policy-judge-"));
  try {
    const path = projectConfigPath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1 }));
    const { judge } = loadPolicy(root).untrustedContent;
    assert.deepEqual(judge, DEFAULT_UNTRUSTED_JUDGE);
    assert.equal(judge.enabled, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const REJECTED: Array<[string, Record<string, unknown>, string]> = [
  [
    "a contentInstructsAgent threshold above 1",
    { enabled: true, thresholds: { contentInstructsAgent: 1.7 } },
    "untrustedContent.judge.thresholds.contentInstructsAgent",
  ],
  [
    "a commandFollowsContent threshold below 0",
    { enabled: true, thresholds: { commandFollowsContent: -0.2 } },
    "untrustedContent.judge.thresholds.commandFollowsContent",
  ],
  ["a zero timeoutMs", { enabled: true, timeoutMs: 0 }, "untrustedContent.judge.timeoutMs"],
  ["a negative concurrency", { enabled: true, concurrency: -1 }, "untrustedContent.judge.concurrency"],
  ["a fractional concurrency", { enabled: true, concurrency: 2.5 }, "untrustedContent.judge.concurrency"],
  ["a model alias that moves", { enabled: true, model: "jev-latest" }, "untrustedContent.judge.model"],
  ["an empty model", { enabled: true, model: " " }, "untrustedContent.judge.model"],
  [
    "a scope flag that is not a boolean",
    { enabled: true, scope: { edit: "yes" } },
    "untrustedContent.judge.scope.edit",
  ],
  ["a zero maxEntryChars", { enabled: true, maxEntryChars: 0 }, "untrustedContent.judge.maxEntryChars"],
  [
    "a maxOperatorPromptChars that is not a number",
    { enabled: true, maxOperatorPromptChars: "4000" },
    "untrustedContent.judge.maxOperatorPromptChars",
  ],
];

for (const [label, judge, field] of REJECTED) {
  test(`C26 ${label} is rejected at load with the offending field named`, () => {
    const root = projectWith(judge);
    try {
      const errors = resolveJudgeConfigErrors(root);
      assert.equal(errors.length, 1, errors.join(" · "));
      assert.match(errors[0] ?? "", new RegExp(field.replace(/\./g, "\\.")));
      // invariant: rejected means the judge does not run. Leaving the value in place would report a capability as
      // enabled while it asked about nothing.
      assert.equal(loadPolicy(root).untrustedContent.judge.enabled, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("C26 a valid judge block produces no errors and stays enabled", () => {
  const root = projectWith({
    enabled: true,
    mode: "ask",
    thresholds: { contentInstructsAgent: 0, commandFollowsContent: 1 },
    timeoutMs: 1,
    concurrency: 1,
    maxEntryChars: 1,
    maxOperatorPromptChars: 1,
  });
  try {
    assert.deepEqual(resolveJudgeConfigErrors(root), []);
    assert.equal(loadPolicy(root).untrustedContent.judge.enabled, true);
    assert.equal(loadPolicy(root).untrustedContent.judge.mode, "ask");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("C26 a mode outside record and ask is rejected with the field named", () => {
  const root = projectWith({ enabled: true, mode: "shadow" });
  try {
    const errors = resolveJudgeConfigErrors(root);
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /untrustedContent\.judge\.mode/);
    assert.equal(loadPolicy(root).untrustedContent.judge.enabled, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
