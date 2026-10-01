import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyProviderWiring,
  isCursorWired,
  renderCursorHooksDocument,
} from "../../../../bin/write-user-hooks.mjs";
import { checkProviders, providerWiringStatus } from "../../../../tools/doctor.ts";
import type { HarnessEvent } from "../../../contracts/index.ts";
import { composeProtectedPaths } from "../../../entrypoints/run.ts";
import { providerConfigDirs, userSettingsPaths } from "../../../platform/paths.ts";
import { assertSatisfiesContract } from "../../__test__/provider.contract.test.ts";
import { cursorWiring, cursorWiringProblems } from "../../cursor/cursor.wiring.ts";
import { providers } from "../../provider.registry.ts";
import { codexCapabilities } from "../codex.capabilities.ts";
import { detectCodex } from "../codex.detect.ts";
import { CODEX_EVENT_PREFIX } from "../codex.events.ts";
import { codexFailClosed } from "../codex.failure.ts";
import { codexToEvent, EVENT_KIND_BY_HOOK } from "../codex.inbound.ts";
import { codexRender, renderCodexFailure } from "../codex.outbound.ts";
import { codexHooksPath } from "../codex.paths.ts";
import { codexPolicyDefaults } from "../codex.policy-defaults.ts";
import { CODEX_TOOLS } from "../codex.tools.ts";
import { codexProvider } from "../index.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const PRESENT_DETAIL = "Codex hooks.json is present and this check does not call it installed wiring.";
const FORCE_PHRASE = "hooks unchanged (merge manually or: node bin/write-user-hooks.mjs --force)";

const scratch = mkdtempSync(join(tmpdir(), "codex-provider-"));

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function withCodexHome<T>(home: string | undefined, run: () => T): T {
  const previous = process.env.CODEX_HOME;
  if (home === undefined) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = home;
  }
  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previous;
    }
  }
}

function denyReason(stdout: string | null): string {
  assert.equal(typeof stdout, "string");
  const parsed = JSON.parse(stdout ?? "") as {
    hookSpecificOutput: {
      hookEventName: string;
      permissionDecision: string;
      permissionDecisionReason: string;
    };
  };
  assert.deepEqual(Object.keys(parsed), ["hookSpecificOutput"]);
  assert.deepEqual(Object.keys(parsed.hookSpecificOutput), [
    "hookEventName",
    "permissionDecision",
    "permissionDecisionReason",
  ]);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(stdout?.includes("additionalContext"), false);
  assert.equal(stdout?.includes("updatedInput"), false);
  assert.equal(stdout?.includes('"permissionDecision":"ask"'), false);
  return parsed.hookSpecificOutput.permissionDecisionReason;
}

const event: HarnessEvent = {
  provider: "codex",
  event: "tool.before",
  sessionKey: "codex-test",
  projectDir: scratch,
  raw: {},
};

describe("render and failure", () => {
  test("deny writes the measured envelope and exit 0", () => {
    const reason = 'say "no" \\ already — não';
    const rendered = codexRender({ kind: "deny", reason, rule: "probe" }, event);
    assert.equal(denyReason(rendered.stdout), reason);
    assert.equal(rendered.exitCode, 0);
  });

  test("allow and abstain write nothing", () => {
    for (const decision of [{ kind: "allow" as const }, { kind: "abstain" as const }]) {
      const rendered = codexRender(decision, event);
      assert.equal(rendered.stdout, null);
      assert.equal(rendered.exitCode, 0);
    }
  });

  test("each failure cause is the deny envelope with that cause and exit 0", () => {
    for (const cause of [
      "launcher-error",
      "timeout",
      "invalid-stdin",
      "unrecognized-payload",
      "handler-error",
    ] as const) {
      const rendered = renderCodexFailure(cause);
      assert.equal(denyReason(rendered.stdout), cause);
      assert.equal(rendered.exitCode, 0);
    }
  });

  test("unsupported kinds deny with the literal reason", () => {
    const decisions = [
      { kind: "ask" as const, reason: "ask me", rule: "probe" },
      { kind: "context" as const, text: "more" },
      { kind: "rewriteInput" as const, input: { keep: true }, reason: "rewritten" },
      { kind: "rewriteOutput" as const, output: "out" },
    ];
    for (const decision of decisions) {
      const rendered = codexRender(decision, event);
      assert.equal(denyReason(rendered.stdout), "unsupported");
      assert.equal(rendered.exitCode, 0);
    }
  });
});

describe("descriptor", () => {
  test("the provider satisfies the port and is last in the registry", () => {
    assertSatisfiesContract(codexProvider);
    assert.equal(codexProvider.name, "codex");
    assert.deepEqual(
      providers.map((provider) => provider.name),
      ["cursor", "claude", "antigravity", "codex"],
    );
    assert.equal("floorHostFacts" in codexProvider, false);
    assert.equal("canonicalWiringMatch" in codexProvider, false);
    assert.equal("projectWiringTargets" in codexProvider, false);
  });

  test("detect is false for every value", () => {
    for (const value of [null, { any: true }, "text", 1, ["a"]]) {
      assert.equal(detectCodex(value), false);
    }
    const source = readFileSync(join(repoRoot, "src", "providers", "codex", "codex.detect.ts"), "utf8");
    assert.match(source, /return false;/);
    assert.equal(source.includes("if ("), false);
  });

  test("toEvent returns null and names no stdin field", () => {
    assert.equal(codexToEvent({}), null);
    assert.equal(codexToEvent({}, "codex:PreToolUse"), null);
    assert.equal(codexToEvent({}, undefined), null);
    assert.equal(codexToEvent({}, "other"), null);
    const source = readFileSync(join(repoRoot, "src", "providers", "codex", "codex.inbound.ts"), "utf8");
    assert.equal(source.includes("agent_id"), false);
    assert.equal(source.includes("command"), false);
    assert.equal(source.includes("PRE_TOOL_USE_FAN_OUT"), false);
    assert.equal(source.includes("POST_TOOL_USE_FAN_OUT"), false);
    assert.deepEqual(EVENT_KIND_BY_HOOK, {});
  });

  test("capabilities, defaults, lessons and diagnostic root stay inside the claim", () => {
    assert.deepEqual(codexCapabilities(), {
      enforcesHooks: true,
      askSupportedOn: [],
      sessionEnv: false,
      nativeLoopCounter: false,
      dedicatedShellEvent: false,
      toolInputRewrite: false,
      toolOutputRewriteOn: [],
      contextAtToolBefore: false,
      contextAtToolAfter: false,
      contextAtStop: false,
      sessionStartContextReliable: false,
      toolOutputAtAfter: false,
      usageInPayload: false,
      effortSignal: false,
      thoughtEvent: false,
    });
    const defaults = codexPolicyDefaults();
    assert.deepEqual(defaults, { blockedPatterns: [], minEffort: null, untrustedTools: [] });
    assert.equal("allowedModels" in defaults, false);
    for (const root of ["", "/", scratch]) {
      assert.equal(codexProvider.lessonsView(root), null);
    }
    assert.equal(codexFailClosed.hostEventPrefix, "codex:");
    assert.equal(codexFailClosed.hostEventPrefix, CODEX_EVENT_PREFIX);
    for (const parsed of [null, { any: true }, "text"]) {
      assert.equal(codexFailClosed.diagnosticRoot(parsed), null);
    }
  });

  test("the tool table is the three measured names and fill copies nothing", () => {
    assert.deepEqual(
      CODEX_TOOLS.map((row) => row.native),
      ["Bash", "collaborationspawn_agent", "collaborationwait_agent"],
    );
    assert.equal(
      CODEX_TOOLS.some((row) => row.native === "apply_patch"),
      false,
    );
    const bash = CODEX_TOOLS[0];
    const spawn = CODEX_TOOLS[1];
    const wait = CODEX_TOOLS[2];
    assert.ok(bash && spawn && wait);
    assert.equal(bash.pre, "shell.before");
    assert.equal(bash.post, "shell.after");
    assert.equal(bash.verified, true);
    assert.equal(bash.canonical, null);
    const filled: HarnessEvent = { ...event, event: "shell.before" };
    bash.fill(filled, { anything: "left unread" });
    assert.equal(filled.command, undefined);
    assert.equal(spawn.canonical, null);
    assert.equal(spawn.pre, "tool.before");
    assert.equal(spawn.post, "tool.after");
    assert.equal(wait.verified, true);
    assert.equal(wait.canonical, null);
    const wiring = codexProvider.wiring({ launcherPath: join(scratch, "tlc-exec.mjs") });
    assert.deepEqual(
      wiring.entries.map((entry) => entry.hookEvent),
      ["PreToolUse"],
    );
    assert.equal(wiring.entries[0]?.handler, "tool-before");
    assert.equal(wiring.entries[0]?.args[2], "codex:PreToolUse");
    assert.equal(wiring.entries[0]?.timeoutSeconds, 10);
    for (const forbidden of ["SessionStart", "PostToolUse", "Stop", "SubagentStart", "SubagentStop"]) {
      assert.equal(
        wiring.entries.some((entry) => entry.hookEvent === forbidden),
        false,
      );
    }
  });
});

describe("path and doctor", () => {
  test("the hooks file is the only target, and platform paths stay free of it", () => {
    const fallback = join(homedir(), ".codex", "hooks.json");
    withCodexHome(undefined, () => {
      assert.equal(codexHooksPath(), fallback);
    });
    withCodexHome("", () => {
      assert.equal(codexHooksPath(), fallback);
    });
    const home = join(scratch, "codex-home");
    withCodexHome(home, () => {
      const target = codexHooksPath();
      assert.equal(target, join(home, "hooks.json"));
      assert.equal(target.endsWith("config.toml"), false);
      const wiring = codexProvider.wiring({ launcherPath: join(scratch, "tlc-exec.mjs") });
      assert.equal(wiring.target, target);
      assert.equal(wiring.presencePath, target);
      assert.equal(wiring.strategy, "replace");
      assert.deepEqual(codexProvider.wiringTargets(), [target]);
      assert.equal(existsSync(target), false);
    });
    for (const path of [...providerConfigDirs(), ...userSettingsPaths()]) {
      assert.equal(path.toLowerCase().includes("codex"), false, path);
    }
  });

  test("a missing hooks file is not installed, and any present body is the same warning", () => {
    const home = join(scratch, "doctor-home");
    const runtime = join(scratch, "runtime");
    mkdirSync(join(runtime, "bin"), { recursive: true });
    const launcher = join(runtime, "bin", "tlc-exec.mjs");
    writeFileSync(launcher, "");
    withCodexHome(home, () => {
      const absent = checkProviders([codexProvider], runtime);
      assert.deepEqual(absent, [{ level: "ok", name: "codex wiring", detail: "not installed" }]);

      mkdirSync(home, { recursive: true });
      const target = codexHooksPath();
      const healthy = renderCursorHooksDocument(cursorWiring({ launcherPath: launcher }).entries);
      for (const body of ["", "not-json", `${JSON.stringify(healthy)}\n`]) {
        writeFileSync(target, body);
        const checks = checkProviders([codexProvider], runtime);
        assert.deepEqual(checks, [{ level: "warn", name: "codex wiring", detail: PRESENT_DETAIL }]);
      }
      const text = readFileSync(target, "utf8");
      assert.equal(isCursorWired(target), true);
      assert.deepEqual(cursorWiringProblems(text, { launcherPath: launcher }, existsSync), []);
      // The Cursor checker, asked directly, would call this body wired. The Codex check above did not.
      assert.equal(providerWiringStatus(codexProvider.wiring({ launcherPath: launcher })), "wired");
    });
  });
});

describe("writer", () => {
  test("applyProviderWiring with force does not create or modify the Codex file", () => {
    const home = join(scratch, "apply-home");
    withCodexHome(home, () => {
      const wiring = codexProvider.wiring({ launcherPath: join(scratch, "tlc-exec.mjs") });
      const absent = applyProviderWiring(wiring, { force: true });
      assert.equal(absent.status, "unchanged");
      assert.equal(existsSync(wiring.target), false);

      mkdirSync(home, { recursive: true });
      const body = '{"kept":true}\n';
      writeFileSync(wiring.target, body);
      const present = applyProviderWiring(wiring, { force: true });
      assert.equal(present.status, "unchanged");
      assert.equal(readFileSync(wiring.target, "utf8"), body);
    });
  });

  test("main skips a present Codex file and still wires the other three", () => {
    const profile = join(scratch, "profile");
    const codexHome = join(profile, "codex-home");
    const tlcHome = join(profile, "tlc");
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(tlcHome, { recursive: true });
    mkdirSync(join(profile, ".cursor"), { recursive: true });
    mkdirSync(join(profile, ".claude"), { recursive: true });
    mkdirSync(join(profile, ".gemini", "antigravity-cli"), { recursive: true });
    const codexFile = join(codexHome, "hooks.json");
    const body = '{"kept":true}\n';
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      USERPROFILE: profile,
      HOME: profile,
      CODEX_HOME: codexHome,
      TLC_HOME: tlcHome,
    };
    // why: the suite import sets these, and cursorConfigDir/claudeConfigDir prefer them over USERPROFILE.
    // The presence directories above live under this profile, so the child must resolve there.
    delete env.CURSOR_CONFIG_DIR;
    delete env.CLAUDE_CONFIG_DIR;
    const script = join(repoRoot, "bin", "write-user-hooks.mjs");
    const realHooks = join(homedir(), ".codex", "hooks.json");
    const realBefore = existsSync(realHooks);
    for (const args of [[script], [script, "--force"]]) {
      writeFileSync(codexFile, body);
      const result = spawnSync(process.execPath, args, { cwd: repoRoot, env, encoding: "utf8" });
      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
      assert.equal(readFileSync(codexFile, "utf8"), body);
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      assert.equal(output.includes("exists without harness entries"), false);
      assert.equal(output.includes(FORCE_PHRASE), false);
      assert.equal(existsSync(join(profile, ".cursor", "hooks.json")), true);
      assert.equal(existsSync(join(profile, ".claude", "settings.json")), true);
      assert.equal(existsSync(join(profile, ".gemini", "config", "hooks.json")), true);
      assert.equal(existsSync(realHooks), realBefore);
    }
  });
});

describe("protected paths", () => {
  test("every session's protected list includes the Codex hooks file", () => {
    const home = join(scratch, "protected-home");
    withCodexHome(home, () => {
      const target = codexHooksPath();
      const paths = composeProtectedPaths(providers, scratch);
      assert.equal(paths.filter((path) => path === target).length, 1);
    });
  });
});
