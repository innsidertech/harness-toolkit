#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  antigravityRecoveryNotice,
  applyAntigravityWiring,
} from "../src/providers/antigravity/antigravity.wiring.ts";
import { applyClaudeWiring } from "../src/providers/claude/claude.wiring.ts";
import { codexHooksPath } from "../src/providers/codex/codex.paths.ts";
import { providers } from "../src/providers/index.ts";

const CURSOR_MARKER = "tlc-exec.mjs";

function quoteIfNeeded(token) {
  return token.includes(" ") ? `"${token}"` : token;
}

function commandStringFor(entry) {
  return [entry.command, ...entry.args].map(quoteIfNeeded).join(" ");
}

export function renderCursorHooksDocument(entries) {
  const hooks = {};
  for (const entry of entries) {
    const rendered = { command: commandStringFor(entry), timeout: entry.timeoutSeconds };
    if (entry.failClosed) {
      rendered.failClosed = true;
    }
    if (entry.matcher !== undefined) {
      rendered.matcher = entry.matcher;
    }
    if (entry.loopLimit !== undefined) {
      rendered.loop_limit = entry.loopLimit;
    }
    hooks[entry.hookEvent] = [...(hooks[entry.hookEvent] ?? []), rendered];
  }
  return { version: 1, hooks };
}

export function isCursorWired(targetPath) {
  return existsSync(targetPath) && readFileSync(targetPath, "utf8").includes(CURSOR_MARKER);
}

export function applyCursorWiring(wiring, { force = false } = {}) {
  const targetPath = wiring.target;
  const document = renderCursorHooksDocument(wiring.entries);
  const rendered = `${JSON.stringify(document, null, 2)}\n`;

  if (existsSync(targetPath) && !force) {
    if (isCursorWired(targetPath)) {
      return { status: "unchanged", target: targetPath };
    }
    return {
      status: "refused",
      target: targetPath,
      reason: `${targetPath} exists without harness entries — rerun with --force to overwrite, or merge manually.`,
    };
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, rendered);
  return { status: "written", target: targetPath };
}

export function applyProviderWiring(wiring, { force = false } = {}) {
  // why: this path is not a Cursor document. `force` still must not create or overwrite it.
  if (wiring.target === codexHooksPath()) {
    return { status: "unchanged", target: wiring.target };
  }
  if (wiring.strategy === "replace") {
    return applyCursorWiring(wiring, { force });
  }
  if (wiring.strategy === "named-group") {
    return applyAntigravityWiring(wiring);
  }
  const result = applyClaudeWiring(wiring.target, wiring.entries);
  if (!result.ok) {
    return { status: "failed", target: wiring.target, reason: result.error };
  }
  return { status: result.changed ? "merged" : "unchanged", target: wiring.target };
}

// why `presencePath`: a host whose wiring file lives in a shared config directory is not installed merely because
// that directory exists — another product of the same vendor creates it too.
export function providerPresencePath(wiring) {
  return wiring.presencePath ?? dirname(wiring.target);
}

export function isProviderHomePresent(wiring) {
  return existsSync(providerPresencePath(wiring));
}

function report(result) {
  switch (result.status) {
    case "written":
      console.log(`hooks: wrote ${result.target}`);
      return true;
    case "merged":
      console.log(`hooks: merged ${result.target}`);
      return true;
    case "unchanged":
      console.log(`hooks: unchanged (${result.target})`);
      return true;
    case "refused":
      console.error(`hooks: ${result.reason}`);
      return false;
    case "failed":
      console.error(`hooks: failed to update ${result.target}: ${result.reason}`);
      return false;
    default:
      return false;
  }
}

export function main() {
  const binDir = dirname(fileURLToPath(import.meta.url));
  // hazard: ESM resolves import.meta.url to the realpath, so deriving the launcher from it bakes
  // the checkout location into every hook. TLC_HOME is the install path and survives a move.
  const harnessHome = process.env.TLC_HOME?.trim() || join(binDir, "..");
  const launcherPath = join(harnessHome, "bin", "tlc-exec.mjs");
  const force = process.argv.includes("--force");
  let anyFailed = false;

  for (const provider of providers) {
    const wiring = provider.wiring({ launcherPath });
    if (!isProviderHomePresent(wiring)) {
      console.log(`hooks: ${provider.name} not installed — skipping (${providerPresencePath(wiring)} not found)`);
      continue;
    }
    // why: a present file, including one without the harness marker, is skipped. Refusing it would fail the
    // other providers in this same loop and would not change the bytes.
    if (provider.name === "codex") {
      console.log(`hooks: codex skipped (${wiring.target})`);
      continue;
    }
    if (!report(applyProviderWiring(wiring, { force }))) {
      anyFailed = true;
      continue;
    }
    if (wiring.strategy === "named-group") {
      for (const line of antigravityRecoveryNotice(wiring.target)) {
        console.log(line);
      }
    }
  }

  process.exitCode = anyFailed ? 1 : 0;
}

if (import.meta.main) {
  main();
}
