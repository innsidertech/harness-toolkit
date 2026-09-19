import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { projectStateDir } from "../../src/platform/paths.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OBS_CLI = join(repoRoot, "tools", "obs-cli.ts");

/**
 * `tlc harness obs report` is a process that reads a rollup and writes a markdown artifact, so the proof that the
 * judge reaches an operator runs the command rather than the function behind it.
 *
 * why a subprocess: the command calls `process.exit`, which cannot be driven in-process without swallowing the one
 * thing under test — that it exits 0 and leaves the artifact behind.
 */
const roots: string[] = [];

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function projectWithRollup(judge: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "tlc-obs-report-judge-"));
  roots.push(root);
  const stateDir = projectStateDir(root);
  mkdirSync(join(stateDir, "sessions"), { recursive: true });
  mkdirSync(join(root, ".tlc", "harness"), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(stateDir, "sessions", "sess-1.json"),
    JSON.stringify({
      session_id: "sess-1",
      provider: "provider-a",
      started_at: now,
      updated_at: now,
      models: {},
      tools: {},
      subagents: {},
      gates: { pass: 0, fail: 0 },
      denials: 0,
      prompts: 1,
      responses: 0,
      thoughts: 0,
      comped: 0,
      shell: { allow: 3, ask: 1, deny: 0, byRule: { "untrusted-judge": 1 } },
      railsByRule: { "untrusted-judge": 1 },
      gatesByName: {},
      gateTime: {},
      injected_chars: 0,
      durable_chars: 0,
      hook_context_reliable: true,
      mcp: {},
      estimated_cost_usd: 0,
      cost_incomplete: false,
      usage_reported: true,
      input_tokens: 0,
      output_tokens: 0,
      cost_alert_sent: false,
      judge,
    }),
  );
  return root;
}

/**
 * hazard: the child must not load `tools/test-env.mjs`. That import exists to rewrite the project directory for a
 * hermetic suite, and here it would point the command at a sandbox rather than at the fixture — the command then
 * reports "no rollup" and the test proves nothing. The project directory is passed to the command the way an
 * operator's shell passes it instead.
 */
function runReport(root: string): { stdout: string; markdown: string } {
  const stdout = execFileSync("node", [OBS_CLI, "report", "sess-1"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      TLC_PROJECT_DIR: root,
      CLAUDE_PROJECT_DIR: root,
      TLC_HOME: join(root, "home"),
      NO_COLOR: "1",
    },
  });
  return { stdout, markdown: readFileSync(join(projectStateDir(root), "reports", "sess-1.md"), "utf8") };
}

test("C29 obs report shows judge runs, asks by rule, failures by category, latency and input tokens", () => {
  const root = projectWithRollup({
    runs: 6,
    asks: 1,
    quiet: 2,
    failures: { timeout: 2, network: 1 },
    drift: 1,
    totalMs: 4200,
    worstMs: 2500,
    inputTokens: 1200,
    costUsd: 0,
    costSource: "missing",
  });
  const { stdout, markdown } = runReport(root);

  assert.match(markdown, /## Untrusted-content judge/);
  assert.match(markdown, /\| Runs \| 6 \|/);
  assert.match(markdown, /\| Asked \| 1 \|/);
  assert.match(markdown, /\| Ran and asked nobody \| 2 \|/);
  assert.match(markdown, /\| ↳ timeout \| 2 \|/);
  assert.match(markdown, /\| ↳ network \| 1 \|/);
  assert.match(markdown, /\| Answered by another version \| 1 \|/);
  assert.match(markdown, /\| Latency total \/ worst ms \| 4200 \/ 2500 \|/);
  assert.match(markdown, /\| Input tokens \| 1200 \|/);
  // invariant: input tokens are shown even with no catalogue rate, and the cost says so rather than printing zero.
  assert.match(markdown, /cost_source: "missing"/);
  assert.equal(markdown.includes("| Estimated USD | $0.000000 |"), false);
  assert.match(markdown, /\| untrusted-judge \| 1 \|/);
  assert.match(stdout, /Untrusted-content judge/);
  assert.match(stdout, /no catalogue rate/);
});

test("C29 obs report prints the figure where the catalogue carries a rate", () => {
  const root = projectWithRollup({
    runs: 2,
    asks: 0,
    quiet: 2,
    failures: {},
    drift: 0,
    totalMs: 600,
    worstMs: 350,
    inputTokens: 600,
    costUsd: 0.0000252,
    costSource: "litellm",
  });
  const { markdown } = runReport(root);
  assert.match(markdown, /\| Estimated USD \| \$0\.000025 \|/);
  assert.equal(markdown.includes("cost_source"), false);
});

test("C29 obs report of a session that never ran the judge carries no judge section", () => {
  const root = mkdtempSync(join(tmpdir(), "tlc-obs-report-judge-"));
  roots.push(root);
  const stateDir = projectStateDir(root);
  mkdirSync(join(stateDir, "sessions"), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(stateDir, "sessions", "sess-1.json"),
    JSON.stringify({
      session_id: "sess-1",
      provider: "provider-a",
      started_at: now,
      updated_at: now,
      models: {},
      tools: {},
      subagents: {},
      gates: { pass: 0, fail: 0 },
      denials: 0,
      prompts: 1,
      responses: 0,
      thoughts: 0,
      comped: 0,
      shell: { allow: 1, ask: 0, deny: 0, byRule: {} },
      railsByRule: {},
      gatesByName: {},
      gateTime: {},
      injected_chars: 0,
      durable_chars: 0,
      hook_context_reliable: true,
      mcp: {},
      estimated_cost_usd: 0,
      cost_incomplete: false,
      usage_reported: true,
      input_tokens: 0,
      output_tokens: 0,
      cost_alert_sent: false,
    }),
  );
  const { stdout, markdown } = runReport(root);
  assert.equal(markdown.includes("Untrusted-content judge"), false);
  assert.equal(stdout.includes("Untrusted-content judge"), false);
});
