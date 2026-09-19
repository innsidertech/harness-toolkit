import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HARNESS_EVENT_KINDS } from "../../src/contracts/harness-event.ts";
import type { CapabilityCatalog } from "../../src/core/capability/capability.types.ts";
import { SUMMARY_MAX_CHARS } from "../../src/core/capability/capability.types.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function catalog(): CapabilityCatalog {
  return JSON.parse(
    readFileSync(join(repoRoot, "capabilities", "catalog.json"), "utf8"),
  ) as CapabilityCatalog;
}

test("C30 the catalog carries an untrustedContent.judge entry in the required shape", () => {
  const entry = catalog().capabilities.find(
    (capability) => capability.configPath === "untrustedContent.judge.enabled",
  );
  assert.notEqual(entry, undefined);
  if (entry === undefined) {
    return;
  }
  assert.equal(entry.defaultOn, false);
  assert.equal(entry.verdict, "ask");
  // invariant: every event the judge can make a request on — the read-time screen, the command, and the two
  // `scope` opt-ins that ride `tool.before` and `response.after`.
  assert.deepEqual(entry.fires, ["tool.after", "shell.before", "tool.before", "response.after"]);
  for (const fires of entry.fires) {
    assert.ok(HARNESS_EVENT_KINDS.includes(fires), fires);
  }
  assert.ok(entry.summary.length <= SUMMARY_MAX_CHARS, `summary is ${entry.summary.length} characters`);
  assert.ok(entry.inspect.length > 0);
  assert.equal(entry.sinceCatalogVersion, catalog().catalogVersion);
});

test("C30 its tradeOff names all four costs", () => {
  const entry = catalog().capabilities.find(
    (capability) => capability.configPath === "untrustedContent.judge.enabled",
  );
  const tradeOff = entry?.tradeOff ?? "";
  // invariant: one assertion per cost. A single regex over the whole sentence has no empty cell, so a cost could
  // go missing while the test still passed.
  assert.match(tradeOff, /network call/i);
  assert.match(tradeOff, /leave your machine|leaves the machine/i);
  assert.match(tradeOff, /United States/);
  assert.match(tradeOff, /costs money|per check/i);
  assert.match(tradeOff, /latency/i);
});

test("C30 the two Jev capabilities are the only additions to the catalog version they declare", () => {
  const { capabilities, catalogVersion } = catalog();
  const added = capabilities.filter((capability) => capability.sinceCatalogVersion === catalogVersion);
  assert.deepEqual(
    added.map((capability) => capability.id),
    ["untrustedContentJudge", "jevAdvisors"],
  );
});

test("C31 ad-146 exists, is indexed, and carries the required decision headings", () => {
  const path = join(repoRoot, "docs", "decisions", "ad-146.md");
  assert.equal(existsSync(path), true);
  const body = readFileSync(path, "utf8");
  for (const heading of ["## Decision", "## Trade-offs", "## Not decided here"]) {
    assert.ok(body.includes(heading), heading);
  }
  assert.match(body, /^## Why/m);
  assert.match(body, /^- \*\*status\*\*: active$/m);

  const index = readFileSync(join(repoRoot, "docs", "decisions", "index.md"), "utf8");
  assert.match(index, /\[AD-146\]\(\/decisions\/ad-146\.md\)/);
});

test("C31 the generated changelog and log carry the record", () => {
  assert.match(readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8"), /AD-146/);
  assert.match(readFileSync(join(repoRoot, "docs", "log.md"), "utf8"), /AD-146/);
});
