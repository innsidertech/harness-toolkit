import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { HarnessEvent } from "../../contracts/index.ts";
import { projectStateDir } from "../../platform/paths.ts";
import { type ProviderPort, providers } from "../../providers/index.ts";
import { composeProtectedPaths, type Handler, hostEventOf, runHandler } from "../run.ts";
import { stopHandler } from "../stop.ts";
import { toolAfterHandler } from "../tool-after.ts";
import { toolBeforeHandler } from "../tool-before.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_SOURCE = join(HERE, "..", "run.ts");

// why: payloads are built from the adapter's captured fixtures and picked by what they translate to, so no native
// tool name is written outside the adapter's own directory.
const FIXTURE_DIR = join(HERE, "..", "..", "providers", "antigravity", "__test__", "fixtures");

function antigravity(): ProviderPort {
  const found = providers.find((provider) => provider.name === "antigravity");
  if (!found) {
    throw new Error("antigravity is not registered");
  }
  return found;
}

type Payload = Record<string, unknown> & { toolCall?: { name: string; args: Record<string, unknown> } };

function fixtureWhere(
  token: string,
  matches: (event: HarnessEvent) => boolean,
  includeSynthetic = false,
): Payload {
  for (const name of readdirSync(FIXTURE_DIR)) {
    if (name.startsWith("synthetic-") && !includeSynthetic) {
      continue;
    }
    const raw = JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as Payload;
    const event = antigravity().toEvent(raw, token);
    if (event !== null && matches(event)) {
      return raw;
    }
  }
  throw new Error(`no fixture translates to the event this test needs under ${token}`);
}

function inWorkspace(raw: Payload, root: string, args: Record<string, unknown> = {}): string {
  const next: Payload = { ...raw, workspacePaths: [root] };
  if (raw.toolCall) {
    next.toolCall = { ...raw.toolCall, args: { ...raw.toolCall.args, ...args } };
  }
  return JSON.stringify(next);
}

let runtimeSandbox: string;
let previousHome: string | undefined;

before(() => {
  runtimeSandbox = mkdtempSync(join(tmpdir(), "tlc-run-agy-home-"));
  previousHome = process.env.TLC_HOME;
  process.env.TLC_HOME = runtimeSandbox;
});

after(() => {
  if (previousHome === undefined) {
    delete process.env.TLC_HOME;
  } else {
    process.env.TLC_HOME = previousHome;
  }
  rmSync(runtimeSandbox, { recursive: true, force: true });
});

type Scene = { root: string; cwd: string; stderr: string[] };

/** A workspace and a separate working directory, the way the host launches a hook from inside `.agents`. */
async function inScene(body: (scene: Scene) => Promise<void>): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "tlc-run-agy-"));
  const root = join(scratch, "workspace");
  const cwd = join(scratch, "elsewhere", ".agents");
  mkdirSync(root, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    await body({ root, cwd, stderr: [] });
  } finally {
    process.chdir(previous);
    rmSync(scratch, { recursive: true, force: true });
  }
}

function io(scene: Scene, text: string, hostEvent: string | null = "antigravity:PreToolUse") {
  return {
    readStdin: () => Promise.resolve(text),
    hostEvent,
    writeStderr: (line: string) => {
      scene.stderr.push(line);
    },
  };
}

const deny = (cause: string) => `{"decision":"deny","reason":"tlc-harness: ${cause}"}`;

function obsRecords(root: string): Record<string, unknown>[] {
  const path = join(projectStateDir(root), "obs.jsonl");
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("AGH-04: empty, blank or non-JSON stdin is refused as invalid-stdin, with the cause on stderr", async () => {
  for (const text of ["", "   \n", "not-json"]) {
    await inScene(async (scene) => {
      const outcome = await runHandler(toolBeforeHandler, io(scene, text));
      assert.equal(outcome.rendered.stdout, deny("invalid-stdin"), JSON.stringify(text));
      assert.equal(outcome.rendered.exitCode, 0);
      assert.equal(outcome.failure, "invalid-stdin");
      assert.equal(scene.stderr.length, 1);
      assert.match(scene.stderr[0] ?? "", /^tlc: hook failure \(invalid-stdin\): /);
      assert.deepEqual(readdirSync(scene.cwd), [], "nothing is written under the working directory");
    });
  }
});

test("AGH-05: a payload no provider detects, another provider's payload, or an untranslated one is unrecognized-payload", async () => {
  await inScene(async (scene) => {
    const cursor = JSON.stringify({
      hook_event_name: "preToolUse",
      workspace_roots: [scene.root],
      tool_name: "Grep",
    });
    const claude = JSON.stringify({ hook_event_name: "PreToolUse", cwd: scene.root, tool_name: "Grep" });
    const viewFile = fixtureWhere("antigravity:PreToolUse", (event) => event.event === "read.before");
    const cases: [string, string][] = [
      [JSON.stringify({ nothing: true }), "antigravity:PreToolUse"],
      [cursor, "antigravity:PreToolUse"],
      [claude, "antigravity:PreToolUse"],
      [inWorkspace(viewFile, scene.root), "antigravity:PreInvocation"],
      [JSON.stringify({ ...viewFile, workspacePaths: [] }), "antigravity:PreToolUse"],
    ];
    for (const [text, token] of cases) {
      const outcome = await runHandler(toolBeforeHandler, io(scene, text, token));
      assert.equal(outcome.rendered.stdout, deny("unrecognized-payload"), `${token}: ${text.slice(0, 60)}`);
      assert.equal(outcome.failure, "unrecognized-payload");
    }
    assert.deepEqual(readdirSync(scene.cwd), []);
  });
});

test("AGH-79: an unrecognized diagnostic lands only under the payload's workspace, never under the working directory", async () => {
  await inScene(async (scene) => {
    const viewFile = fixtureWhere("antigravity:PreToolUse", (event) => event.event === "read.before");
    await runHandler(
      toolBeforeHandler,
      io(scene, inWorkspace(viewFile, scene.root), "antigravity:PostInvocation"),
    );
    const records = obsRecords(scene.root).filter((record) => record.kind === "adapter.unrecognized");
    assert.equal(records.length, 1);
    assert.deepEqual(records[0]?.attrs, { reason: "unrecognized-event", provider: "antigravity" });

    await runHandler(toolBeforeHandler, io(scene, JSON.stringify({ conversationId: 1 })));
    await runHandler(toolBeforeHandler, io(scene, "not-json"));
    assert.equal(obsRecords(scene.root).filter((record) => record.kind === "adapter.unrecognized").length, 1);
    assert.deepEqual(readdirSync(scene.cwd), []);
  });
});

test("AGH-06: a handler that throws is refused as handler-error and still records adapter.error", async () => {
  await inScene(async (scene) => {
    const viewFile = fixtureWhere("antigravity:PreToolUse", (event) => event.event === "read.before");
    const throwing: Handler = () => {
      throw new Error("boom");
    };
    const outcome = await runHandler(throwing, io(scene, inWorkspace(viewFile, scene.root)));
    assert.equal(outcome.rendered.stdout, deny("handler-error"));
    assert.equal(outcome.rendered.exitCode, 0);
    assert.equal(outcome.failure, "handler-error");
    assert.ok(obsRecords(scene.root).some((record) => record.kind === "adapter.error"));
    assert.deepEqual(readdirSync(scene.cwd), []);
  });
});

test("AGH-07: before a tool, each PreToolUse the real handler answers is exactly one allow or deny object", async () => {
  await inScene(async (scene) => {
    for (const pick of [
      (event: HarnessEvent) => event.event === "shell.before",
      (event: HarnessEvent) => event.event === "read.before",
      (event: HarnessEvent) => event.event === "tool.before",
    ]) {
      const outcome = await runHandler(
        toolBeforeHandler,
        io(scene, inWorkspace(fixtureWhere("antigravity:PreToolUse", pick), scene.root)),
      );
      const stdout = outcome.rendered.stdout ?? "";
      assert.notEqual(stdout, "");
      assert.notEqual(stdout.trim(), "{}");
      const parsed = JSON.parse(stdout) as { decision: string };
      assert.ok(parsed.decision === "allow" || parsed.decision === "deny", stdout);
      assert.equal(outcome.failure, undefined);
    }
  });
});

test("AGH-07: after a tool and at Stop, the real handlers' success is zero bytes, never {} nor an allow object", async () => {
  await inScene(async (scene) => {
    const cases: [Handler, string, (event: HarnessEvent) => boolean][] = [
      [toolAfterHandler, "antigravity:PostToolUse", (event) => event.event === "edit.after"],
      [toolAfterHandler, "antigravity:PostToolUse", (event) => event.event === "shell.after"],
      [toolAfterHandler, "antigravity:PostToolUse", (event) => event.event === "tool.after"],
      [stopHandler, "antigravity:Stop", (event) => event.event === "stop"],
    ];
    for (const [handler, token, pick] of cases) {
      const outcome = await runHandler(
        handler,
        io(scene, inWorkspace(fixtureWhere(token, pick), scene.root), token),
      );
      assert.equal(outcome.rendered.stdout, "", `${token}: ${JSON.stringify(outcome.rendered.stdout)}`);
      assert.equal(outcome.rendered.exitCode, 0);
      assert.equal(outcome.failure, undefined);
    }
  });
});

/** The entrypoint as the launcher runs it: its own process, the token in argv, the payload on stdin. */
function runEntrypoint(entry: string, token: string, stdin: string, cwd: string) {
  const result = spawnSync(process.execPath, [join(HERE, "..", `${entry}.ts`), token], {
    cwd,
    input: stdin,
    env: { ...process.env, TLC_HOME: runtimeSandbox },
  });
  return { stdout: result.stdout ?? Buffer.alloc(0), status: result.status };
}

test("AGH-07: run as its own process, an empty render writes zero bytes and a PreToolUse still writes one object", async () => {
  await inScene(async (scene) => {
    const after = inWorkspace(
      fixtureWhere("antigravity:PostToolUse", (event) => event.event === "tool.after"),
      scene.root,
    );
    const post = runEntrypoint("tool-after", "antigravity:PostToolUse", after, scene.cwd);
    assert.equal(post.status, 0);
    assert.equal(post.stdout.length, 0, `tool-after wrote ${JSON.stringify(post.stdout.toString())}`);

    const stop = runEntrypoint(
      "stop",
      "antigravity:Stop",
      inWorkspace(
        fixtureWhere("antigravity:Stop", (event) => event.event === "stop"),
        scene.root,
      ),
      scene.cwd,
    );
    assert.equal(stop.status, 0);
    assert.equal(stop.stdout.length, 0, `stop wrote ${JSON.stringify(stop.stdout.toString())}`);

    const before = inWorkspace(
      fixtureWhere("antigravity:PreToolUse", (event) => event.event === "read.before"),
      scene.root,
    );
    const pre = runEntrypoint("tool-before", "antigravity:PreToolUse", before, scene.cwd);
    assert.equal(pre.status, 0);
    assert.equal(pre.stdout.toString(), '{"decision":"allow"}\n');
  });
});

test("AGH-45: removing the workspace's .agents/hooks.json through a shell command is wiring-tamper", async () => {
  await inScene(async (scene) => {
    const shell = fixtureWhere("antigravity:PreToolUse", (event) => event.event === "shell.before");
    const text = inWorkspace(shell, scene.root, {
      CommandLine: "rm -Force ./.agents/hooks.json",
      Cwd: scene.root,
    });
    const outcome = await runHandler(toolBeforeHandler, io(scene, text));
    const parsed = JSON.parse(outcome.rendered.stdout ?? "{}") as { decision: string; reason: string };
    assert.equal(parsed.decision, "deny");
    assert.match(parsed.reason, /rule=wiring-tamper/);
  });
});

test("AGH-43 and AGH-44: a write to either protected hooks file is wiring-tamper under this host too", async () => {
  await inScene(async (scene) => {
    const write = fixtureWhere("antigravity:PreToolUse", (event) => event.toolName === "Write");
    const edit = fixtureWhere("antigravity:PreToolUse", (event) => event.toolName === "Edit");
    const targets = [antigravity().wiringTargets()[0] ?? "", join(scene.root, ".agents", "hooks.json")];
    for (const payload of [write, edit]) {
      for (const target of targets) {
        const outcome = await runHandler(
          toolBeforeHandler,
          io(scene, inWorkspace(payload, scene.root, { TargetFile: target })),
        );
        const parsed = JSON.parse(outcome.rendered.stdout ?? "{}") as { decision: string; reason: string };
        assert.equal(parsed.decision, "deny", target);
        assert.match(parsed.reason, /rule=wiring-tamper/, target);
      }
    }
  });
});

test("AGH-46: reading either protected hooks file is allowed", async () => {
  await inScene(async (scene) => {
    const read = fixtureWhere("antigravity:PreToolUse", (event) => event.event === "read.before");
    for (const target of [
      antigravity().wiringTargets()[0] ?? "",
      join(scene.root, ".agents", "hooks.json"),
    ]) {
      const outcome = await runHandler(
        toolBeforeHandler,
        io(scene, inWorkspace(read, scene.root, { AbsolutePath: target })),
      );
      assert.equal(outcome.rendered.stdout, '{"decision":"allow"}', target);
    }
  });
});

test("AGH-12: without a prefixed token the open posture of the other hosts is unchanged", async () => {
  for (const hostEvent of [null, "PreToolUse", "PostToolUse", "Stop"]) {
    await inScene(async (scene) => {
      for (const text of ["", "not-json", JSON.stringify({ nothing: true })]) {
        const outcome = await runHandler(toolBeforeHandler, io(scene, text, hostEvent));
        assert.equal(outcome.rendered.stdout, null, `${hostEvent}: ${JSON.stringify(text)}`);
        assert.equal(outcome.failure, undefined);
        assert.deepEqual(scene.stderr, []);
      }
    });
  }
});

test("AGH-12: a Cursor payload with a bare token still renders the Cursor way", async () => {
  await inScene(async (scene) => {
    const cursor = JSON.stringify({
      hook_event_name: "preToolUse",
      workspace_roots: [scene.root],
      tool_name: "Grep",
    });
    const outcome = await runHandler(toolBeforeHandler, io(scene, cursor, "PreToolUse"));
    assert.equal(outcome.event?.provider, "cursor");
    assert.equal(outcome.failure, undefined);
  });
});

test("AGH-81: run.ts carries no host literal; the refusal text comes from the adapter through the port", () => {
  const source = readFileSync(RUN_SOURCE, "utf8");
  for (const literal of ['"decision":"deny"', "tlc-harness: ", "antigravity", ".agents", "hooks.json"]) {
    assert.ok(!source.includes(literal), `run.ts contains ${literal}`);
  }
});

test("hostEventOf reads the token after the handler", () => {
  assert.equal(hostEventOf(["node", "tool-before.ts", "antigravity:Stop"]), "antigravity:Stop");
  assert.equal(hostEventOf(["node", "tool-before.ts"]), undefined);
});

test("AGH-78: two identical Stops each run the stop handler to the end, with no deduplication key", async () => {
  await inScene(async (scene) => {
    const idle = fixtureWhere("antigravity:Stop", (event) => event.event === "stop");
    let runs = 0;
    const counted: Handler = async (event, ctx) => {
      runs += 1;
      return stopHandler(event, ctx);
    };
    const text = inWorkspace(idle, scene.root);
    const first = await runHandler(counted, io(scene, text, "antigravity:Stop"));
    const second = await runHandler(counted, io(scene, text, "antigravity:Stop"));
    assert.equal(runs, 2);
    assert.deepEqual(scene.stderr, []);
    assert.equal(first.rendered.stdout, "");
    assert.equal(second.rendered.stdout, "");
    assert.equal(first.failure, undefined);
    assert.equal(second.failure, undefined);
  });
  for (const file of ["antigravity.inbound.ts", "antigravity.detect.ts", "antigravity.failure.ts"]) {
    const source = readFileSync(join(FIXTURE_DIR, "..", "..", file), "utf8");
    assert.ok(!source.includes("fullyIdle"), file);
    assert.ok(!/new (Set|Map)\b/.test(source), file);
  }
});

test("AGH-83: composeProtectedPaths joins every provider's targets with the project targets of the event's directory", () => {
  const paths = composeProtectedPaths(providers, "/w");
  for (const provider of providers) {
    for (const target of provider.wiringTargets()) {
      assert.ok(paths.includes(target), target);
    }
  }
  assert.ok(paths.includes(join("/w", ".agents", "hooks.json")));
});

/**
 * AGH-17, AGH-18 and AGH-23 as amended for path aliases: a Windows alias of a protected target is still that target.
 * The aliases are a Windows file system's, so off Windows there is nothing to alias.
 */
const windowsOnly = process.platform === "win32" ? false : "path aliases exist only on Windows";

function writeFixtures(): Payload[] {
  const token = "antigravity:PreToolUse";
  return [
    fixtureWhere(token, (event) => event.toolName === "Write"),
    fixtureWhere(token, (event) => event.toolName === "Edit"),
    fixtureWhere(token, (event) => event.toolName === "MultiEdit", true),
  ];
}

function assertWiringTamper(outcome: Awaited<ReturnType<typeof runHandler>>, label: string): void {
  const parsed = JSON.parse(outcome.rendered.stdout ?? "{}") as { decision?: string; reason?: string };
  assert.equal(parsed.decision, "deny", label);
  assert.match(parsed.reason ?? "", /rule=wiring-tamper/, label);
  assert.equal(outcome.failure, undefined, label);
}

test("AGH-17, AGH-18, AGH-23 (path alias): every alias of the workspace hooks file is wiring-tamper, with filePath raw", {
  skip: windowsOnly,
}, async (t) => {
  await inScene(async (scene) => {
    const target = join(scene.root, ".agents", "hooks.json");
    const scratch = dirname(scene.root);
    const link = join(scratch, "link");
    symlinkSync(scene.root, link, "junction");
    const aliases = [
      `\\\\?\\${target}`,
      `\\\\.\\${target}`,
      `${target}::$DATA`,
      `${target}.`,
      `${target} `,
      `${target}. .`,
      join(link, ".agents", "hooks.json"),
    ];
    const shortName = join(scratch, "WORKSP~1");
    if (existsSync(shortName)) {
      aliases.push(join(shortName, ".agents", "hooks.json"));
    } else {
      t.diagnostic("this volume generates no 8.3 short names; the short-name alias is not exercised");
    }
    for (const payload of writeFixtures()) {
      for (const alias of aliases) {
        const outcome = await runHandler(
          toolBeforeHandler,
          io(scene, inWorkspace(payload, scene.root, { TargetFile: alias })),
        );
        const label = `${outcome.event?.toolName}: ${alias}`;
        assertWiringTamper(outcome, label);
        assert.equal(outcome.event?.filePath, alias, label);
      }
    }
  });
});

function powershell(script: string) {
  return spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
}

/** `\\?\Volume{GUID}\` of the volume holding a path, as mountvol lists it. */
function volumeGuidRoot(path: string): string {
  const listed = powershell(`mountvol '${path.slice(0, 2)}\\' /L`);
  const root = listed.stdout.trim();
  assert.match(root, /^\\\\\?\\Volume\{[0-9a-f-]+\}\\$/i, `mountvol: ${listed.stderr}`);
  return root;
}

/** The NT device name of a drive (`\Device\HarddiskVolumeN`), or null when it cannot be read. */
function ntDeviceName(path: string): string | null {
  const read = powershell(
    [
      "Add-Type -Name Dos -Namespace TlcTest -MemberDefinition '[DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode)] public static extern uint QueryDosDeviceW(string d, System.Text.StringBuilder b, uint m);'",
      "$b = New-Object System.Text.StringBuilder 1024",
      `if ([TlcTest.Dos]::QueryDosDeviceW('${path.slice(0, 2)}', $b, 1024) -eq 0) { exit 1 }`,
      "[Console]::Out.Write($b.ToString())",
    ].join("; "),
  );
  const name = read.status === 0 ? read.stdout.trim() : "";
  return name.startsWith("\\Device\\") ? name : null;
}

test("AGH-17, AGH-18, AGH-23 (path alias): volume, case and middle-segment aliases of the workspace hooks file are wiring-tamper", {
  skip: windowsOnly,
}, async (t) => {
  await inScene(async (scene) => {
    const target = join(scene.root, ".agents", "hooks.json");
    const underRoot = target.slice(3);
    const aliases = [
      `${volumeGuidRoot(target)}${underRoot}`,
      join(scene.root, ".AGENTS", "Hooks.JSON"),
      target.toUpperCase(),
      `${scene.root}\\.agents.\\hooks.json`,
      `${scene.root}\\.agents \\hooks.json`,
    ];
    const device = ntDeviceName(target);
    if (device === null) {
      t.diagnostic("QueryDosDeviceW could not be read; the GLOBALROOT alias is not exercised");
    } else {
      aliases.push(`\\\\?\\GLOBALROOT${device}\\${underRoot}`);
    }
    assert.equal(
      existsSync(join(scene.root, ".agents")),
      false,
      "the aliases reach a target that does not exist yet",
    );
    for (const payload of writeFixtures()) {
      for (const alias of aliases) {
        const outcome = await runHandler(
          toolBeforeHandler,
          io(scene, inWorkspace(payload, scene.root, { TargetFile: alias })),
        );
        const label = `${outcome.event?.toolName}: ${alias}`;
        assertWiringTamper(outcome, label);
        assert.equal(outcome.event?.filePath, alias, label);
      }
    }
  });
});

test("AGH-06 (path alias): a volume GUID that does not exist on this machine is refused as handler-error", {
  skip: windowsOnly,
}, async () => {
  await inScene(async (scene) => {
    const alias = "\\\\?\\Volume{00000000-0000-0000-0000-000000000000}\\x\\.agents\\hooks.json";
    for (const payload of writeFixtures()) {
      const outcome = await runHandler(
        toolBeforeHandler,
        io(scene, inWorkspace(payload, scene.root, { TargetFile: alias })),
      );
      assert.equal(outcome.rendered.stdout, deny("handler-error"), alias);
      assert.equal(outcome.failure, "handler-error", alias);
    }
  });
});

test("AGH-17 (path alias): a junction in the protected target's own ancestor matches a TargetFile written through its destination", {
  skip: windowsOnly,
}, async () => {
  await inScene(async (scene) => {
    const scratch = dirname(scene.root);
    const realHome = join(scratch, "real-home");
    const linkedHome = join(scratch, "home-link");
    mkdirSync(realHome);
    symlinkSync(realHome, linkedHome, "junction");
    const previousProfile = process.env.USERPROFILE;
    process.env.USERPROFILE = linkedHome;
    try {
      assert.equal(antigravity().wiringTargets()[0], join(linkedHome, ".gemini", "config", "hooks.json"));
      const viaDestination = join(realHome, ".gemini", "config", "hooks.json");
      for (const payload of writeFixtures()) {
        const outcome = await runHandler(
          toolBeforeHandler,
          io(scene, inWorkspace(payload, scene.root, { TargetFile: viaDestination })),
        );
        assertWiringTamper(outcome, `${outcome.event?.toolName}: ${viaDestination}`);
        assert.equal(outcome.event?.filePath, viaDestination);
      }
    } finally {
      if (previousProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previousProfile;
      }
    }
  });
});

test("AGH-46 (path alias): the same aliases read through the read tool are not wiring-tamper", {
  skip: windowsOnly,
}, async () => {
  await inScene(async (scene) => {
    const target = join(scene.root, ".agents", "hooks.json");
    const read = fixtureWhere("antigravity:PreToolUse", (event) => event.event === "read.before");
    for (const alias of [
      `\\\\?\\${target}`,
      `\\\\.\\${target}`,
      `${target}::$DATA`,
      `${target}.`,
      `${target} `,
    ]) {
      const outcome = await runHandler(
        toolBeforeHandler,
        io(scene, inWorkspace(read, scene.root, { AbsolutePath: alias })),
      );
      assert.equal(outcome.rendered.stdout, '{"decision":"allow"}', alias);
    }
  });
});

test("AGH-06 (path alias): a canonical match that throws is refused as handler-error", async () => {
  const provider = antigravity();
  const original = provider.canonicalWiringMatch;
  assert.equal(typeof original, "function", "the adapter declares canonicalWiringMatch");
  provider.canonicalWiringMatch = () => {
    throw new Error("realpath refused");
  };
  try {
    await inScene(async (scene) => {
      const write = fixtureWhere("antigravity:PreToolUse", (event) => event.toolName === "Write");
      const outcome = await runHandler(
        toolBeforeHandler,
        io(scene, inWorkspace(write, scene.root, { TargetFile: join(scene.root, "src", "a.ts") })),
      );
      assert.equal(outcome.rendered.stdout, deny("handler-error"));
      assert.equal(outcome.failure, "handler-error");
      assert.ok(obsRecords(scene.root).some((record) => record.kind === "adapter.error"));
    });
  } finally {
    provider.canonicalWiringMatch = original;
  }
});

/** AGF-17 to AGF-25: the wiring routes the tool table does not show reach the floor through the port. */
const PRE = "antigravity:PreToolUse";

function shellPayload(root: string, command: string, cwd?: string): string {
  const shell = fixtureWhere(PRE, (event) => event.event === "shell.before");
  const args: Record<string, unknown> = { ...shell.toolCall?.args, CommandLine: command };
  if (cwd === undefined) {
    delete args.Cwd;
  } else {
    args.Cwd = cwd;
  }
  return JSON.stringify({ ...shell, workspacePaths: [root], toolCall: { ...shell.toolCall, args } });
}

function untranslatedPayload(root: string, name?: string, args?: Record<string, unknown>): string {
  const raw = JSON.parse(
    readFileSync(join(FIXTURE_DIR, "allow-PreToolUse-define_subagent--.json"), "utf8"),
  ) as Payload;
  const toolCall = raw.toolCall as { name: string; args: Record<string, unknown> };
  return JSON.stringify({
    ...raw,
    workspacePaths: [root],
    toolCall: { name: name ?? toolCall.name, args: args ?? toolCall.args },
  });
}

function cursorShell(root: string, command: string): string {
  return JSON.stringify({ hook_event_name: "beforeShellExecution", workspace_roots: [root], command });
}

async function decide(scene: Scene, text: string, token: string | null = PRE) {
  const outcome = await runHandler(toolBeforeHandler, io(scene, text, token));
  const parsed = JSON.parse(outcome.rendered.stdout ?? "{}") as { decision?: string; reason?: string };
  return { outcome, parsed, rule: /rule=([a-z-]+)/.exec(parsed.reason ?? "")?.[1] ?? null };
}

async function assertRule(scene: Scene, text: string, rule: string, label: string): Promise<void> {
  const { outcome, parsed, rule: found } = await decide(scene, text);
  assert.equal(parsed.decision, "deny", label);
  assert.equal(found, rule, label);
  assert.equal(outcome.failure, undefined, label);
}

async function assertShellAllowed(scene: Scene, command: string, cwd: string | undefined): Promise<void> {
  const { outcome } = await decide(scene, shellPayload(scene.root, command, cwd));
  assert.equal(outcome.rendered.stdout, '{"decision":"allow"}', `${cwd ?? "(no Cwd)"}: ${command}`);
}

const backslashOnly =
  process.platform === "win32"
    ? false
    : "a \\ separates path segments only on Windows, so off it these reach no target (AGF-22c)";

const EXTERNAL = resolve("/tlc-outside-project/x");

test("AGF-17: an untranslated tool naming a protected hooks file in any string argument is wiring-tamper", async () => {
  await inScene(async (scene) => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["edit_file", { path: "C:\\w\\.agents\\hooks.json" }],
      ["mcp_fs_write", { target: { file: "~/.gemini/config/hooks.json" } }],
      ["define_subagent", { name: "probe", system_prompt: "then write .agents/hooks.json" }],
      ["x_tool", { files: ["a.txt", "%USERPROFILE%\\.gemini\\config\\hooks.json"] }],
    ];
    for (const [name, args] of cases) {
      await assertRule(scene, untranslatedPayload(scene.root, name, args), "wiring-tamper", name);
    }
  });
});

test("AGF-18: an untranslated tool naming no protected file keeps its c31f3d4 allow", async () => {
  await inScene(async (scene) => {
    const { outcome } = await decide(scene, untranslatedPayload(scene.root));
    assert.equal(outcome.rendered.stdout, '{"decision":"allow"}');
  });
});

test("AGF-20, AGF-23: a command run in the workspace's .agents reaches its hooks file", async () => {
  await inScene(async (scene) => {
    for (const cwd of [join(scene.root, ".agents"), ".agents"]) {
      for (const command of [
        "rm -Force ./hooks.json",
        "del hooks.json",
        "echo {} > hooks.json",
        "Set-Content hooks.json '{}'",
      ]) {
        await assertRule(
          scene,
          shellPayload(scene.root, command, cwd),
          "wiring-tamper",
          `${cwd}: ${command}`,
        );
      }
    }
    await assertRule(
      scene,
      shellPayload(scene.root, "rm -Force ./.agents/hooks.json"),
      "wiring-tamper",
      "no Cwd",
    );
  });
});

test("AGF-20, AGF-21, AGF-22b, AGF-22c: the backslash forms reach the hooks files on Windows", {
  skip: backslashOnly,
}, async () => {
  await inScene(async (scene) => {
    const cases: Array<[string | undefined, string]> = [
      [join(scene.root, ".agents"), "Remove-Item -Force .\\hooks.json"],
      [`${scene.root}\\.Agents`, "Remove-Item -Force .\\HOOKS.JSON"],
      ["~/.gemini/config", "Remove-Item -Force .\\hooks.json"],
      [`${scene.root}\\.agents`, "Remove-Item -Recurse -Force ."],
      [undefined, "Move-Item .agents\\hooks.json x"],
    ];
    for (const [cwd, command] of cases) {
      await assertRule(
        scene,
        shellPayload(scene.root, command, cwd),
        "wiring-tamper",
        `${cwd ?? "(no Cwd)"}: ${command}`,
      );
    }
  });
});

test("AGF-22: relative operands resolve against the Cwd in every rule, without realpath", async () => {
  await inScene(async (scene) => {
    await assertRule(
      scene,
      shellPayload(scene.root, "Get-Content id_rsa", "~/.ssh"),
      "secret-access",
      "~/.ssh",
    );
    await assertRule(
      scene,
      shellPayload(scene.root, "Remove-Item -Recurse -Force .\\x", dirname(EXTERNAL)),
      "outside-project-destruction",
      "outside Cwd",
    );
    const { rule } = await decide(
      scene,
      shellPayload(scene.root, "rm -Force ./hooks.json", join(scene.root, "docs")),
    );
    assert.notEqual(rule, "wiring-tamper");
  });
});

test("AGF-22a: an unresolvable Cwd decides by the file name, relative destruction, relative moves, then as $X/", async () => {
  await inScene(async (scene) => {
    const denied: Array<[string, string, string]> = [
      ["$HOME/.gemini/config", "Remove-Item -Force .\\hooks.json", "wiring-tamper"],
      ["%USERPROFILE%\\.gemini\\config", "echo {} > hooks.json", "wiring-tamper"],
      ["$env:USERPROFILE\\.gemini\\config", "Set-Content HOOKS.JSON '{}'", "wiring-tamper"],
      ["$env:TEMP", "Remove-Item -Recurse .\\x", "unprovable-destruction"],
      ["$HOME/.gemini", "Move-Item config config-old", "wiring-tamper"],
      ["$HOME/.gemini", "ren config x", "wiring-tamper"],
      ["$HOME/.gemini", "mv config x", "wiring-tamper"],
      ["$PWD", "Move-Item .agents x", "wiring-tamper"],
      ["%CD%", "Rename-Item .agents x", "wiring-tamper"],
      ["$HOME", `Remove-Item -Recurse -Force ${EXTERNAL}`, "outside-project-destruction"],
    ];
    for (const [cwd, command, rule] of denied) {
      await assertRule(scene, shellPayload(scene.root, command, cwd), rule, `${cwd}: ${command}`);
    }
    for (const [cwd, command] of [
      ["$HOME/.ssh", "Get-Content id_rsa"],
      ["$HOME/.gemini", "Copy-Item x.json config"],
      ["$PWD", "cat .env"],
    ]) {
      await assertShellAllowed(scene, command as string, cwd);
    }
  });
});

test("AGF-22b: destroying or moving a protected ancestor is wiring-tamper", async () => {
  await inScene(async (scene) => {
    for (const command of [
      "Remove-Item -Recurse -Force .agents",
      "rd /s /q .agents",
      "rm -rf .agents",
      "Move-Item .agents old-agents",
      "mv .agents x",
      "Rename-Item .agents x",
      "ren .agents x",
      "Move-Item ~/.gemini/config ~/.gemini/config-old",
      "Remove-Item -Recurse -Force ~/.gemini",
    ]) {
      await assertRule(scene, shellPayload(scene.root, command), "wiring-tamper", command);
    }
    const { rule } = await decide(
      scene,
      shellPayload(scene.root, "Remove-Item -Recurse -Force .agents/skills"),
    );
    assert.notEqual(rule, "wiring-tamper");
  });
});

test("AGF-22c: protected targets and ancestors compare without case on every system", async () => {
  await inScene(async (scene) => {
    await assertRule(
      scene,
      shellPayload(scene.root, "rm -Force ./.AGENTS/Hooks.Json"),
      "wiring-tamper",
      "no Cwd",
    );
    await assertRule(
      scene,
      shellPayload(scene.root, "del HOOKS.json", "~/.GEMINI/Config"),
      "wiring-tamper",
      "Cwd",
    );
    await assertRule(
      scene,
      shellPayload(scene.root, "Remove-Item -Recurse -Force .Agents"),
      "wiring-tamper",
      "ancestor",
    );
  });
});

test("AGF-24: the same commands from a Cursor event keep the c31f3d4 decision", async () => {
  await inScene(async (scene) => {
    for (const command of [
      "Remove-Item -Recurse -Force .agents",
      "rm ./.AGENTS/hooks.json",
      "rm -rf .agents",
      "mv .agents x",
      "Remove-Item -Recurse -Force .Agents",
    ]) {
      const { outcome, rule } = await decide(scene, cursorShell(scene.root, command), null);
      assert.equal(outcome.event?.provider, "cursor", command);
      assert.notEqual(rule, "wiring-tamper", command);
    }
  });
});

test("AGF-22d: device prefix, trailing dot and space, 8.3 and a real junction reach the hooks files through the canonical form", {
  skip: windowsOnly,
}, async (t) => {
  await inScene(async (scene) => {
    assert.match(basename(homedir()), /^tlc-test-home-dir-/, "the junction target lives in the fake home");
    const config = join(homedir(), ".gemini", "config");
    mkdirSync(config, { recursive: true });
    try {
      const agents = join(scene.root, ".agents");
      const cases: Array<[string | undefined, string]> = [
        [`\\\\?\\${agents}`, "Set-Content hooks.json '{}'"],
        [`${agents}.`, "echo {} > hooks.json"],
        [`${agents} `, "Remove-Item -Force .\\hooks.json"],
      ];
      const shortName = join(homedir(), "GEMINI~1", "config");
      if (existsSync(shortName)) {
        cases.push([shortName, "Set-Content hooks.json '{}'"]);
      } else {
        t.diagnostic("this volume generates no 8.3 short names; the short-name Cwd is not exercised");
      }
      const junction = join(scene.root, "j");
      symlinkSync(config, junction, "junction");
      cases.push(
        [junction, "Set-Content hooks.json '{}'"],
        [undefined, "Set-Content .\\j\\hooks.json '{}'"],
        [undefined, "Remove-Item -Recurse -Force .\\j"],
        [junction, "Remove-Item -Recurse -Force ."],
      );
      for (const [cwd, command] of cases) {
        await assertRule(
          scene,
          shellPayload(scene.root, command, cwd),
          "wiring-tamper",
          `${cwd ?? "(no Cwd)"}: ${command}`,
        );
      }
      await assertShellAllowed(scene, "Get-ChildItem", junction);
      for (const command of ["Set-Content .\\j\\hooks.json '{}'", "Remove-Item -Recurse -Force .\\j"]) {
        const { rule } = await decide(scene, cursorShell(scene.root, command), null);
        assert.notEqual(rule, "wiring-tamper", `cursor: ${command}`);
      }
    } finally {
      rmSync(join(homedir(), ".gemini"), { recursive: true, force: true });
    }
  });
});

test("AGF-22d, AGH-06: a canonical form that throws is refused as handler-error", async () => {
  const provider = antigravity();
  const original = provider.floorHostFacts;
  assert.equal(typeof original, "function", "the adapter declares floorHostFacts");
  provider.floorHostFacts = (event, protectedPaths) => {
    const facts = original?.call(provider, event, protectedPaths) ?? null;
    return facts === null
      ? null
      : {
          ...facts,
          canonical: () => {
            throw new Error("no resolvable ancestor");
          },
        };
  };
  try {
    await inScene(async (scene) => {
      const { outcome } = await decide(scene, shellPayload(scene.root, "Remove-Item -Force ./x", scene.root));
      assert.equal(outcome.rendered.stdout, deny("handler-error"));
      assert.equal(outcome.failure, "handler-error");
      assert.ok(obsRecords(scene.root).some((record) => record.kind === "adapter.error"));
    });
  } finally {
    provider.floorHostFacts = original;
  }
});
