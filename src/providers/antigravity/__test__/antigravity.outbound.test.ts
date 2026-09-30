import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Decision, HarnessEvent } from "../../../contracts/index.ts";
import { degrade } from "../../provider.degrade.ts";
import type { HookFailureCause } from "../../provider.port.ts";
import { antigravityCapabilities } from "../antigravity.capabilities.ts";
import { antigravityFailClosed } from "../antigravity.failure.ts";
import { antigravityRender, renderAntigravityFailure } from "../antigravity.outbound.ts";

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), "golden");

function golden(name: string, reason = ""): string {
  return readFileSync(join(GOLDEN_DIR, `${name}.json`), "utf8").replace("<reason>", reason);
}

const EVENT: HarnessEvent = {
  provider: "antigravity",
  event: "tool.before",
  sessionKey: "antigravity-probe",
  projectDir: "/tmp",
  raw: {},
};

const CAUSES: HookFailureCause[] = [
  "launcher-error",
  "timeout",
  "invalid-stdin",
  "unrecognized-payload",
  "handler-error",
];

test("AGH-08: abstain, allow, context, continue and rewriteOutput all render the allow golden", () => {
  const decisions: Decision[] = [
    { kind: "abstain" },
    { kind: "allow" },
    { kind: "context", text: "ctx" },
    { kind: "continue", text: "keep going" },
    { kind: "rewriteOutput", output: "x" },
  ];
  for (const decision of decisions) {
    const rendered = antigravityRender(decision, EVENT);
    assert.equal(rendered.stdout, golden("allow"), decision.kind);
    assert.equal(rendered.exitCode, 0);
  }
});

test("AGH-09: deny renders the deny golden with the decision's reason, decision before reason", () => {
  const reason = "rule=wiring-tamper: no";
  const rendered = antigravityRender({ kind: "deny", reason, rule: "wiring-tamper" }, EVENT);
  assert.equal(rendered.stdout, golden("deny", reason));
  assert.equal(rendered.stdout, JSON.stringify({ decision: "deny", reason }));
  assert.equal(rendered.exitCode, 0);
});

test("AGH-10: ask and rewriteInput reaching the renderer are refusals carrying their reason", () => {
  const ask = antigravityRender({ kind: "ask", reason: "confirm?", rule: "r" }, EVENT);
  assert.equal(ask.stdout, JSON.stringify({ decision: "deny", reason: "confirm?" }));
  const rewrite = antigravityRender({ kind: "rewriteInput", input: { a: 1 }, reason: "safer" }, EVENT);
  assert.equal(rewrite.stdout, JSON.stringify({ decision: "deny", reason: "safer" }));
  assert.equal(ask.exitCode, 0);
  assert.equal(rewrite.exitCode, 0);
});

test("AGH-11: no output carries an unsupported decision value or permissionOverrides", () => {
  const decisions: Decision[] = [
    { kind: "abstain" },
    { kind: "allow" },
    { kind: "deny", reason: "r", rule: "x" },
    { kind: "ask", reason: "r", rule: "x" },
    { kind: "context", text: "t" },
    { kind: "continue", text: "t" },
    { kind: "rewriteInput", input: {}, reason: "r" },
    { kind: "rewriteOutput", output: "o" },
  ];
  for (const decision of decisions) {
    const parsed = JSON.parse(antigravityRender(decision, EVENT).stdout ?? "null") as Record<string, unknown>;
    assert.ok(parsed.decision === "allow" || parsed.decision === "deny", decision.kind);
    assert.ok(!("permissionOverrides" in parsed), decision.kind);
    assert.ok(!["ask", "force_ask", "deny_unless_prior_grant", "continue"].includes(String(parsed.decision)));
  }
});

test("AGH-50: an ask the handler returns reaches the host as a deny naming the missing escalation", () => {
  const decision: Decision = { kind: "ask", reason: "confirm the push", rule: "posture" };
  const degraded = degrade(decision, EVENT, antigravityCapabilities(), { contextBudgetChars: 6000 });
  const parsed = JSON.parse(antigravityRender(degraded, EVENT).stdout ?? "{}") as {
    decision: string;
    reason: string;
  };
  assert.equal(parsed.decision, "deny");
  assert.ok(parsed.reason.startsWith("Escalation unavailable on this provider — "), parsed.reason);
});

test("AGH-07: every render and every failure response is exactly one allow/deny object, never {} or empty", () => {
  const outputs = [
    antigravityRender({ kind: "abstain" }, EVENT).stdout,
    antigravityRender({ kind: "deny", reason: "r", rule: "x" }, EVENT).stdout,
    ...CAUSES.map((cause) => renderAntigravityFailure(cause).stdout),
  ];
  for (const stdout of outputs) {
    assert.notEqual(stdout, null);
    assert.notEqual(stdout?.trim(), "");
    assert.notEqual(stdout?.trim(), "{}");
    const parsed = JSON.parse(stdout ?? "") as Record<string, unknown>;
    assert.ok(parsed.decision === "allow" || parsed.decision === "deny");
  }
});

/**
 * why a named case: this host reads its output inverted against the other two. The discovery's Q3 table measured
 * `{}` refusing the tool (`-PreToolUse-view_file--.json`) and an empty stdout letting it run
 * (`empty-PostToolUse-view_file--.json`), so the renderer that is correct elsewhere would approve by silence here.
 */
test("AGH-54: {} and an empty stdout are forbidden outputs on this host (Q3, -PreToolUse-view_file--.json, empty-PostToolUse-view_file--.json)", () => {
  const forbidden = new Set(["{}", ""]);
  const every: (string | null)[] = [
    ...(
      [
        { kind: "abstain" },
        { kind: "allow" },
        { kind: "deny", reason: "r", rule: "x" },
        { kind: "ask", reason: "r", rule: "x" },
        { kind: "context", text: "t" },
        { kind: "continue", text: "t" },
        { kind: "rewriteInput", input: {}, reason: "r" },
        { kind: "rewriteOutput", output: "o" },
      ] as Decision[]
    ).map((decision) => antigravityRender(decision, EVENT).stdout),
    ...CAUSES.map((cause) => renderAntigravityFailure(cause).stdout),
  ];
  for (const stdout of every) {
    assert.notEqual(stdout, null, "a null stdout is an empty write");
    assert.ok(!forbidden.has((stdout ?? "").trim()), `forbidden output: ${JSON.stringify(stdout)}`);
  }
});

test("each failure cause renders the literal deny with its cause, exit 0", () => {
  for (const cause of CAUSES) {
    const rendered = antigravityFailClosed.failureResponse(cause);
    assert.equal(rendered.stdout, `{"decision":"deny","reason":"tlc-harness: ${cause}"}`);
    assert.equal(rendered.exitCode, 0);
  }
});

test("diagnosticRoot is the resolved first workspace, or null without one", () => {
  assert.equal(
    antigravityFailClosed.diagnosticRoot({ workspacePaths: ["/w/one", "/w/two"] }),
    resolve("/w/one"),
  );
  assert.equal(antigravityFailClosed.diagnosticRoot({ workspacePaths: [] }), null);
  assert.equal(antigravityFailClosed.diagnosticRoot({ workspacePaths: [5] }), null);
  assert.equal(antigravityFailClosed.diagnosticRoot("not an object"), null);
  assert.equal(antigravityFailClosed.diagnosticRoot(null), null);
});
