import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { providers, resolveFromRegistry } from "../../provider.registry.ts";
import { detectAntigravity } from "../antigravity.detect.ts";
import { CAPTURES_DIR } from "./captures.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROVIDERS_DIR = join(HERE, "..", "..");

function jsonFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? jsonFiles(join(dir, entry.name))
      : entry.name.endsWith(".json")
        ? [join(dir, entry.name)]
        : [],
  );
}

test("AGH-13: detect is true for a payload with conversationId, workspacePaths and transcriptPath", () => {
  assert.equal(detectAntigravity({ conversationId: "c", workspacePaths: [], transcriptPath: "t" }), true);
  for (const file of jsonFiles(join(HERE, "fixtures"))) {
    assert.equal(detectAntigravity(JSON.parse(readFileSync(file, "utf8"))), true, file);
  }
});

test("AGH-13: detect is false when any of the three fields is missing or mistyped", () => {
  const whole = { conversationId: "c", workspacePaths: [], transcriptPath: "t" };
  for (const broken of [
    { ...whole, conversationId: 1 },
    { ...whole, workspacePaths: "w" },
    { ...whole, transcriptPath: null },
    null,
    "text",
    [whole],
  ]) {
    assert.equal(detectAntigravity(broken), false, JSON.stringify(broken));
  }
});

test("AGH-13: detect is false for every Cursor and Claude fixture", () => {
  const files = [
    ...jsonFiles(join(PROVIDERS_DIR, "cursor", "__test__", "fixtures")),
    ...jsonFiles(join(PROVIDERS_DIR, "claude", "__test__", "fixtures")),
  ];
  assert.ok(files.length > 0, "the other providers' fixtures were found");
  for (const file of files) {
    assert.equal(detectAntigravity(JSON.parse(readFileSync(file, "utf8"))), false, file);
  }
});

test("AGH-14: the registry order is cursor, claude, antigravity, codex", () => {
  assert.deepEqual(
    providers.map((provider) => provider.name),
    ["cursor", "claude", "antigravity", "codex"],
  );
});

test("AGH-14: no fixture resolves ambiguously, and each resolves to antigravity", () => {
  for (const file of jsonFiles(join(HERE, "fixtures"))) {
    const result = resolveFromRegistry(JSON.parse(readFileSync(file, "utf8")), providers);
    assert.equal(result.ambiguous, false, file);
    assert.equal(result.provider?.name, "antigravity", file);
  }
});

test("AGH-14: none of the 48 captured payloads resolves ambiguously", {
  skip: !existsSync(CAPTURES_DIR),
}, () => {
  const files = readdirSync(CAPTURES_DIR).filter((name) => name.endsWith(".json"));
  assert.equal(files.length, 48);
  for (const name of files) {
    const capture = JSON.parse(readFileSync(join(CAPTURES_DIR, name), "utf8")) as { stdin: unknown };
    const result = resolveFromRegistry(capture.stdin, providers);
    assert.equal(result.ambiguous, false, name);
    assert.equal(result.provider?.name, "antigravity", name);
  }
});
