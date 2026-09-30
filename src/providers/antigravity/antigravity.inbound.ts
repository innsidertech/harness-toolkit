import { resolve } from "node:path";
import type { HarnessEvent, HarnessEventKind } from "../../contracts/index.ts";
import { sanitizeSegment } from "../../platform/sanitize.ts";
import { parseHostEvent } from "./antigravity.events.ts";
import { ANTIGRAVITY_TOOLS, translationFor } from "./antigravity.tools.ts";

export const EVENT_KIND_BY_HOOK: Record<string, HarnessEventKind> = { Stop: "stop" };

type ToolNameFanOutRule = { match: RegExp | string; kind: HarnessEventKind };

export const PRE_TOOL_USE_FAN_OUT: readonly ToolNameFanOutRule[] = ANTIGRAVITY_TOOLS.filter(
  (entry) => entry.pre !== "tool.before",
).map((entry) => ({ match: entry.native, kind: entry.pre }));

export const POST_TOOL_USE_FAN_OUT: readonly ToolNameFanOutRule[] = ANTIGRAVITY_TOOLS.filter(
  (entry) => entry.post !== "tool.after",
).map((entry) => ({ match: entry.native, kind: entry.post }));

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstWorkspace(raw: Record<string, unknown>): string | undefined {
  const paths = raw.workspacePaths;
  if (!Array.isArray(paths)) {
    return undefined;
  }
  const first = asString(paths[0]);
  return first === undefined || first === "" ? undefined : first;
}

function fillTool(event: HarnessEvent, raw: Record<string, unknown>, phase: "pre" | "post"): void {
  const toolCall = asRecord(raw.toolCall);
  const native = asString(toolCall?.name);
  const args = asRecord(toolCall?.args) ?? {};
  const translation = translationFor(native);

  if (translation === null) {
    event.event = phase === "pre" ? "tool.before" : "tool.after";
    if (native !== undefined) {
      event.toolName = native;
    }
  } else {
    event.event = phase === "pre" ? translation.pre : translation.post;
    if (translation.canonical !== null) {
      event.toolName = translation.canonical;
    }
    translation.fill(event, args);
    if (phase === "pre") {
      translation.fillPre?.(event, args);
    }
  }
  if (event.event === "tool.before" || event.event === "tool.after") {
    event.toolInput = args;
  }
}

/**
 * Never throws on a malformed payload — returns null instead.
 *
 * invariant: `projectDir` comes from the payload alone. The host launches the hook with its working directory
 * inside `.agents`, so `process.cwd()` would put every relative path and every write in the wrong root
 * ([/decisions/ad-156.md](/decisions/ad-156.md)).
 *
 * hazard: the `error` field of an after-event stays in `raw`. Nothing captured shows what it holds on a real
 * failure, and reading it as `tool.failure` would fire failure rails on a guess.
 */
export function antigravityToEvent(raw: Record<string, unknown>, hostEvent?: string): HarnessEvent | null {
  const hook = parseHostEvent(hostEvent);
  if (hook === null) {
    return null;
  }
  const workspace = firstWorkspace(raw);
  if (workspace === undefined) {
    return null;
  }

  const event: HarnessEvent = {
    provider: "antigravity",
    event: "stop",
    sessionKey: `antigravity-${sanitizeSegment(asString(raw.conversationId) ?? "default")}`,
    projectDir: resolve(workspace),
    raw,
  };
  const model = asString(raw.modelName);
  if (model !== undefined) {
    event.model = model;
  }
  const transcriptPath = asString(raw.transcriptPath);
  if (transcriptPath !== undefined) {
    event.transcriptPath = transcriptPath;
  }

  if (hook === "Stop") {
    event.event = EVENT_KIND_BY_HOOK.Stop ?? "stop";
    return event;
  }
  fillTool(event, raw, hook === "PreToolUse" ? "pre" : "post");
  return event;
}
