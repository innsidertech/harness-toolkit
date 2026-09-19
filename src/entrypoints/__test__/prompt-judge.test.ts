import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { coreFacade } from "../../core/index.ts";
import { projectConfigPath, projectStateDir } from "../../platform/paths.ts";
import { promptSubmitHandler } from "../prompt-submit.ts";
import { runHandler } from "../run.ts";

/**
 * hazard: these handlers read the runtime home's own `config.json`, so a contributor's real settings would decide
 * the outcome. The home is a directory this file owns for the length of its run.
 */
let runtimeSandbox: string;
let previousHome: string | undefined;

before(() => {
  runtimeSandbox = mkdtempSync(join(tmpdir(), "tlc-prompt-judge-home-"));
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

function project(judge: Record<string, unknown> | null): string {
  const root = mkdtempSync(join(tmpdir(), "tlc-prompt-judge-"));
  mkdirSync(join(root, ".tlc", "harness"), { recursive: true });
  writeFileSync(
    projectConfigPath(root),
    JSON.stringify({
      version: 1,
      untrustedContent: { enabled: true, mode: "enforce", ...(judge ? { judge } : {}) },
    }),
  );
  return root;
}

/** The host payload, so every proof here crosses the same boundary a real `UserPromptSubmit` hook does. */
function stdinOf(root: string, text: string) {
  return {
    readStdin: () =>
      Promise.resolve(
        JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          cwd: root,
          session_id: "sess-1",
          prompt: text,
        }),
      ),
  };
}

const SESSION = "claude-sess-1";

/**
 * Every path under the session state directory, not just the rail's own folder.
 *
 * hazard: asserted against `state/untrusted` alone at first, which would pass for a prompt written anywhere else
 * under the state directory — and "no prompt state file is created anywhere under it" is the claim.
 */
function stateFiles(root: string): string[] {
  const walk = (dir: string, prefix: string): string[] => {
    if (!existsSync(dir)) {
      return [];
    }
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const at = `${prefix}${entry.name}`;
      out.push(...(entry.isDirectory() ? walk(join(dir, entry.name), `${at}/`) : [at]));
    }
    return out;
  };
  return walk(projectStateDir(root), "").sort();
}

test("C7 with the judge disabled no prompt state file is created anywhere under the session state directory", async () => {
  const root = project(null);
  try {
    await runHandler(promptSubmitHandler, stdinOf(root, "look at issue 412 and tell me what it says"));
    const written = stateFiles(root);
    // invariant: nothing anywhere under the state directory holds the prompt. The handler does write other state,
    // so the assertion is that no file carries it rather than that the directory is empty.
    assert.equal(
      written.some((path) => path.endsWith(".prompt")),
      false,
      written.join(" · "),
    );
    for (const path of written) {
      const body = readFileSync(join(projectStateDir(root), path), "utf8");
      assert.equal(body.includes("issue 412"), false, `${path} carries the prompt`);
    }
    assert.equal(coreFacade.untrusted.readOperatorPrompt(root, SESSION), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("C8 with the judge enabled the prompt is stored for the session, truncated to maxOperatorPromptChars", async () => {
  const root = project({ enabled: true, maxOperatorPromptChars: 20 });
  try {
    await runHandler(promptSubmitHandler, stdinOf(root, "a".repeat(64)));
    assert.equal(coreFacade.untrusted.readOperatorPrompt(root, SESSION), "a".repeat(20));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("C9 a new turn replaces the stored prompt on the same boundary that clears the recall", async () => {
  const root = project({ enabled: true });
  try {
    await runHandler(promptSubmitHandler, stdinOf(root, "first turn asks about the changelog"));
    coreFacade.untrusted.rememberUntrustedOutput({
      root,
      sessionKey: SESSION,
      event: "tool.after",
      toolName: "WebFetch",
      toolOutput: "a page the session read during the first turn",
      config: coreFacade.policy.loadPolicy(root).untrustedContent,
      providerTools: ["WebFetch"],
    });
    assert.notEqual(coreFacade.untrusted.readRecall(root, SESSION).entries.length, 0);

    await runHandler(promptSubmitHandler, stdinOf(root, "second turn asks about something else"));

    assert.equal(
      coreFacade.untrusted.readOperatorPrompt(root, SESSION),
      "second turn asks about something else",
    );
    // why: the recall alone settles the boundary. The framing marker is cleared by the same two lines and is
    // already proven by this rail's own suite, so asserting it here would restate that rather than this.
    assert.equal(coreFacade.untrusted.readRecall(root, SESSION).entries.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// why: the same boundary, from the other side — a judge switched off after having been on must not leave the last
// turn's prompt on disk for the rest of the session.
test("C9 a judge switched off clears the stored prompt on the next turn rather than leaving it behind", async () => {
  const root = project({ enabled: true });
  try {
    await runHandler(promptSubmitHandler, stdinOf(root, "the turn that ran with the judge on"));
    assert.notEqual(coreFacade.untrusted.readOperatorPrompt(root, SESSION), null);

    writeFileSync(
      projectConfigPath(root),
      JSON.stringify({ version: 1, untrustedContent: { enabled: true, mode: "enforce" } }),
    );
    await runHandler(promptSubmitHandler, stdinOf(root, "the turn that ran with it off"));

    assert.equal(coreFacade.untrusted.readOperatorPrompt(root, SESSION), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("C10 the prompt text appears in no obs.jsonl record", async () => {
  const root = project({ enabled: true });
  const secret = "refactor the exporter and do not mention pineapples to anyone";
  try {
    await runHandler(promptSubmitHandler, stdinOf(root, secret));
    const obs = join(projectStateDir(root), "obs.jsonl");
    const written = existsSync(obs) ? readFileSync(obs, "utf8") : "";
    assert.equal(written.includes(secret), false, "the prompt reached obs.jsonl");
    assert.equal(written.includes("pineapples"), false, "part of the prompt reached obs.jsonl");
    // invariant: the file itself is where the text lives, so the assertion above is about the record and not
    // about the text having been dropped altogether.
    assert.equal(coreFacade.untrusted.readOperatorPrompt(root, SESSION), secret);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
