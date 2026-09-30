import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { HarnessEvent } from "../../contracts/index.ts";
import { projectStateDir } from "../../platform/paths.ts";
import { type ProviderPort, providers } from "../../providers/index.ts";
import { composeProtectedPaths, type Handler, hostEventOf, runHandler } from "../run.ts";
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

function fixtureWhere(token: string, matches: (event: HarnessEvent) => boolean): Payload {
  for (const name of readdirSync(FIXTURE_DIR)) {
    if (name.startsWith("synthetic-")) {
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

test("AGH-07: a translated call renders exactly one allow or deny object, never {} or empty", async () => {
  await inScene(async (scene) => {
    for (const [token, pick] of [
      ["antigravity:PreToolUse", (event: HarnessEvent) => event.event === "shell.before"],
      ["antigravity:PostToolUse", (event: HarnessEvent) => event.event === "edit.after"],
      ["antigravity:Stop", (event: HarnessEvent) => event.event === "stop"],
    ] as const) {
      const outcome = await runHandler(
        toolBeforeHandler,
        io(scene, inWorkspace(fixtureWhere(token, pick), scene.root), token),
      );
      const stdout = outcome.rendered.stdout ?? "";
      assert.notEqual(stdout.trim(), "");
      assert.notEqual(stdout.trim(), "{}");
      const parsed = JSON.parse(stdout) as { decision: string };
      assert.ok(parsed.decision === "allow" || parsed.decision === "deny", token);
      assert.equal(outcome.failure, undefined);
    }
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

test("composeProtectedPaths joins every provider's targets with the project targets of the event's directory", () => {
  const paths = composeProtectedPaths(providers, "/w");
  for (const provider of providers) {
    for (const target of provider.wiringTargets()) {
      assert.ok(paths.includes(target), target);
    }
  }
  assert.ok(paths.includes(join("/w", ".agents", "hooks.json")));
});
