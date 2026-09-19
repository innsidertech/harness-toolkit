import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { projectConfigPath, projectStateDir } from "../../platform/paths.ts";
import { responseAfterHandler } from "../response-after.ts";
import { runHandler } from "../run.ts";

/**
 * The advisors' boundary is a hook, and the one thing they must never do in a test is reach the network. `fetch` is
 * doubled per test and every test asserts how many calls it received.
 *
 * hazard: handlers read the runtime home's own config, so the home is a directory this file owns for its run.
 */
let runtimeSandbox: string;
let previousHome: string | undefined;
let previousKey: string | undefined;
const realFetch = globalThis.fetch;

before(() => {
  runtimeSandbox = mkdtempSync(join(tmpdir(), "tlc-advisory-home-"));
  previousHome = process.env.TLC_HOME;
  previousKey = process.env.TYPESAFE_API_KEY;
  process.env.TLC_HOME = runtimeSandbox;
  process.env.TYPESAFE_API_KEY = "advisory-test-key";
});

after(() => {
  globalThis.fetch = realFetch;
  if (previousHome === undefined) {
    delete process.env.TLC_HOME;
  } else {
    process.env.TLC_HOME = previousHome;
  }
  if (previousKey === undefined) {
    delete process.env.TYPESAFE_API_KEY;
  } else {
    process.env.TYPESAFE_API_KEY = previousKey;
  }
  rmSync(runtimeSandbox, { recursive: true, force: true });
});

function project(config: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "tlc-advisory-"));
  mkdirSync(join(root, ".tlc", "harness"), { recursive: true });
  writeFileSync(projectConfigPath(root), JSON.stringify({ version: 1, ...config }));
  return root;
}

function response(root: string, text: string) {
  return {
    readStdin: () =>
      Promise.resolve(
        JSON.stringify({
          hook_event_name: "afterAgentResponse",
          workspace_roots: [root],
          conversation_id: "conv-1",
          session_id: "sess-1",
          text,
        }),
      ),
  };
}

function doubleFetch(noul: number): { calls: number; bodies: unknown[] } {
  const counter = { calls: 0, bodies: [] as unknown[] };
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    counter.calls += 1;
    counter.bodies.push(JSON.parse(String(init.body)));
    return new Response(
      JSON.stringify({
        model: "jev-1.13.0",
        answers: { answer: { type: "noul", noul } },
        usage: { input_tokens: 90 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
  return counter;
}

function advisorRecords(root: string): Array<Record<string, unknown>> {
  const path = join(projectStateDir(root), "obs.jsonl");
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.includes('"rail":"jev-advisor"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const CLAIM = "All done — the fix is shipped and every test passes.";

test("C47 with the advisors at their defaults a reply makes no request and writes no advisor record", async () => {
  const root = project({});
  const counter = doubleFetch(0.9);
  try {
    await runHandler(responseAfterHandler, response(root, CLAIM));
    assert.equal(counter.calls, 0);
    assert.deepEqual(advisorRecords(root), []);
  } finally {
    globalThis.fetch = realFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("C47 shipClaim in record writes the reading beside what the pattern decided, and never the reply", async () => {
  const root = project({ intelligence: { jev: { enabled: true, shipClaim: "record" } } });
  const counter = doubleFetch(0.91);
  try {
    await runHandler(responseAfterHandler, response(root, CLAIM));
    assert.equal(counter.calls, 1);
    const body = counter.bodies[0] as { state: Record<string, unknown> };
    assert.equal(body.state.agent_response, CLAIM);
    const records = advisorRecords(root);
    assert.equal(records.length, 1);
    const attrs = records[0]?.attrs as Record<string, unknown>;
    assert.equal(attrs.use, "shipClaim");
    assert.equal(attrs.mode, "record");
    assert.deepEqual(attrs.scores, { claim: 0.91 });
    assert.equal(typeof attrs.pattern_claimed, "boolean");
    assert.equal(
      JSON.stringify(records).includes("every test passes"),
      false,
      "the reply reached the record",
    );
  } finally {
    globalThis.fetch = realFetch;
    rmSync(root, { recursive: true, force: true });
  }
});
