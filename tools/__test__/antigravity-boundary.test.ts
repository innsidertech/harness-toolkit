import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeSeparators } from "../../src/platform/sanitize.ts";
import { ANTIGRAVITY_EVENT_PREFIX } from "../../src/providers/antigravity/antigravity.events.ts";
import { ANTIGRAVITY_TOOLS } from "../../src/providers/antigravity/antigravity.tools.ts";
import { DEFAULT_CONFIG, runBoundaryChecks } from "../dev/check-boundaries.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const NEUTRAL_DIRS = ["src/core", "src/contracts"];
const BASE = "09972f0";

/** The host's wiring vocabulary: what must reach the neutral layers only through the port. */
const HOST_TOKENS = ["PreToolUse", "PostToolUse", ANTIGRAVITY_EVENT_PREFIX, ".agents", "hooks.json"];

/**
 * invariant: lines that already held one of these tokens at the base commit. They name another host's file shape
 * in a floor test and predate this provider; anything else is new.
 */
const PRE_EXISTING = new Set([
  'src/core/floor/__test__/floor.paths.test.ts:  assert.equal(isProtectedWiringTarget(join(dirTarget, "hooks.json"), [dirTarget]), true);',
  'src/core/floor/__test__/floor.paths.test.ts:  assert.equal(isPolicySurface(PROJECT, "/home/someone/.editor-z/hooks.json", [WIRING_TARGET]), false);',
]);

function filesUnder(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : full.endsWith(".ts") ? [full] : [];
  });
}

function neutralLines(): { where: string; text: string }[] {
  return NEUTRAL_DIRS.flatMap((dir) =>
    filesUnder(join(repoRoot, dir)).flatMap((file) => {
      const rel = normalizeSeparators(relative(repoRoot, file));
      return readFileSync(file, "utf8")
        .split(/\r?\n/)
        .map((text) => ({ where: rel, text }));
    }),
  );
}

/**
 * why `Stop-Computer` is removed first: it is a PowerShell verb the floor denies on every provider, not this host's
 * `Stop` event, and `\bStop\b` would count it ([/decisions/ad-157.md](/decisions/ad-157.md)).
 */
function addedHostHits(lines: readonly string[]): string[] {
  return lines.filter((line) => {
    const verbless = line.replace(/`/g, "").replace(/Stop-Computer/gi, "");
    return HOST_TOKENS.some((token) => line.includes(token)) || /\bStop\b/.test(verbless);
  });
}

describe("AGH-29 and AGH-80: the neutral layers stay free of this host", () => {
  test("AGH-29: no native tool name appears in src/core or src/contracts", () => {
    const natives = ANTIGRAVITY_TOOLS.map((tool) => tool.native);
    assert.equal(natives.length, 6);
    const hits = neutralLines().filter(({ text }) => natives.some((name) => text.includes(name)));
    assert.deepEqual(hits, []);
  });

  test("AGH-29: check-boundaries reports nothing on the real tree", () => {
    assert.deepEqual(runBoundaryChecks({ root: repoRoot, ...DEFAULT_CONFIG }), []);
  });

  test("AGH-80: no line outside the base's own carries the host's wiring vocabulary or its Stop", () => {
    const hits = neutralLines().filter(
      ({ where, text }) =>
        (HOST_TOKENS.some((token) => text.includes(token)) || /["'`]Stop["'`]/.test(text)) &&
        !PRE_EXISTING.has(`${where}:${text}`),
    );
    assert.deepEqual(hits, []);
  });

  const base = spawnSync("git", ["cat-file", "-e", `${BASE}^{commit}`], { cwd: repoRoot });
  const skip = base.status === 0 ? false : `${BASE} is not in this clone's history`;

  test("AGH-80: the diff matcher counts the host's Stop and not the PowerShell verb Stop-Computer", () => {
    assert.deepEqual(
      addedHostHits([
        '+  denies: "`Stop-Computer`, `Restart-Computer`",',
        '+  assertDenied("Stop-computer", rule);',
        '+  assertDenied("Stop-Comp`uter", rule);',
      ]),
      [],
    );
    for (const line of [
      '+  event: "Stop",',
      "+  // on Stop the host",
      "+  Stop-Process -Name x",
      "+  hooks.json",
    ]) {
      assert.deepEqual(addedHostHits([line]), [line], line);
    }
  });

  test("AGH-80: the diff against the base adds none of those tokens to src/core or src/contracts", {
    skip,
  }, () => {
    const diff = spawnSync("git", ["diff", "--unified=0", BASE, "--", ...NEUTRAL_DIRS], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(diff.status, 0, diff.stderr);
    const added = diff.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"));
    assert.deepEqual(addedHostHits(added), []);
  });
});
