import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CAPTURES_DIR } from "./captures.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "fixtures");
const PROVENANCE = readFileSync(join(HERE, "PROVENANCE.md"), "utf8");

const TOOLS = [
  "define_subagent",
  "invoke_subagent",
  "replace_file_content",
  "run_command",
  "view_file",
  "write_to_file",
];

const CAPTURED_FIXTURES = [
  ...TOOLS.map((tool) => `allow-PreToolUse-${tool}--.json`),
  ...TOOLS.map((tool) => `allow-PostToolUse-${tool}--.json`),
  "allow-Stop--NO_TOOL_CALL-.json",
  "allow-Stop--NO_TOOL_CALL-idle.json",
  "allow-PreInvocation---.json",
  "allow-PostInvocation---.json",
];

const SYNTHETIC = "synthetic-PreToolUse-multi_replace_file_content--.json";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const USER_SEGMENT = /[\\/]Users[\\/]([^\\/]+)/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The two redaction rules from PROVENANCE.md, applied to a capture. The account segment is read from the capture's
 * own workspace path, so no account name is written into this repository.
 */
function redact(value: unknown, account: RegExp): unknown {
  if (typeof value === "string") {
    return value.replace(UUID, "<id>").replace(account, "$1Users$2dev");
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, account));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, account)]));
  }
  return value;
}

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));
}

test("AGH-51: the fixture directory holds every required capture and the one synthetic", () => {
  assert.deepEqual(readdirSync(FIXTURE_DIR).sort(), [...CAPTURED_FIXTURES, SYNTHETIC].sort());
});

test("AGH-51: each fixture equals its capture's stdin after exactly the two redactions", {
  skip: !existsSync(CAPTURES_DIR),
}, () => {
  for (const name of CAPTURED_FIXTURES) {
    const capture = JSON.parse(readFileSync(join(CAPTURES_DIR, name), "utf8")) as {
      stdin: { workspacePaths: string[] };
    };
    const segment = USER_SEGMENT.exec(capture.stdin.workspacePaths[0] ?? "")?.[1];
    assert.ok(segment !== undefined, `${name}: the capture's workspace names a user segment`);
    const account = new RegExp(`([\\\\/])Users([\\\\/])${escapeRegExp(segment)}(?=[\\\\/]|$)`, "g");
    assert.deepEqual(fixture(name), redact(capture.stdin, account), name);
  }
});

test("AGH-51: no fixture carries an account segment other than the placeholder", () => {
  for (const name of readdirSync(FIXTURE_DIR)) {
    const text = readFileSync(join(FIXTURE_DIR, name), "utf8");
    for (const match of text.matchAll(/[\\/]Users(?:\\\\|[\\/])([^\\/"]+)/g)) {
      assert.equal(match[1], "dev", `${name}: ${match[0]}`);
    }
  }
});

test("AGH-23: the synthetic fixture is the captured replace payload with only the tool name changed", () => {
  const base = fixture("allow-PreToolUse-replace_file_content--.json") as { toolCall: { name: string } };
  const synthetic = fixture(SYNTHETIC) as { toolCall: { name: string } };
  assert.notEqual(synthetic.toolCall.name, base.toolCall.name);
  assert.deepEqual({ ...synthetic, toolCall: { ...synthetic.toolCall, name: base.toolCall.name } }, base);
});

test("AGH-53: PROVENANCE records the source, both redaction rules and the two notes", () => {
  for (const needle of [
    "`agy` CLI 1.2.13",
    "Windows 10.0.19045",
    "print mode",
    "`gemini-3.8-flash-high`",
    "2026-09-29",
    ".specs/features/tlc-harness-antigravity/captures/",
    "Identifiers become `<id>`",
    "The user segment `MCorsato` becomes `dev`",
    "forward-slash form",
    "backslash form",
    "applying both rules",
    "**synthetic**, unverified",
    "the stdin the hook received, not the stdout the hook wrote",
    "Q3",
    "keeps only the last occurrence",
    "The stdin captures are from `agy` 1.2.13",
    "measured on `agy` 1.2.14, print mode, the CLI's default model, on 2026-09-30",
    "AD-048",
  ]) {
    assert.ok(PROVENANCE.includes(needle), `PROVENANCE.md lacks: ${needle}`);
  }
});

test("AGH-53: PROVENANCE maps every fixture to its capture", () => {
  for (const name of [...CAPTURED_FIXTURES, SYNTHETIC]) {
    assert.ok(PROVENANCE.includes(`| \`${name}\` |`), `PROVENANCE.md has no row for ${name}`);
  }
});

test("AGH-52: the goldens are traced to Q3 and to the captures that corroborate them", () => {
  assert.ok(PROVENANCE.includes("`golden/allow.json`"));
  assert.ok(PROVENANCE.includes("`golden/deny.json`"));
  assert.ok(PROVENANCE.includes("`allow-PostToolUse-*`"));
  assert.ok(PROVENANCE.includes("`deny-PreToolUse-view_file--.json` exists and no `deny-PostToolUse-*`"));
});
