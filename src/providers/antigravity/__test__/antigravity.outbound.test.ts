import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Decision, HarnessEvent, HarnessEventKind } from "../../../contracts/index.ts";
import { degrade } from "../../provider.degrade.ts";
import type { HookFailureCause } from "../../provider.port.ts";
import { antigravityCapabilities } from "../antigravity.capabilities.ts";
import { antigravityFailClosed } from "../antigravity.failure.ts";
import { antigravityRender, renderAntigravityFailure } from "../antigravity.outbound.ts";
import { ANTIGRAVITY_TOOLS } from "../antigravity.tools.ts";

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), "golden");

function golden(name: string, reason = ""): string {
  return readFileSync(join(GOLDEN_DIR, `${name}.json`), "utf8").replace("<reason>", reason);
}

function eventOf(kind: HarnessEventKind): HarnessEvent {
  return {
    provider: "antigravity",
    event: kind,
    sessionKey: "antigravity-probe",
    projectDir: "/tmp",
    raw: {},
  };
}

const EVENT = eventOf("tool.before");

/** Every kind a `antigravity:PreToolUse` translates to: the tool table's `pre`, plus `tool.before` for other names. */
const PRE_KINDS: HarnessEventKind[] = [
  ...new Set<HarnessEventKind>(["tool.before", ...ANTIGRAVITY_TOOLS.map((t) => t.pre)]),
];
/** Every kind a `antigravity:PostToolUse` or `antigravity:Stop` translates to. */
const SILENT_KINDS: HarnessEventKind[] = [
  ...new Set<HarnessEventKind>(["tool.after", "stop", ...ANTIGRAVITY_TOOLS.map((t) => t.post)]),
];

const SUCCESSES: Decision[] = [
  { kind: "abstain" },
  { kind: "allow" },
  { kind: "context", text: "ctx" },
  { kind: "continue", text: "keep going" },
  { kind: "rewriteOutput", output: "x" },
];

const REFUSALS: Decision[] = [
  { kind: "deny", reason: "r", rule: "x" },
  { kind: "ask", reason: "r", rule: "x" },
  { kind: "rewriteInput", input: {}, reason: "r" },
];

const CAUSES: HookFailureCause[] = [
  "launcher-error",
  "timeout",
  "invalid-stdin",
  "unrecognized-payload",
  "handler-error",
];

test("the PreToolUse kinds and the PostToolUse/Stop kinds do not overlap, so the kind names the host event", () => {
  for (const kind of PRE_KINDS) {
    assert.ok(!SILENT_KINDS.includes(kind), kind);
  }
});

test("AGH-08: before a tool, abstain, allow, context, continue and rewriteOutput render the allow golden", () => {
  for (const kind of PRE_KINDS) {
    for (const decision of SUCCESSES) {
      const rendered = antigravityRender(decision, eventOf(kind));
      assert.equal(rendered.stdout, golden("allow"), `${decision.kind} at ${kind}`);
      assert.equal(rendered.exitCode, 0);
    }
  }
});

test("AGH-08: after a tool and at Stop, the same five decisions render zero bytes, exit 0", () => {
  for (const kind of SILENT_KINDS) {
    for (const decision of SUCCESSES) {
      const rendered = antigravityRender(decision, eventOf(kind));
      assert.equal(rendered.stdout, "", `${decision.kind} at ${kind}`);
      assert.equal(rendered.exitCode, 0);
    }
  }
});

test("AGH-09: deny renders the deny golden with the decision's reason, decision before reason, on every event", () => {
  const reason = "rule=wiring-tamper: no";
  for (const kind of [...PRE_KINDS, ...SILENT_KINDS]) {
    const rendered = antigravityRender({ kind: "deny", reason, rule: "wiring-tamper" }, eventOf(kind));
    assert.equal(rendered.stdout, golden("deny", reason), kind);
    assert.equal(rendered.stdout, JSON.stringify({ decision: "deny", reason }), kind);
    assert.equal(rendered.exitCode, 0);
  }
});

test("AGH-10: ask and rewriteInput reaching the renderer are refusals carrying their reason, on every event", () => {
  for (const kind of [...PRE_KINDS, ...SILENT_KINDS]) {
    const ask = antigravityRender({ kind: "ask", reason: "confirm?", rule: "r" }, eventOf(kind));
    assert.equal(ask.stdout, JSON.stringify({ decision: "deny", reason: "confirm?" }), kind);
    const rewrite = antigravityRender(
      { kind: "rewriteInput", input: { a: 1 }, reason: "safer" },
      eventOf(kind),
    );
    assert.equal(rewrite.stdout, JSON.stringify({ decision: "deny", reason: "safer" }), kind);
    assert.equal(ask.exitCode, 0);
    assert.equal(rewrite.exitCode, 0);
  }
});

test("AGH-11: no output carries an unsupported decision value or permissionOverrides", () => {
  for (const kind of [...PRE_KINDS, ...SILENT_KINDS]) {
    for (const decision of [...SUCCESSES, ...REFUSALS]) {
      const stdout = antigravityRender(decision, eventOf(kind)).stdout ?? "";
      if (stdout === "") {
        continue;
      }
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      assert.ok(parsed.decision === "allow" || parsed.decision === "deny", `${decision.kind} at ${kind}`);
      assert.ok(!("permissionOverrides" in parsed), decision.kind);
      assert.ok(
        !["ask", "force_ask", "deny_unless_prior_grant", "continue"].includes(String(parsed.decision)),
      );
    }
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

function assertOneObject(stdout: string | null, label: string, allowed: string[]): void {
  assert.notEqual(stdout, null, label);
  assert.notEqual(stdout, "", label);
  assert.notEqual(stdout?.trim(), "{}", label);
  const parsed = JSON.parse(stdout ?? "") as Record<string, unknown>;
  assert.ok(allowed.includes(String(parsed.decision)), `${label}: ${stdout}`);
}

test("AGH-07: before a tool every render is exactly one allow/deny object; after a tool and at Stop, zero bytes or one deny", () => {
  for (const kind of PRE_KINDS) {
    for (const decision of [...SUCCESSES, ...REFUSALS]) {
      assertOneObject(antigravityRender(decision, eventOf(kind)).stdout, `${decision.kind} at ${kind}`, [
        "allow",
        "deny",
      ]);
    }
  }
  for (const kind of SILENT_KINDS) {
    for (const decision of SUCCESSES) {
      assert.equal(antigravityRender(decision, eventOf(kind)).stdout, "", `${decision.kind} at ${kind}`);
    }
    for (const decision of REFUSALS) {
      assertOneObject(antigravityRender(decision, eventOf(kind)).stdout, `${decision.kind} at ${kind}`, [
        "deny",
      ]);
    }
  }
  for (const cause of CAUSES) {
    assertOneObject(renderAntigravityFailure(cause).stdout, cause, ["deny"]);
  }
});

/**
 * why a named case: this host reads its output inverted against the other two. The discovery's Q3 table measured
 * `{}` refusing the tool (`-PreToolUse-view_file--.json`) and an empty stdout letting it run
 * (`empty-PostToolUse-view_file--.json`), so before a tool the renderer that is correct elsewhere would approve by
 * silence here. A failure response is the same refusal on every event, so it is never either shape.
 */
test("AGH-54: {} and an empty stdout are forbidden outputs at antigravity:PreToolUse (Q3, -PreToolUse-view_file--.json, empty-PostToolUse-view_file--.json)", () => {
  const forbidden = new Set(["{}", ""]);
  const every: (string | null)[] = [
    ...PRE_KINDS.flatMap((kind) =>
      [...SUCCESSES, ...REFUSALS].map((decision) => antigravityRender(decision, eventOf(kind)).stdout),
    ),
    ...CAUSES.map((cause) => renderAntigravityFailure(cause).stdout),
  ];
  for (const stdout of every) {
    assert.notEqual(stdout, null, "a null stdout is an empty write");
    assert.ok(!forbidden.has(stdout ?? ""), `forbidden output: ${JSON.stringify(stdout)}`);
    assert.ok(!forbidden.has((stdout ?? "").trim()), `forbidden output: ${JSON.stringify(stdout)}`);
  }
});

/**
 * why a named case: AD-048 measured on `agy` 1.2.14 that `{"decision":"allow"}` after a tool replaces the tool's
 * result with `unknown field "decision"` (`handoffs/e2e-proof.md` §4), and `{}` refuses the tool before one, so
 * neither may be the success shape after a tool or at Stop.
 */
test('AGH-54: {} and {"decision":"allow"} are forbidden success outputs at antigravity:PostToolUse and antigravity:Stop (AD-048, handoffs/e2e-proof.md §4)', () => {
  const forbidden = new Set(["{}", '{"decision":"allow"}']);
  for (const kind of SILENT_KINDS) {
    for (const decision of SUCCESSES) {
      const stdout = antigravityRender(decision, eventOf(kind)).stdout ?? "";
      assert.ok(!forbidden.has(stdout.trim()), `${decision.kind} at ${kind}: ${JSON.stringify(stdout)}`);
    }
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
