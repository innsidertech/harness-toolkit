import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { providerPresencePath } from "../../bin/write-user-hooks.mjs";
import {
  ANTIGRAVITY_GROUP_NAME,
  antigravityWiring,
} from "../../src/providers/antigravity/antigravity.wiring.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = join(repoRoot, "bin", "write-user-hooks.mjs");

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

type Sandbox = { home: string; workspace: string; target: string; cliDir: string; runtime: string };

/** A throwaway home, workspace and runtime path; nothing here reaches the operator's real home. */
function sandbox({ hostPresent }: { hostPresent: boolean }): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "wuh-agy-"));
  roots.push(root);
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const cliDir = join(home, ".gemini", "antigravity-cli");
  if (hostPresent) {
    mkdirSync(cliDir, { recursive: true });
  }
  return {
    home,
    workspace,
    target: join(home, ".gemini", "config", "hooks.json"),
    cliDir,
    runtime: join(root, "runtime"),
  };
}

function install(box: Sandbox, runtime = box.runtime) {
  const result = spawnSync(process.execPath, [script], {
    cwd: box.workspace,
    encoding: "utf8",
    env: { ...process.env, HOME: box.home, USERPROFILE: box.home, TLC_HOME: runtime },
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

function groupCommands(text: string): string[] {
  const group = JSON.parse(text)[ANTIGRAVITY_GROUP_NAME];
  return [group.PreToolUse[0].hooks[0].command, group.PostToolUse[0].hooks[0].command, group.Stop[0].command];
}

const WARNING = "unverified surfaces may deny every tool";
const LAST_RESORT =
  "last resort: tlc harness uninstall --yes also removes the Claude and Cursor harness hooks, the harness-init skill links, tlc from PATH and ~/.tlc/harness";

function assertNoticeInOrder(stdout: string, target: string): void {
  const lines = stdout.split(/\r?\n/);
  const warning = lines.findIndex((line) => line.includes(WARNING));
  const recovery = lines.findIndex((line) =>
    line.includes(`recovery: remove only the "tlc-harness" key from ${target}`),
  );
  const lastResort = lines.findIndex((line) => line.includes(LAST_RESORT));
  assert.ok(warning >= 0 && recovery > warning && lastResort > recovery, stdout);
  assert.equal(stdout.includes("recovery: tlc harness uninstall --yes"), false);
}

describe("install wiring for antigravity", () => {
  test("presence is the CLI directory, not the shared config directory", () => {
    const wiring = antigravityWiring({ launcherPath: "/x/tlc-exec.mjs" });
    assert.equal(providerPresencePath(wiring), wiring.presencePath);
    assert.notEqual(providerPresencePath(wiring), dirname(wiring.target));
  });

  test("AGH-32 and AGH-85: a fresh home gets a file holding only the group, then the three notice lines", () => {
    const box = sandbox({ hostPresent: true });
    const result = install(box);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`hooks: merged ${box.target}`), result.stdout);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(box.target, "utf8"))), [ANTIGRAVITY_GROUP_NAME]);
    assertNoticeInOrder(result.stdout, box.target);
  });

  test("AGH-33: other root keys keep their value and their order", () => {
    const box = sandbox({ hostPresent: true });
    mkdirSync(dirname(box.target), { recursive: true });
    const theirs = { alpha: { PreToolUse: [{ matcher: "x" }] }, omega: [1, 2, 3] };
    writeFileSync(box.target, JSON.stringify(theirs, null, 2));
    assert.equal(install(box).status, 0);
    const after = JSON.parse(readFileSync(box.target, "utf8"));
    assert.deepEqual(Object.keys(after), ["alpha", "omega", ANTIGRAVITY_GROUP_NAME]);
    assert.deepEqual(after.alpha, theirs.alpha);
    assert.deepEqual(after.omega, theirs.omega);
  });

  test("AGH-34 and AGH-85: a second install leaves the file byte-identical and still prints the notice", () => {
    const box = sandbox({ hostPresent: true });
    install(box);
    const before = readFileSync(box.target, "utf8");
    const result = install(box);
    assert.equal(result.status, 0);
    assert.equal(readFileSync(box.target, "utf8"), before);
    assert.ok(result.stdout.includes(`hooks: unchanged (${box.target})`), result.stdout);
    assertNoticeInOrder(result.stdout, box.target);
  });

  test("AGH-35: another launcher path replaces the group in place, with no copy of the old one", () => {
    const box = sandbox({ hostPresent: true });
    install(box);
    const moved = `${box.runtime}-moved`;
    assert.equal(install(box, moved).status, 0);
    const text = readFileSync(box.target, "utf8");
    assert.equal(text.split(`"${ANTIGRAVITY_GROUP_NAME}"`).length - 1, 1);
    for (const command of groupCommands(text)) {
      assert.ok(command.includes(join(moved, "bin", "tlc-exec.mjs")), command);
    }
  });

  test("AGH-36: a file that is not a JSON object is left byte-identical and the install exits 1", () => {
    for (const body of ["{ not json", "[1, 2]"]) {
      const box = sandbox({ hostPresent: true });
      mkdirSync(dirname(box.target), { recursive: true });
      writeFileSync(box.target, body);
      const result = install(box);
      assert.equal(result.status, 1, body);
      assert.equal(readFileSync(box.target, "utf8"), body);
      assert.ok(result.stderr.includes(`hooks: failed to update ${box.target}: `), result.stderr);
      assert.equal(result.stdout.includes(WARNING), false);
    }
  });

  test("AGH-37: a launcher path with a space is refused on stderr, nothing is written and the install exits 1", () => {
    const box = sandbox({ hostPresent: true });
    const spaced = join(dirname(box.runtime), "run time");
    const result = install(box, spaced);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes("launcher path contains a space"), result.stderr);
    assert.ok(result.stderr.includes(join(spaced, "bin", "tlc-exec.mjs")), result.stderr);
    assert.equal(existsSync(box.target), false);
  });

  test("AGF-27: the space refusal prints the whole measured reason and exits 1", () => {
    const box = sandbox({ hostPresent: true });
    const spaced = join(dirname(box.runtime), "run time");
    const result = install(box, spaced);
    assert.equal(result.status, 1);
    const reason = `launcher path contains a space — not wiring antigravity: ${join(spaced, "bin", "tlc-exec.mjs")}. Quoting does not help on agy 1.2.14: the host splits the hook command on spaces, a quote stays a literal character in the argument, and the hook runs with its working directory set to the hooks.json directory.`;
    assert.ok(result.stderr.includes(reason), result.stderr);
  });

  test("AGH-38: without the CLI directory the install skips and creates nothing", () => {
    const box = sandbox({ hostPresent: false });
    const result = install(box);
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes("hooks: antigravity not installed — skipping"), result.stdout);
    assert.equal(existsSync(box.target), false);
    assert.equal(existsSync(dirname(box.target)), false);
  });

  test("AGH-41: the install never writes the workspace hooks file nor the CLI settings", () => {
    const box = sandbox({ hostPresent: true });
    install(box);
    assert.equal(existsSync(join(box.workspace, ".agents", "hooks.json")), false);
    assert.equal(existsSync(join(box.workspace, ".agents")), false);
    assert.equal(existsSync(join(box.cliDir, "settings.json")), false);
  });
});
