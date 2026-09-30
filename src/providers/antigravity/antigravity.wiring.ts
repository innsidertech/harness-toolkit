import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ProviderWiring, RuntimePaths, WiringEntry } from "../../contracts/index.ts";
import { commandTokens, type WiringProblem } from "../cursor/cursor.wiring.ts";
import {
  ANTIGRAVITY_TIMEOUT_SECONDS,
  type AntigravityHostEvent,
  hostEventToken,
} from "./antigravity.events.ts";
import {
  antigravityCliDir,
  antigravityGlobalHooksPath,
  antigravityWorkspaceHooksPath,
} from "./antigravity.paths.ts";

/**
 * why a named group: the global file is shared with every surface of the host and with the operator's own hooks,
 * and the host keys groups by name. Owning one key is what lets install, reinstall, and uninstall leave every other
 * byte alone ([/decisions/ad-156.md](/decisions/ad-156.md)).
 */
export const ANTIGRAVITY_GROUP_NAME = "tlc-harness";

type EntrySpec = { hookEvent: AntigravityHostEvent; handler: string; matcher?: string };

const ENTRY_SPECS: readonly EntrySpec[] = [
  { hookEvent: "PreToolUse", handler: "tool-before", matcher: ".*" },
  { hookEvent: "PostToolUse", handler: "tool-after", matcher: ".*" },
  { hookEvent: "Stop", handler: "stop" },
];

export function antigravityWiring(runtime: RuntimePaths): ProviderWiring {
  const entries: WiringEntry[] = ENTRY_SPECS.map((spec) => ({
    hookEvent: spec.hookEvent,
    handler: spec.handler,
    command: "node",
    args: [runtime.launcherPath, spec.handler, hostEventToken(spec.hookEvent)],
    timeoutSeconds: ANTIGRAVITY_TIMEOUT_SECONDS[spec.hookEvent],
    ...(spec.matcher !== undefined ? { matcher: spec.matcher } : {}),
  }));
  return {
    target: antigravityGlobalHooksPath(),
    strategy: "named-group",
    entries,
    presencePath: antigravityCliDir(),
  };
}

export function antigravityWiringTargets(): string[] {
  return [antigravityGlobalHooksPath()];
}

export function antigravityProjectWiringTargets(projectDir: string): string[] {
  return [antigravityWorkspaceHooksPath(projectDir)];
}

/**
 * hazard: the command is joined unquoted, because the host splits it on spaces with no quoting rule anyone has
 * measured. A launcher path with a space is refused by `applyAntigravityWiring` rather than quoted on a guess.
 */
export function renderAntigravityGroup(entries: readonly WiringEntry[]): Record<string, unknown> {
  const group: Record<string, unknown> = {};
  for (const entry of entries) {
    const hook = {
      type: "command",
      command: [entry.command, ...entry.args].join(" "),
      timeout: entry.timeoutSeconds,
    };
    group[entry.hookEvent] =
      entry.matcher !== undefined ? [{ matcher: entry.matcher, hooks: [hook] }] : [hook];
  }
  return group;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isPlainRecord(a) && isPlainRecord(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return (
      aKeys.length === bKeys.length && aKeys.every((key) => bKeys.includes(key) && deepEqual(a[key], b[key]))
    );
  }
  return false;
}

function serialise(document: Record<string, unknown>): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

type ParsedDocument = { ok: true; document: Record<string, unknown> | null } | { ok: false; error: string };

function parseDocument(text: string | null): ParsedDocument {
  if (text === null || text.trim() === "") {
    return { ok: true, document: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!isPlainRecord(parsed)) {
    return { ok: false, error: "hooks.json root is not a JSON object" };
  }
  return { ok: true, document: parsed };
}

export function mergeAntigravityGroup(
  existingText: string | null,
  entries: readonly WiringEntry[],
): { ok: true; text: string; changed: boolean } | { ok: false; error: string } {
  const parsed = parseDocument(existingText);
  if (!parsed.ok) {
    return parsed;
  }
  const group = renderAntigravityGroup(entries);
  const document = parsed.document ?? {};
  if (parsed.document !== null && deepEqual(document[ANTIGRAVITY_GROUP_NAME], group)) {
    return { ok: true, text: existingText ?? "", changed: false };
  }
  // invariant: rebuilt key by key so ours is replaced where it stood and every other key keeps its position.
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    next[key] = key === ANTIGRAVITY_GROUP_NAME ? group : value;
  }
  next[ANTIGRAVITY_GROUP_NAME] = group;
  return { ok: true, text: serialise(next), changed: true };
}

export type AntigravityApply =
  | { status: "merged" | "unchanged"; target: string }
  | { status: "failed" | "refused"; target: string; reason: string };

export function applyAntigravityWiring(wiring: ProviderWiring): AntigravityApply {
  const target = wiring.target;
  const launcherPath = wiring.entries[0]?.args[0] ?? "";
  if (launcherPath.includes(" ")) {
    return {
      status: "refused",
      target,
      reason: `launcher path contains a space — not wiring antigravity: ${launcherPath}`,
    };
  }
  let existingText: string | null;
  try {
    existingText = existsSync(target) ? readFileSync(target, "utf8") : null;
  } catch (error) {
    return { status: "failed", target, reason: error instanceof Error ? error.message : String(error) };
  }
  const result = mergeAntigravityGroup(existingText, wiring.entries);
  if (!result.ok) {
    return { status: "failed", target, reason: result.error };
  }
  if (!result.changed) {
    return { status: "unchanged", target };
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, result.text, "utf8");
  return { status: "merged", target };
}

export type AntigravityUnwire =
  | { kind: "absent" }
  | { kind: "unparsed" }
  | { kind: "empty" }
  | { kind: "rewritten"; text: string };

/** The inverse of `mergeAntigravityGroup`: only our key leaves, and every other key keeps value and position. */
export function unwireAntigravityHooks(text: string | null): AntigravityUnwire {
  const parsed = parseDocument(text);
  if (!parsed.ok) {
    return { kind: "unparsed" };
  }
  const document = parsed.document;
  if (document === null || !Object.hasOwn(document, ANTIGRAVITY_GROUP_NAME)) {
    return { kind: "absent" };
  }
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if (key !== ANTIGRAVITY_GROUP_NAME) {
      next[key] = value;
    }
  }
  if (Object.keys(next).length === 0) {
    return { kind: "empty" };
  }
  return { kind: "rewritten", text: serialise(next) };
}

function commandsIn(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const commands: string[] = [];
  for (const row of value) {
    if (!isPlainRecord(row)) {
      continue;
    }
    if (typeof row.command === "string") {
      commands.push(row.command);
    }
    if (Array.isArray(row.hooks)) {
      commands.push(...commandsIn(row.hooks));
    }
  }
  return commands;
}

function eventProblem(
  group: Record<string, unknown>,
  expected: Record<string, unknown>,
  entry: WiringEntry,
  runtime: RuntimePaths,
  fileExists: (path: string) => boolean,
): string | null {
  const commands = commandsIn(group[entry.hookEvent]).filter((command) =>
    commandTokens(command).includes(runtime.launcherPath),
  );
  if (commands.length === 0) {
    return "no harness entry";
  }
  const token = hostEventToken(entry.hookEvent as AntigravityHostEvent);
  if (!commands.every((command) => commandTokens(command).includes(token))) {
    return `command lacks ${token}`;
  }
  if (!fileExists(runtime.launcherPath)) {
    return `the script does not exist: ${runtime.launcherPath}`;
  }
  if (!deepEqual(group[entry.hookEvent], expected[entry.hookEvent])) {
    return "differs from what install writes";
  }
  return null;
}

/**
 * invariant: `wired` means the group is exactly what install writes. The host runs every command it finds, and a
 * group that differs in a token or a timeout is one this harness never tested.
 */
export function antigravityWiringProblems(
  text: string | null,
  runtime: RuntimePaths,
  fileExists: (path: string) => boolean,
): WiringProblem[] {
  if (text === null) {
    return [{ hookEvent: "(file)", reason: "no hooks file at the expected path" }];
  }
  const parsed = parseDocument(text);
  if (!parsed.ok) {
    return [{ hookEvent: "(file)", reason: "the hooks file is not valid JSON" }];
  }
  const group = parsed.document?.[ANTIGRAVITY_GROUP_NAME];
  if (!isPlainRecord(group)) {
    return [{ hookEvent: ANTIGRAVITY_GROUP_NAME, reason: "no harness group" }];
  }
  if (group.enabled === false) {
    return [{ hookEvent: ANTIGRAVITY_GROUP_NAME, reason: "disabled (enabled: false)" }];
  }
  const wiring = antigravityWiring(runtime);
  const expected = renderAntigravityGroup(wiring.entries);
  const problems: WiringProblem[] = [];
  for (const entry of wiring.entries) {
    const reason = eventProblem(group, expected, entry, runtime, fileExists);
    if (reason !== null) {
      problems.push({ hookEvent: entry.hookEvent, reason });
    }
  }
  return problems;
}

/**
 * why three lines every time the group is in place: a surface nobody measured can fire this group with a payload
 * the harness refuses, and then every tool there is denied. The operator needs the one-key fix before the
 * uninstall, because the uninstall also removes the floor from the other two hosts
 * ([/decisions/ad-156.md](/decisions/ad-156.md)).
 */
export function antigravityRecoveryNotice(target: string): string[] {
  return [
    "hooks: warning — unverified surfaces may deny every tool: Antigravity IDE 2.0.2, app 2.18.1, or a CLI newer than 1.2.13 firing this group with another payload is refused by the harness",
    `hooks: recovery: remove only the "${ANTIGRAVITY_GROUP_NAME}" key from ${target} (outside agy), or delete the file when it is the only key`,
    "hooks: last resort: tlc harness uninstall --yes also removes the Claude and Cursor harness hooks, the harness-init skill links, tlc from PATH and ~/.tlc/harness",
  ];
}
