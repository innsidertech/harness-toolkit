import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";
import type { RuntimePaths } from "../../src/contracts/index.ts";
import {
  ANTIGRAVITY_GROUP_NAME,
  antigravityWiring,
  mergeAntigravityGroup,
} from "../../src/providers/antigravity/antigravity.wiring.ts";
import type { ProviderPort } from "../../src/providers/provider.port.ts";
import { type Check, checkProviders, checkSkillLinks, formatReport } from "../doctor.ts";
import { withEnv } from "../test-env.scope.mjs";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

type Machine = { runtime: string; target: string; presence: string; provider: ProviderPort };

/** The real antigravity wiring, pointed at a throwaway home instead of the operator's. */
function machine({ hostPresent = true, launcherExists = true } = {}): Machine {
  const root = mkdtempSync(join(tmpdir(), "doctor-agy-"));
  roots.push(root);
  const runtime = join(root, "runtime");
  const target = join(root, "home", ".gemini", "config", "hooks.json");
  const presence = join(root, "home", ".gemini", "antigravity-cli");
  if (hostPresent) {
    mkdirSync(presence, { recursive: true });
  }
  if (launcherExists) {
    mkdirSync(join(runtime, "bin"), { recursive: true });
    writeFileSync(join(runtime, "bin", "tlc-exec.mjs"), "");
  }
  const provider = {
    name: "antigravity",
    wiring: (paths: RuntimePaths) => ({ ...antigravityWiring(paths), target, presencePath: presence }),
  } as unknown as ProviderPort;
  return { runtime, target, presence, provider };
}

function writeHooks(box: Machine, document: Record<string, unknown> | string): void {
  mkdirSync(dirname(box.target), { recursive: true });
  writeFileSync(box.target, typeof document === "string" ? document : JSON.stringify(document));
}

function installedGroup(box: Machine): Record<string, unknown> {
  const entries = antigravityWiring({ launcherPath: join(box.runtime, "bin", "tlc-exec.mjs") }).entries;
  const merged = mergeAntigravityGroup(null, entries);
  assert.ok(merged.ok);
  return JSON.parse(merged.text)[ANTIGRAVITY_GROUP_NAME];
}

function rowsOf(box: Machine): Check[] {
  return checkProviders([box.provider], box.runtime);
}

function row(checks: readonly Check[], name: string): Check | undefined {
  return checks.find((check) => check.name === name);
}

const RECOVERY_ROWS = ["antigravity risk", "antigravity recovery", "antigravity last resort"];

describe("doctor and the antigravity group", () => {
  test("AGH-64: the exact group reports wired and then the three recovery lines, in order", () => {
    const box = machine();
    writeHooks(box, { mine: {}, [ANTIGRAVITY_GROUP_NAME]: installedGroup(box) });
    const checks = rowsOf(box);
    const wiring = row(checks, "antigravity wiring");
    assert.equal(wiring?.level, "ok");
    assert.equal(wiring?.detail, `wired (${box.target})`);
    assert.deepEqual(
      checks.map((check) => check.name).filter((name) => RECOVERY_ROWS.includes(name)),
      RECOVERY_ROWS,
    );
    const text = formatReport(checks);
    const warning = text.indexOf("unverified surfaces may deny every tool");
    const recovery = text.indexOf(`recovery: remove only the "tlc-harness" key from ${box.target}`);
    const lastResort = text.indexOf(
      "last resort: tlc harness uninstall --yes also removes the Claude and Cursor harness hooks, the harness-init skill links, tlc from PATH and ~/.tlc/harness",
    );
    assert.ok(warning >= 0 && recovery > warning && lastResort > recovery, text);
    assert.equal(text.includes("recovery: tlc harness uninstall --yes"), false);
  });

  test("AGH-65: every broken shape warns with the reason and the update command, and prints no recovery", () => {
    const shapes: [string, (box: Machine) => void, RegExp][] = [
      ["no file", () => {}, /no hooks file/],
      ["no group", (box) => writeHooks(box, { mine: {} }), /no harness group/],
      [
        "disabled",
        (box) => writeHooks(box, { [ANTIGRAVITY_GROUP_NAME]: { ...installedGroup(box), enabled: false } }),
        /enabled: false/,
      ],
      [
        "missing Stop",
        (box) => {
          const { Stop: _dropped, ...rest } = installedGroup(box) as Record<string, unknown>;
          writeHooks(box, { [ANTIGRAVITY_GROUP_NAME]: rest });
        },
        /Stop/,
      ],
      [
        "bare token",
        (box) =>
          writeHooks(
            box,
            JSON.stringify({ [ANTIGRAVITY_GROUP_NAME]: installedGroup(box) }).replaceAll("antigravity:", ""),
          ),
        /command lacks antigravity:/,
      ],
    ];
    for (const [label, arrange, reason] of shapes) {
      const box = machine();
      arrange(box);
      const checks = rowsOf(box);
      const wiring = row(checks, "antigravity wiring");
      assert.equal(wiring?.level, "warn", label);
      assert.match(wiring?.detail ?? "", /detected but not wired/, label);
      assert.match(wiring?.detail ?? "", reason, label);
      assert.match(wiring?.detail ?? "", /run: tlc harness update/, label);
      assert.equal(
        checks.some((check) => RECOVERY_ROWS.includes(check.name)),
        false,
        label,
      );
    }
  });

  test("AGH-65: a group pointing at a launcher that does not exist is not wired", () => {
    const box = machine({ launcherExists: false });
    writeHooks(box, { [ANTIGRAVITY_GROUP_NAME]: installedGroup(box) });
    const wiring = row(rowsOf(box), "antigravity wiring");
    assert.equal(wiring?.level, "warn");
    assert.match(wiring?.detail ?? "", /the script does not exist/);
  });

  test("AGH-66: without the CLI directory the host is not installed, at level ok", () => {
    const box = machine({ hostPresent: false });
    writeHooks(box, { [ANTIGRAVITY_GROUP_NAME]: installedGroup(box) });
    const checks = rowsOf(box);
    const wiring = row(checks, "antigravity wiring");
    assert.equal(wiring?.level, "ok");
    assert.equal(wiring?.detail, "not installed");
    assert.equal(
      checks.some((check) => RECOVERY_ROWS.includes(check.name)),
      false,
    );
  });

  test("AGH-67: the surface claim is printed in every state", () => {
    for (const hostPresent of [true, false]) {
      const text = formatReport(rowsOf(machine({ hostPresent })));
      for (const token of ["CLI", "floor enforced", "IDE 2.0.2", "app 2.18.1", "unverified"]) {
        assert.ok(text.includes(token), `${token} (host present: ${hostPresent})`);
      }
    }
  });
});

describe("doctor and the antigravity init skill link", () => {
  const LINE = "init skill (antigravity-cli)";

  /** A throwaway home holding only the Antigravity CLI directory, and a runtime with the skill. */
  function skillMachine({ hostPresent = true } = {}) {
    const root = mkdtempSync(join(tmpdir(), "doctor-agy-skill-"));
    roots.push(root);
    const home = join(root, "home");
    const runtime = join(root, "runtime");
    const cliDir = join(home, ".gemini", "antigravity-cli");
    mkdirSync(join(runtime, "skills", "harness-init"), { recursive: true });
    if (hostPresent) {
      mkdirSync(join(cliDir, "skills"), { recursive: true });
    }
    return { root, home, runtime, link: join(cliDir, "skills", "harness-init") };
  }

  function skillRow(box: { home: string; runtime: string }): Check | undefined {
    const checks = withEnv(
      { HOME: box.home, USERPROFILE: box.home, CLAUDE_CONFIG_DIR: undefined, CURSOR_CONFIG_DIR: undefined },
      () => checkSkillLinks(box.runtime),
    );
    return row(checks, LINE);
  }

  test("AGF-59: a healthy link is ok, with the linkHealthMessage text", () => {
    const box = skillMachine();
    symlinkSync(join(box.runtime, "skills", "harness-init"), box.link, "junction");
    const line = skillRow(box);
    assert.equal(line?.level, "ok");
    assert.equal(line?.detail, `linked → ${realpathSync(join(box.runtime, "skills", "harness-init"))}`);
  });

  test("AGF-59: an absent link fails", () => {
    const box = skillMachine();
    const line = skillRow(box);
    assert.equal(line?.level, "fail");
    assert.equal(line?.detail, "not linked — the provider cannot see the init skill");
  });

  test("AGF-59: a dangling link fails", () => {
    const box = skillMachine();
    const gone = join(box.root, "gone");
    mkdirSync(gone);
    symlinkSync(gone, box.link, "junction");
    rmSync(gone, { recursive: true });
    const line = skillRow(box);
    assert.equal(line?.level, "fail");
    assert.match(line?.detail ?? "", /^points at .*, which does not exist — re-run `tlc harness install`$/);
  });

  test("AGF-59: a link outside the runtime fails", () => {
    const box = skillMachine();
    const elsewhere = join(box.root, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, box.link, "junction");
    const line = skillRow(box);
    assert.equal(line?.level, "fail");
    assert.equal(
      line?.detail,
      `points at ${realpathSync(elsewhere)}, outside the runtime — it will break when that path goes`,
    );
  });

  test("AGF-59: without the CLI directory the line is not printed", () => {
    assert.equal(skillRow(skillMachine({ hostPresent: false })), undefined);
  });
});
