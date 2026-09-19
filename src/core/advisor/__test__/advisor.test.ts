import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { projectStateDir } from "../../../platform/paths.ts";
import type { SystemOneRequest, SystemOneResult } from "../../../platform/typesafe.ts";
import type { AskFn } from "../../jev/jev.transport.ts";
import { advise, advisorObsAttrs } from "../advisor.service.ts";
import { readPreviousFailure, rememberFailure } from "../advisor.store.ts";
import { advisorConfigErrors, DEFAULT_JEV_ADVISOR, type JevAdvisorConfig } from "../advisor.types.ts";

const KEY_ENV = { TYPESAFE_API_KEY: "test-key", TLC_HOME: "/nowhere-this-test-never-reads" };
const NO_KEY_ENV = { TLC_HOME: "/nowhere-this-test-never-reads" };

function config(partial: Partial<JevAdvisorConfig> = {}): JevAdvisorConfig {
  return { ...DEFAULT_JEV_ADVISOR, enabled: true, ...partial };
}

function answering(scores: number[]): { ask: AskFn; requests: SystemOneRequest[] } {
  const requests: SystemOneRequest[] = [];
  return {
    requests,
    ask: async (request) => {
      const score = scores[requests.length] ?? 0;
      requests.push(request);
      return {
        ok: true,
        answers: { answer: score },
        model: DEFAULT_JEV_ADVISOR.model,
        inputTokens: 50,
        outputTokens: 20,
        latencyMs: 5,
      };
    },
  };
}

function inRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "tlc-advisor-"));
  return run(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

test("C40 every use ships off, and the defaults make no request even when the block is enabled", async () => {
  assert.equal(DEFAULT_JEV_ADVISOR.enabled, false);
  for (const use of ["lessonRank", "shipClaim", "commentNarration", "stagnation"] as const) {
    assert.equal(DEFAULT_JEV_ADVISOR[use], "off");
    const { ask, requests } = answering([0.9]);
    const outcome = await inRoot((root) =>
      advise({
        root,
        sessionKey: "s",
        config: config(),
        use,
        items: [{ id: "a", state: { x: "y" } }],
        env: KEY_ENV,
        ask,
      }),
    );
    assert.equal(outcome.outcome, "skipped");
    assert.equal(requests.length, 0);
  }
});

test("C40 the block switched off makes no request whatever the use says", async () => {
  const { ask, requests } = answering([0.9]);
  const outcome = await inRoot((root) =>
    advise({
      root,
      sessionKey: "s",
      config: config({ enabled: false, shipClaim: "record" }),
      use: "shipClaim",
      items: [{ id: "claim", state: { agent_response: "done" } }],
      env: KEY_ENV,
      ask,
    }),
  );
  assert.equal(outcome.outcome, "skipped");
  assert.equal(requests.length, 0);
});

test("C41 one request per item, each carrying only its own named fields and the use's one question", async () => {
  const { ask, requests } = answering([0.2, 0.8]);
  const outcome = await inRoot((root) =>
    advise({
      root,
      sessionKey: "s",
      config: config({ lessonRank: "record" }),
      use: "lessonRank",
      items: [
        { id: "l1", state: { failure_output: "TypeError at a.ts:3", lesson: "read the assertion" } },
        { id: "l2", state: { failure_output: "TypeError at a.ts:3", lesson: "check the types" } },
      ],
      env: KEY_ENV,
      ask,
    }),
  );
  assert.equal(outcome.outcome, "advised");
  assert.deepEqual(outcome.scores, { l1: 0.2, l2: 0.8 });
  assert.equal(requests.length, 2);
  assert.deepEqual(Object.keys(requests[0]?.state ?? {}), ["failure_output", "lesson"]);
  assert.match(requests[0]?.questions.answer?.instructions ?? "", /`lesson`.*`failure_output`/);
});

test("C41 text is masked and cut before it is sent, and never reaches the record", async () => {
  const token = `ghp_${"0123456789abcdefghijklmnopqrstuvwxyz"}`;
  const { ask, requests } = answering([0.9]);
  const cfg = config({ shipClaim: "record", maxChars: 80 });
  const outcome = await inRoot((root) =>
    advise({
      root,
      sessionKey: "s",
      config: cfg,
      use: "shipClaim",
      items: [
        { id: "claim", state: { agent_response: `all done, deployed with ${token} ${"x".repeat(500)}` } },
      ],
      env: KEY_ENV,
      ask,
    }),
  );
  const sent = String(requests[0]?.state.agent_response);
  assert.equal(sent.includes(token), false, "the token reached the request");
  assert.ok(sent.length <= 120, `cut to maxChars before masking, got ${sent.length}`);
  const recorded = JSON.stringify(advisorObsAttrs(outcome, cfg, { pattern_claimed: true }));
  assert.equal(recorded.includes("all done"), false, "the text reached the record");
  assert.match(recorded, /"pattern_claimed":true/);
  assert.match(recorded, /"use":"shipClaim"/);
});

test("C42 one unusable answer fails the whole call, so no caller ranks over a partial set", async () => {
  let calls = 0;
  const ask: AskFn = async (): Promise<SystemOneResult> => {
    calls += 1;
    return calls === 2
      ? { ok: false, category: "timeout", detail: "aborted", latencyMs: 2500 }
      : {
          ok: true,
          answers: { answer: 0.9 },
          model: DEFAULT_JEV_ADVISOR.model,
          inputTokens: 50,
          outputTokens: 20,
          latencyMs: 5,
        };
  };
  const cfg = config({ lessonRank: "apply", concurrency: 1 });
  const outcome = await inRoot((root) =>
    advise({
      root,
      sessionKey: "s",
      config: cfg,
      use: "lessonRank",
      items: ["a", "b", "c"].map((id) => ({ id, state: { failure_output: "f", lesson: id } })),
      env: KEY_ENV,
      ask,
    }),
  );
  assert.equal(outcome.outcome, "failed");
  assert.deepEqual(outcome.scores, {});
  assert.equal(advisorObsAttrs(outcome, cfg, {}).outcome, "error:timeout");
});

test("C42 with no key no request is made, and the call is recorded as auth rather than skipped", async () => {
  const { ask, requests } = answering([0.9]);
  const outcome = await inRoot((root) =>
    advise({
      root,
      sessionKey: "s",
      config: config({ stagnation: "record" }),
      use: "stagnation",
      items: [{ id: "same", state: { previous_failure: "a", current_failure: "b" } }],
      env: NO_KEY_ENV,
      ask,
    }),
  );
  assert.equal(requests.length, 0);
  assert.equal(outcome.outcome, "failed");
  assert.equal(outcome.failure?.category, "auth");
});

test("C42 one timeoutMs covers every wave", async () => {
  let clock = 0;
  const budgets: number[] = [];
  const ask: AskFn = async (_request, _key, timeoutMs) => {
    budgets.push(timeoutMs);
    clock += 400;
    return {
      ok: true,
      answers: { answer: 0.5 },
      model: DEFAULT_JEV_ADVISOR.model,
      inputTokens: 50,
      outputTokens: 20,
      latencyMs: 400,
    };
  };
  const outcome = await inRoot((root) =>
    advise({
      root,
      sessionKey: "s",
      config: config({ commentNarration: "record", timeoutMs: 1000, concurrency: 1 }),
      use: "commentNarration",
      items: ["a", "b", "c", "d"].map((id) => ({ id, state: { comment: id } })),
      env: KEY_ENV,
      ask,
      now: () => clock,
    }),
  );
  assert.deepEqual(budgets, [1000, 600, 200]);
  assert.equal(outcome.outcome, "failed");
  assert.equal(outcome.failure?.category, "timeout");
});

test("C43 the previous failure is kept per session, and reading one that was never written creates nothing", async () => {
  await inRoot(async (root) => {
    assert.equal(readPreviousFailure(root, "s1"), null);
    assert.equal(existsSync(join(projectStateDir(root), "advisor")), false);
    rememberFailure(root, "s1", "TypeError at a.ts:3");
    assert.equal(readPreviousFailure(root, "s1"), "TypeError at a.ts:3");
    assert.equal(readPreviousFailure(root, "s2"), null);
  });
});

const REJECTED: Array<[string, Partial<Record<keyof JevAdvisorConfig, unknown>>, string]> = [
  ["apply on a use that only records", { shipClaim: "apply" }, "intelligence.jev.shipClaim"],
  ["an unknown lessonRank mode", { lessonRank: "on" }, "intelligence.jev.lessonRank"],
  ["a fractional concurrency", { concurrency: 2.5 }, "intelligence.jev.concurrency"],
  ["a zero timeoutMs", { timeoutMs: 0 }, "intelligence.jev.timeoutMs"],
  ["a model alias that moves", { model: "jev-latest" }, "intelligence.jev.model"],
];

for (const [label, patch, field] of REJECTED) {
  test(`C44 ${label} is rejected with the field named`, () => {
    const errors = advisorConfigErrors(patch as Partial<JevAdvisorConfig>);
    assert.equal(errors.length, 1, errors.join(" · "));
    assert.ok(errors[0]?.includes(field), errors[0]);
  });
}

test("C44 the shipped defaults and a full valid block produce no errors", () => {
  assert.deepEqual(advisorConfigErrors(DEFAULT_JEV_ADVISOR), []);
  assert.deepEqual(advisorConfigErrors({ enabled: true, lessonRank: "apply", stagnation: "record" }), []);
  assert.deepEqual(advisorConfigErrors(undefined), []);
});
