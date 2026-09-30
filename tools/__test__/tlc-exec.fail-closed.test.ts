import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  type CaptureDeps,
  FAIL_CLOSED_HOSTS,
  failClosedHostFor,
  failClosedVerdict,
  isHostVerdict,
  runCaptured,
} from "../../bin/tlc-exec.mjs";
import {
  ANTIGRAVITY_EVENT_PREFIX,
  ANTIGRAVITY_SILENT_SUCCESS_EVENTS,
  hostEventToken,
} from "../../src/providers/antigravity/antigravity.events.ts";
import { renderAntigravityFailure } from "../../src/providers/antigravity/antigravity.outbound.ts";
import { antigravityWiring } from "../../src/providers/antigravity/antigravity.wiring.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const launcher = join(repoRoot, "bin", "tlc-exec.mjs");
const scratch = mkdtempSync(join(tmpdir(), "tlc-exec-fail-closed-"));

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const deny = (cause: string) => `{"decision":"deny","reason":"tlc-harness: ${cause}"}`;

/** A runtime home whose only hook program is `body`, run by Node from `dist/` the way an installed copy is. */
function homeWith(name: string, body: string): string {
  const home = join(scratch, name);
  mkdirSync(join(home, "dist"), { recursive: true });
  writeFileSync(join(home, "dist", "tool-before.mjs"), body);
  return home;
}

function launch(home: string, ...rest: string[]) {
  const result = spawnSync(process.execPath, [launcher, "tool-before", ...rest], {
    encoding: "utf8",
    input: "",
    env: { ...process.env, TLC_HOME: home },
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

describe("the launcher under a fail-closed host's token", () => {
  test("AGH-01: a runtime that cannot run refuses with launcher-error, exit 0, diagnosis on stderr", () => {
    const result = launch(join(scratch, "no-runtime-here"), "antigravity:PreToolUse");
    assert.equal(result.stdout.trim(), deny("launcher-error"));
    assert.equal(result.status, 0);
    assert.match(result.stderr, /tlc:/);
  });

  test("AGH-02: a child that exits non-zero refuses with launcher-error, exit 0", () => {
    const result = launch(homeWith("exit1", "process.exit(1);\n"), "antigravity:PreToolUse");
    assert.equal(result.stdout.trim(), deny("launcher-error"));
    assert.equal(result.status, 0);
  });

  test("AGH-02: at PreToolUse a child that exits 0 without a single verdict refuses with launcher-error", () => {
    for (const [name, body] of [
      ["pre-silent", ""],
      ["pre-empty-object", 'process.stdout.write("{}");\n'],
      ["pre-two", 'process.stdout.write(\'{"decision":"allow"}{"decision":"allow"}\');\n'],
    ] as const) {
      const result = launch(homeWith(name, body), "antigravity:PreToolUse");
      assert.equal(result.stdout.trim(), deny("launcher-error"), name);
      assert.equal(result.status, 0, name);
    }
  });

  test("AGH-02: at PostToolUse and Stop, exit 1, {}, an allow object or a lone newline refuse with launcher-error", () => {
    for (const token of ["antigravity:PostToolUse", "antigravity:Stop"]) {
      for (const [name, body] of [
        ["exit1", "process.exit(1);\n"],
        ["empty-object", 'process.stdout.write("{}");\n'],
        ["allow", 'process.stdout.write(\'{"decision":"allow"}\\n\');\n'],
        ["newline", 'process.stdout.write("\\n");\n'],
      ] as const) {
        const result = launch(homeWith(`${token.slice(12)}-${name}`, body), token);
        assert.equal(result.stdout.trim(), deny("launcher-error"), `${token} ${name}`);
        assert.equal(result.status, 0, `${token} ${name}`);
      }
    }
  });

  test("D-B: at PostToolUse and Stop a child that exits 0 with zero bytes is success — zero bytes, exit 0", () => {
    for (const token of ["antigravity:PostToolUse", "antigravity:Stop"]) {
      const result = launch(homeWith(`${token.slice(12)}-silent`, ""), token);
      assert.equal(result.stdout, "", token);
      assert.equal(result.status, 0, token);
    }
  });

  test("a child's own verdict passes through once, unchanged", () => {
    const verdict = '{"decision":"deny","reason":"rule=wiring-tamper"}';
    for (const token of ["antigravity:PreToolUse", "antigravity:PostToolUse", "antigravity:Stop"]) {
      const result = launch(
        homeWith(`${token.slice(12)}-verdict`, `process.stdout.write(${JSON.stringify(`${verdict}\n`)});\n`),
        token,
      );
      assert.equal(result.stdout, `${verdict}\n`, token);
      assert.equal(result.status, 0);
    }
    const allow = launch(
      homeWith("pre-allow", 'process.stdout.write(\'{"decision":"allow"}\\n\');\n'),
      "antigravity:PreToolUse",
    );
    assert.equal(allow.stdout, '{"decision":"allow"}\n');
  });

  test("AGH-12: without the prefix a broken runtime still carries on with {} for every hook", () => {
    for (const rest of [[], ["PreToolUse"], ["PostToolUse"], ["Stop"]]) {
      const result = launch(join(scratch, "no-runtime-here"), ...rest);
      assert.equal(result.stdout.trim(), "{}", rest.join(" ") || "(no token)");
      assert.equal(result.status, 0);
    }
  });
});

type Capture = { out: string[]; err: string[]; exits: number[] };

function capturingDeps(capture: Capture): CaptureDeps {
  return {
    spawn: (command, args, options) => spawn(command, args, options as Parameters<typeof spawn>[2]),
    write: (text, done) => {
      capture.out.push(text);
      done();
    },
    writeErr: (line) => {
      capture.err.push(line);
    },
    exit: (code) => {
      capture.exits.push(code);
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
  };
}

describe("runCaptured", () => {
  test("AGH-03: a child past its deadline is killed and the host gets exactly one timeout refusal, on every event", async () => {
    for (const silentSuccess of [false, true]) {
      const capture: Capture = { out: [], err: [], exits: [] };
      await runCaptured(
        process.execPath,
        ["-e", "setTimeout(() => {}, 2000)"],
        { env: process.env, deadlineMs: 300, silentSuccess },
        capturingDeps(capture),
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.deepEqual(capture.out, [`${deny("timeout")}\n`], `silentSuccess ${silentSuccess}`);
      assert.deepEqual(capture.exits, [0]);
      assert.match(capture.err.join("\n"), /exceeded 300 ms/);
    }
  });

  test("D-B: with silentSuccess a child that writes nothing and exits 0 ends in zero bytes and exit 0", async () => {
    const capture: Capture = { out: [], err: [], exits: [] };
    await runCaptured(
      process.execPath,
      ["-e", ""],
      { env: process.env, deadlineMs: 5000, silentSuccess: true },
      capturingDeps(capture),
    );
    assert.deepEqual(capture.out, []);
    assert.deepEqual(capture.exits, [0]);
    assert.deepEqual(capture.err, []);
  });

  test("without silentSuccess the same silent child is a launcher error", async () => {
    const capture: Capture = { out: [], err: [], exits: [] };
    await runCaptured(
      process.execPath,
      ["-e", ""],
      { env: process.env, deadlineMs: 5000 },
      capturingDeps(capture),
    );
    assert.deepEqual(capture.out, [`${deny("launcher-error")}\n`]);
    assert.deepEqual(capture.exits, [0]);
  });

  test("AGH-02: a command that cannot start refuses with launcher-error", async () => {
    const capture: Capture = { out: [], err: [], exits: [] };
    await runCaptured(
      join(scratch, "no-such-binary"),
      [],
      { env: process.env, deadlineMs: 5000 },
      capturingDeps(capture),
    );
    assert.deepEqual(capture.out, [`${deny("launcher-error")}\n`]);
    assert.deepEqual(capture.exits, [0]);
  });

  test("AGH-02: a child killed by a signal refuses with launcher-error", async () => {
    const capture: Capture = { out: [], err: [], exits: [] };
    await runCaptured(
      process.execPath,
      ["-e", "process.kill(process.pid, 'SIGTERM'); setTimeout(() => {}, 5000)"],
      { env: process.env, deadlineMs: 4000 },
      capturingDeps(capture),
    );
    assert.deepEqual(capture.out, [`${deny("launcher-error")}\n`]);
  });

  test("the deadlines sit two seconds under the wired timeouts, and an unknown token gets the fallback", () => {
    const [host] = FAIL_CLOSED_HOSTS;
    assert.ok(host);
    for (const entry of antigravityWiring({ launcherPath: "/x/tlc-exec.mjs" }).entries) {
      const token = entry.args[2] ?? "";
      assert.equal(host.deadlineMs[token], (entry.timeoutSeconds - 2) * 1000, token);
      assert.equal(failClosedHostFor(entry.handler, token)?.deadlineMs, (entry.timeoutSeconds - 2) * 1000);
    }
    assert.equal(failClosedHostFor("tool-before", "antigravity:Other")?.deadlineMs, host.fallbackDeadlineMs);
  });

  test("AGH-07: silentSuccess is true only at PostToolUse and Stop, false at PreToolUse and at an unknown token", () => {
    assert.equal(failClosedHostFor("tool-before", "antigravity:PreToolUse")?.silentSuccess, false);
    assert.equal(failClosedHostFor("tool-after", "antigravity:PostToolUse")?.silentSuccess, true);
    assert.equal(failClosedHostFor("stop", "antigravity:Stop")?.silentSuccess, true);
    assert.equal(failClosedHostFor("tool-before", "antigravity:Other")?.silentSuccess, false);
    assert.equal(failClosedHostFor("tool-before", "antigravity:PreInvocation")?.silentSuccess, false);
  });

  test("only a hook entry with a prefixed token is fail-closed", () => {
    assert.equal(failClosedHostFor("tool-before", "PreToolUse"), null);
    assert.equal(failClosedHostFor("tool-before", undefined), null);
    assert.equal(failClosedHostFor("doctor", "antigravity:PreToolUse"), null);
    assert.notEqual(failClosedHostFor("stop", "antigravity:Stop"), null);
  });

  test("AGH-07: before a tool isHostVerdict accepts exactly one allow or one deny with a reason, never zero bytes", () => {
    assert.equal(isHostVerdict('{"decision":"allow"}', false), true);
    assert.equal(isHostVerdict('{"decision":"deny","reason":"r"}', false), true);
    for (const text of [
      "",
      "\n",
      " ",
      "{}",
      '{"decision":"deny"}',
      '{"decision":"ask","reason":"r"}',
      "[]",
      "x",
      '{"decision":"allow","x":1}',
    ]) {
      assert.equal(isHostVerdict(text, false), false, JSON.stringify(text));
    }
  });

  test("AGH-07: after a tool and at Stop isHostVerdict accepts zero bytes or one deny, never allow, {} or a newline", () => {
    assert.equal(isHostVerdict("", true), true);
    assert.equal(isHostVerdict('{"decision":"deny","reason":"r"}', true), true);
    for (const text of [
      "\n",
      " ",
      "{}",
      '{"decision":"allow"}',
      '{"decision":"deny"}',
      '{"decision":"ask","reason":"r"}',
      "[]",
      "x",
    ]) {
      assert.equal(isHostVerdict(text, true), false, JSON.stringify(text));
    }
  });
});

describe("AGH-82: the launcher's literals match the adapter", () => {
  test("the launcher's refusal for launcher-error and timeout equals the adapter's render", () => {
    for (const cause of ["launcher-error", "timeout"] as const) {
      assert.equal(failClosedVerdict(cause), renderAntigravityFailure(cause).stdout);
    }
  });

  test("the prefix the launcher recognises is the one the adapter's wiring writes", () => {
    assert.deepEqual(
      FAIL_CLOSED_HOSTS.map((host) => host.prefix),
      [ANTIGRAVITY_EVENT_PREFIX],
    );
    for (const entry of antigravityWiring({ launcherPath: "/x/tlc-exec.mjs" }).entries) {
      assert.ok(entry.args[2]?.startsWith(FAIL_CLOSED_HOSTS[0]?.prefix ?? "\0"), entry.hookEvent);
    }
  });

  test("the launcher's silent-success tokens are the adapter's silent-success events", () => {
    assert.deepEqual(
      FAIL_CLOSED_HOSTS[0]?.silentSuccessTokens,
      ANTIGRAVITY_SILENT_SUCCESS_EVENTS.map(hostEventToken),
    );
  });
});
