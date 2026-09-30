import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  antigravityWiring,
  mergeAntigravityGroup,
} from "../../src/providers/antigravity/antigravity.wiring.ts";
import {
  applyUninstall,
  planUninstall,
  type UninstallTargets,
  uninstallReportText,
  uninstallTargets,
} from "../uninstall-runtime.ts";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

/** Only the antigravity file exists; no links, so this runs where symlinks need a privilege. */
function machine(existing: string | null): { targets: UninstallTargets; hooks: string } {
  const root = mkdtempSync(join(tmpdir(), "uninstall-agy-"));
  roots.push(root);
  const hooks = join(root, "gemini", "config", "hooks.json");
  if (existing !== null) {
    mkdirSync(join(root, "gemini", "config"), { recursive: true });
    writeFileSync(hooks, existing);
  }
  return {
    hooks,
    targets: {
      home: join(root, "no-runtime"),
      binLinks: [],
      claudeSettings: join(root, "claude", "settings.json"),
      cursorHooks: join(root, "cursor", "hooks.json"),
      antigravityHooks: hooks,
      skillLinks: [],
    },
  };
}

function wired(others: Record<string, unknown>): string {
  const entries = antigravityWiring({ launcherPath: "/opt/tlc/bin/tlc-exec.mjs" }).entries;
  const merged = mergeAntigravityGroup(JSON.stringify(others), entries);
  assert.ok(merged.ok);
  return merged.text;
}

describe("uninstall and the antigravity group", () => {
  test("the target list names the global hooks file", () => {
    assert.ok(uninstallTargets().antigravityHooks?.endsWith(join(".gemini", "config", "hooks.json")));
  });

  test("AGH-39: without --yes the removal is listed and the file stays byte-identical", () => {
    const text = wired({ mine: { Stop: [] } });
    const { targets, hooks } = machine(text);
    const plan = planUninstall(targets);
    const item = plan.items.find((candidate) => candidate.target === hooks);
    assert.equal(item?.action, "unmerge");
    assert.match(uninstallReportText(plan, null), /tlc-harness/);
    assert.ok(uninstallReportText(plan, null).includes(hooks));
    assert.equal(readFileSync(hooks, "utf8"), text);
  });

  test("AGH-40: --yes drops only the group and keeps every other key, value and order", () => {
    const others = { zeta: { PreToolUse: [{ matcher: "a" }] }, alpha: [1, { b: 2 }] };
    const { targets, hooks } = machine(wired(others));
    const result = applyUninstall(planUninstall(targets), targets);
    assert.deepEqual(result.failed, []);
    const after = JSON.parse(readFileSync(hooks, "utf8"));
    assert.deepEqual(Object.keys(after), ["zeta", "alpha"]);
    assert.deepEqual(after, others);
  });

  test("AGH-40: --yes deletes the file when the group was its only key", () => {
    const { targets, hooks } = machine(wired({}));
    const result = applyUninstall(planUninstall(targets), targets);
    assert.deepEqual(result.failed, []);
    assert.equal(existsSync(hooks), false);
  });

  test("AGH-40: an absent file is nothing to do and no error", () => {
    const { targets, hooks } = machine(null);
    const plan = planUninstall(targets);
    assert.equal(
      plan.items.some((item) => item.target === hooks),
      false,
    );
    assert.deepEqual(applyUninstall(plan, targets).failed, []);
  });

  test("AGH-40: a second --yes finds nothing left to remove", () => {
    const { targets, hooks } = machine(wired({ mine: true }));
    applyUninstall(planUninstall(targets), targets);
    const second = planUninstall(targets);
    assert.equal(
      second.items.some((item) => item.target === hooks),
      false,
    );
  });

  test("a file without the group, or one that does not parse, is never rewritten", () => {
    for (const body of ['{"mine":true}', "{ not json"]) {
      const { targets, hooks } = machine(body);
      applyUninstall(planUninstall(targets), targets);
      assert.equal(readFileSync(hooks, "utf8"), body, body);
    }
  });
});
