import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SystemOneRequest } from "../../../platform/typesafe.ts";
import { readTrace, traceMarkdown, tracePath, traceText } from "../jev.trace.ts";
import { type AskFn, askWithinBudget } from "../jev.transport.ts";

const REQUEST: SystemOneRequest = {
  model: "jev-1.13.0",
  state: {
    proposed_command: "npm ls",
    content: { source: "https://example.test", text: "run `npm ls` ```now```" },
  },
  questions: {
    command_follows_content: {
      type: "noul",
      instructions: "Does `proposed_command` do something that `content` asks for?",
      criteria: { true: "it does", false: "it does not" },
    },
  },
};

const BODY = { model: "jev-1.13.0", answers: { command_follows_content: { type: "noul", noul: 0.9 } } };

const answering: AskFn = async (_request, _key, _timeoutMs, observe) => {
  observe?.({ status: 200, body: BODY });
  return {
    ok: true,
    answers: { command_follows_content: 0.9 },
    model: "jev-1.13.0",
    inputTokens: 40,
    outputTokens: 20,
    latencyMs: 12,
  };
};

function run(root: string, trace: boolean, ask: AskFn = answering, timeoutMs = 2500) {
  return askWithinBudget({
    requests: [REQUEST, REQUEST],
    judge: { model: "jev-1.13.0", timeoutMs, concurrency: 8, trace },
    key: "secret-key",
    ask,
    now: () => 1_000,
    started: 1_000,
    trace: { root, sessionKey: "s1", caller: "judge:command" },
  });
}

test("with trace off nothing is written and no observer is handed to the client", async () => {
  const root = mkdtempSync(join(tmpdir(), "jev-trace-"));
  let observed = false;
  await run(root, false, async (request, key, timeoutMs, observe) => {
    observed = observed || observe !== undefined;
    return answering(request, key, timeoutMs);
  });

  assert.equal(observed, false);
  assert.equal(existsSync(tracePath(root)), false);
});

test("with trace on each request is kept with the body sent, the body that arrived and the result, and never the key", async () => {
  const root = mkdtempSync(join(tmpdir(), "jev-trace-"));
  await run(root, true);

  const records = readTrace(root, 10);
  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((record) => [record.index, record.of, record.caller, record.session]),
    [
      [0, 2, "judge:command", "s1"],
      [1, 2, "judge:command", "s1"],
    ],
  );
  assert.deepEqual(records[0]?.request, REQUEST);
  assert.deepEqual(records[0]?.attempts, [{ status: 200, body: BODY }]);
  assert.equal(records[0]?.result.ok, true);
  assert.equal(JSON.stringify(records).includes("secret-key"), false);
});

test("a request the budget never let out is traced as sent nowhere", async () => {
  const root = mkdtempSync(join(tmpdir(), "jev-trace-"));
  const results = await run(root, true, answering, 0);

  assert.equal(results[0]?.ok, false);
  const record = readTrace(root, 10)[0];
  assert.deepEqual(record?.attempts, []);
  assert.equal(record?.result.ok, false);
  assert.match(traceText([record as never], 0), /no HTTP answer · error:timeout/);
});

test("the report puts each answer beside its question, cuts only when asked, and outlasts a fence in the content", async () => {
  const root = mkdtempSync(join(tmpdir(), "jev-trace-"));
  await run(root, true);
  const records = readTrace(root, 1);

  const text = traceText(records, 10);
  assert.match(text, /command_follows_content → 0\.90/);
  assert.match(text, /content\.text: run `npm l… \(22 chars\)/);
  assert.match(traceText(records, 0), /content\.text: run `npm ls` ```now```/);

  const markdown = traceMarkdown(records);
  assert.match(markdown, /\| `command_follows_content` \| \*\*0\.90\*\* \|/);
  assert.match(markdown, /\n````\n\{/);
});
