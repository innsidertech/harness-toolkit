import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { projectConfigPath, projectStateDir } from "../../src/platform/paths.ts";
import { checkJudge, JUDGE_DEGRADED_SHARE, JUDGE_DEGRADED_WINDOW } from "../doctor.ts";

let runtimeSandbox: string;
let previousHome: string | undefined;
let previousKey: string | undefined;

before(() => {
  runtimeSandbox = mkdtempSync(join(tmpdir(), "tlc-doctor-judge-home-"));
  previousHome = process.env.TLC_HOME;
  previousKey = process.env.TYPESAFE_API_KEY;
  process.env.TLC_HOME = runtimeSandbox;
  delete process.env.TYPESAFE_API_KEY;
});

after(() => {
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

function project(untrusted: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "tlc-doctor-judge-"));
  mkdirSync(join(root, ".tlc", "harness"), { recursive: true });
  writeFileSync(projectConfigPath(root), JSON.stringify({ version: 1, untrustedContent: untrusted }));
  return root;
}

function withKey<T>(run: () => T): T {
  process.env.TYPESAFE_API_KEY = "a-key-for-this-test";
  try {
    return run();
  } finally {
    delete process.env.TYPESAFE_API_KEY;
  }
}

function recordRuns(root: string, outcomes: string[]): void {
  const dir = projectStateDir(root);
  mkdirSync(dir, { recursive: true });
  const lines = outcomes.map((outcome) =>
    JSON.stringify({
      schema: "harness.observability.v1",
      provider: "claude",
      kind: "policy.observe",
      level: "signal",
      ts: new Date().toISOString(),
      trace_id: "t",
      span_id: "s",
      attrs: { rail: "untrusted-judge", outcome },
    }),
  );
  appendFileSync(join(dir, "obs.jsonl"), `${lines.join("\n")}\n`);
}

test("C27 a judge switched off is silent", () => {
  const root = project({ enabled: true, mode: "enforce" });
  try {
    assert.deepEqual(checkJudge(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("C27 enabled under frame mode is named as enabled and inert, with the reason", () => {
  const root = project({ enabled: true, mode: "frame", judge: { enabled: true } });
  try {
    const checks = withKey(() => checkJudge(root));
    const inert = checks.find((check) => check.name === "untrusted-content judge");
    assert.equal(inert?.level, "fail");
    assert.match(inert?.detail ?? "", /enabled and inert/);
    assert.match(inert?.detail ?? "", /mode is `frame`/);
    assert.match(inert?.detail ?? "", /enforce/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("C27 enabled with no key in either source is named, and told where to put one", () => {
  const root = project({ enabled: true, mode: "enforce", judge: { enabled: true } });
  try {
    const checks = checkJudge(root);
    const key = checks.find((check) => check.name === "untrusted-content judge key");
    assert.equal(key?.level, "fail");
    assert.match(key?.detail ?? "", /enabled and inert/);
    assert.match(key?.detail ?? "", /TYPESAFE_API_KEY/);
    assert.match(key?.detail ?? "", /credentials\.json/);
    assert.match(key?.detail ?? "", /typesafeApiKey/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("C27 both conditions at once are named separately", () => {
  const root = project({ enabled: true, mode: "frame", judge: { enabled: true } });
  try {
    const names = checkJudge(root).map((check) => check.name);
    assert.deepEqual(names, ["untrusted-content judge", "untrusted-content judge key"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("C27 a judge field that cannot be read is a failure naming the field, and the judge is off", () => {
  const root = project({ enabled: true, mode: "enforce", judge: { enabled: true, timeoutMs: -5 } });
  try {
    const checks = withKey(() => checkJudge(root));
    assert.equal(checks.length, 1);
    assert.equal(checks[0]?.level, "fail");
    assert.match(checks[0]?.detail ?? "", /untrustedContent\.judge\.timeoutMs/);
    assert.match(checks[0]?.detail ?? "", /off until this is fixed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("C28 more than the configured share of recent runs failing reports the judge as degraded, with the share", () => {
  const root = project({ enabled: true, mode: "enforce", judge: { enabled: true } });
  try {
    // why: four failures in ten is above the 30% share, and each category is one the client can really return —
    // a fixture outside that set would prove the arithmetic and not the check.
    recordRuns(root, [
      "error:timeout",
      "error:timeout",
      "error:network",
      "error:invalid-response",
      "abstain",
      "abstain",
      "abstain",
      "abstain",
      "ask",
      "abstain",
    ]);
    const checks = withKey(() => checkJudge(root));
    const health = checks.find((check) => check.name === "untrusted-content judge health");
    assert.equal(health?.level, "warn");
    assert.match(health?.detail ?? "", /degraded/);
    assert.match(health?.detail ?? "", /4 of the last 10 runs/);
    assert.match(health?.detail ?? "", /40%/);
    assert.match(health?.detail ?? "", /30%/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("C28 a healthy judge reports one ok row and asks for nothing", () => {
  const root = project({ enabled: true, mode: "enforce", judge: { enabled: true } });
  try {
    recordRuns(root, ["abstain", "abstain", "ask", "error:timeout"]);
    const checks = withKey(() => checkJudge(root));
    assert.equal(checks.length, 1);
    assert.equal(checks[0]?.level, "ok");
    assert.match(checks[0]?.detail ?? "", /record mode, model jev-1\.13\.0/);
    assert.match(checks[0]?.detail ?? "", /4 recent runs, 1 failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("C28 the window and the share are the stated numbers", () => {
  assert.equal(JUDGE_DEGRADED_WINDOW, 50);
  assert.equal(JUDGE_DEGRADED_SHARE, 0.3);
});
