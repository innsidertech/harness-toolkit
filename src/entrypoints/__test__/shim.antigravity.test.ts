import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const SHIM = join(dirname(fileURLToPath(import.meta.url)), "..", "shim.ts");
const LAUNCHER = "/opt/tlc/bin/tlc-exec.mjs";

/** The group exactly as the install writes it: a named root key, no `hooks` key. */
const ANTIGRAVITY_DOCUMENT = {
  "tlc-harness": {
    PreToolUse: [
      {
        matcher: ".*",
        hooks: [
          { type: "command", command: `node ${LAUNCHER} tool-before antigravity:PreToolUse`, timeout: 10 },
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: ".*",
        hooks: [
          { type: "command", command: `node ${LAUNCHER} tool-after antigravity:PostToolUse`, timeout: 10 },
        ],
      },
    ],
    Stop: [{ type: "command", command: `node ${LAUNCHER} stop antigravity:Stop`, timeout: 120 }],
  },
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

/** A fake home and an empty runtime; the config-dir variables are dropped so both hosts resolve under the home. */
function fakeHome(): { home: string; runtime: string } {
  const root = mkdtempSync(join(tmpdir(), "shim-agy-"));
  roots.push(root);
  const home = join(root, "home");
  const runtime = join(root, "runtime");
  mkdirSync(home, { recursive: true });
  mkdirSync(runtime, { recursive: true });
  writeJson(join(home, ".gemini", "config", "hooks.json"), ANTIGRAVITY_DOCUMENT);
  return { home, runtime };
}

function runShim(home: string, runtime: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, TLC_HOME: runtime };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CURSOR_CONFIG_DIR;
  const result = spawnSync(process.execPath, [SHIM, "tool-before"], { input: "{}", env, encoding: "utf8" });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

test("AGF-56: with only the Antigravity group on disk the project shim runs the handler", () => {
  const { home, runtime } = fakeHome();
  const result = runShim(home, runtime);
  assert.equal(result.status, 0);
  assert.ok(result.stderr.includes("tlc shim: handler not found: tool-before"), result.stderr);
});

test("AGF-56: the Antigravity group never overrides a covering Cursor document, so the shim stands down", () => {
  const { home, runtime } = fakeHome();
  writeJson(join(home, ".cursor", "hooks.json"), {
    hooks: { preToolUse: [{ hooks: [{ command: "node", args: [LAUNCHER, "tool-before"] }] }] },
  });
  const result = runShim(home, runtime);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "{}");
  assert.equal(result.stderr, "");
});
