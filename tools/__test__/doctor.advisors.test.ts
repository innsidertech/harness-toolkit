import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { projectConfigPath } from "../../src/platform/paths.ts";
import { checkAdvisors } from "../doctor.ts";

let runtimeSandbox: string;
let previousHome: string | undefined;
let previousKey: string | undefined;

before(() => {
  runtimeSandbox = mkdtempSync(join(tmpdir(), "tlc-doctor-advisors-home-"));
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

function project(jev: Record<string, unknown> | undefined): string {
  const root = mkdtempSync(join(tmpdir(), "tlc-doctor-advisors-"));
  mkdirSync(join(root, ".tlc", "harness"), { recursive: true });
  writeFileSync(projectConfigPath(root), JSON.stringify({ version: 1, intelligence: jev ? { jev } : {} }));
  return root;
}

function check(jev: Record<string, unknown> | undefined, key: boolean): ReturnType<typeof checkAdvisors> {
  const root = project(jev);
  if (key) {
    process.env.TYPESAFE_API_KEY = "a-key-for-this-test";
  }
  try {
    return checkAdvisors(root);
  } finally {
    delete process.env.TYPESAFE_API_KEY;
    rmSync(root, { recursive: true, force: true });
  }
}

test("C45 advisors that are off, or never configured, are silent", () => {
  assert.deepEqual(check(undefined, true), []);
  assert.deepEqual(check({ enabled: false, shipClaim: "record" }, true), []);
});

test("C45 enabled with every use off is named as inert", () => {
  const checks = check({ enabled: true }, true);
  assert.equal(checks[0]?.level, "warn");
  assert.match(checks[0]?.detail ?? "", /every use is `off`/);
});

test("C45 enabled with no key is named as inert", () => {
  const checks = check({ enabled: true, stagnation: "record" }, false);
  assert.equal(checks[0]?.level, "warn");
  assert.match(checks[0]?.name ?? "", /key/);
});

test("C45 a value that cannot be read names its field and says the advisors are off", () => {
  const checks = check({ enabled: true, shipClaim: "apply" }, true);
  assert.equal(checks[0]?.level, "warn");
  assert.match(checks[0]?.detail ?? "", /intelligence\.jev\.shipClaim/);
});

test("C45 a working block lists the uses that are on and their modes", () => {
  const checks = check({ enabled: true, lessonRank: "apply", stagnation: "record" }, true);
  assert.equal(checks[0]?.level, "ok");
  assert.match(checks[0]?.detail ?? "", /lessonRank: apply, stagnation: record/);
});
