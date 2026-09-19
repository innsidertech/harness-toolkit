import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendRecord, readTail } from "../../platform/fs-jsonl.ts";
import { projectStateDir } from "../../platform/paths.ts";
import type { Style } from "../../platform/style.ts";
import { PLAIN } from "../../platform/style.ts";
import type { SystemOneAttempt, SystemOneRequest, SystemOneResult } from "../../platform/typesafe.ts";

/**
 * The whole exchange with Jev — what was sent and what came back — for an operator who asked to see it.
 *
 * hazard: this is the one local file that holds the text the obs records refuse to hold: the content read from
 * outside, the operator's prompt, gate output, the agent's reply. It exists because a control nobody can watch
 * working cannot be trusted or calibrated, and it is off by default because the exposure is real
 * ([/decisions/ad-149.md](/decisions/ad-149.md)).
 *
 * invariant: the body as sent, so already masked — every caller masks unconditionally before building a request.
 * The key travels in a header and is never part of a request, so it is never part of a record.
 */
const JEV_TRACE_FILE = "jev-trace.jsonl";

/** Who asked: `judge:read`, `judge:command` (or `edit`, `mcp`, `response`), `advisor:<use>`. */
export type JevTraceTarget = { root: string; sessionKey: string; caller: string };

export type JevTraceRecord = {
  ts: string;
  session: string;
  caller: string;
  /** Position in the run and its size, so a fan-out reads as one run rather than as unrelated calls. */
  index: number;
  of: number;
  request: SystemOneRequest;
  /** Every HTTP answer as it arrived, retried ones included. Empty when nothing came back, or nothing was sent. */
  attempts: SystemOneAttempt[];
  /** What the client made of them, which is what the caller routed on. */
  result: SystemOneResult;
};

// why: a bound in bytes because one exchange can carry 12,000 characters, so a bound in records says nothing about
// the disk. At the limit the newest records are kept — the trace is for watching, and the oldest are the least watched.
const MAX_BYTES = 8 * 1024 * 1024;
const KEPT_AT_LIMIT = 200;

export function tracePath(root: string): string {
  return join(projectStateDir(root), JEV_TRACE_FILE);
}

function trimIfOver(path: string): void {
  if (!existsSync(path) || statSync(path).size <= MAX_BYTES) {
    return;
  }
  const kept = readTail<JevTraceRecord>(path, KEPT_AT_LIMIT);
  writeFileSync(path, kept.map((record) => `${JSON.stringify(record)}\n`).join(""), "utf8");
}

/** invariant: never throws. A trace that cannot be written must not cost the run whose exchange it describes. */
export function traceExchange(
  target: JevTraceTarget,
  record: Omit<JevTraceRecord, "session" | "caller">,
): void {
  try {
    const path = tracePath(target.root);
    trimIfOver(path);
    appendRecord(path, { ...record, session: target.sessionKey, caller: target.caller });
  } catch {}
}

export function readTrace(root: string, limit: number): JevTraceRecord[] {
  try {
    return readTail<JevTraceRecord>(tracePath(root), limit);
  } catch {
    return [];
  }
}

function cut(text: string, max: number): string {
  return max > 0 && text.length > max ? `${text.slice(0, max)}… (${text.length} chars)` : text;
}

/** State is nested one level at most (`content.source`, `content.text`), so it is flattened to dotted fields. */
function stateFields(state: Record<string, unknown>, prefix = ""): [string, string][] {
  return Object.entries(state).flatMap(([key, value]): [string, string][] =>
    value !== null && typeof value === "object"
      ? stateFields(value as Record<string, unknown>, `${prefix}${key}.`)
      : [[`${prefix}${key}`, String(value)]],
  );
}

function resultLine(result: SystemOneResult): string {
  return result.ok
    ? `ok · answered by ${result.model} · ${result.inputTokens} input tokens · ${Math.round(result.latencyMs)} ms`
    : `error:${result.category} · ${result.detail} · ${Math.round(result.latencyMs)} ms`;
}

function answerOf(result: SystemOneResult, id: string): string {
  if (!result.ok) {
    return "no answer";
  }
  const value = result.answers[id];
  return typeof value === "number" ? value.toFixed(2) : "no answer";
}

/**
 * One exchange as the operator reads it: what was asked about, each question beside its answer, then the outcome.
 *
 * why `maxFieldChars`: a terminal wants the shape of the exchange and the file wants all of it, so the caller
 * chooses — `0` cuts nothing.
 */
export function traceText(
  records: readonly JevTraceRecord[],
  maxFieldChars: number,
  style: Style = PLAIN,
): string {
  const blocks = records.map((record, at) => {
    const head = `#${at + 1}  ${record.ts}  ${record.caller}  request ${record.index + 1}/${record.of}  session ${record.session}`;
    const state = stateFields(record.request.state).map(
      ([field, text]) => `    ${style.dim(`${field}:`)} ${cut(text, maxFieldChars)}`,
    );
    const questions = Object.entries(record.request.questions).flatMap(([id, question]) => [
      `    ${style.paint("accent", id)} → ${answerOf(record.result, id)}`,
      `      ${style.dim("asked:")} ${cut(question.instructions, maxFieldChars)}`,
      `      ${style.dim("true when:")} ${cut(question.criteria.true, maxFieldChars)}`,
      `      ${style.dim("false when:")} ${cut(question.criteria.false, maxFieldChars)}`,
    ]);
    return [
      style.paint("accent", head),
      `  request → ${record.request.model}`,
      "  state",
      ...state,
      "  questions and answers",
      ...questions,
      `  response ← ${record.attempts.map((attempt) => `HTTP ${attempt.status}`).join(", ") || "no HTTP answer"} · ${resultLine(record.result)}`,
    ].join("\n");
  });
  return blocks.join("\n\n");
}

function fenced(text: string): string {
  // hazard: the content is outside text and can carry a fence of its own, which would end this one early. The
  // fence is one backtick longer than the longest run inside.
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}

/** The same exchanges, uncut, with the raw request and result beside the reading of them. */
export function traceMarkdown(records: readonly JevTraceRecord[]): string {
  const sections = records.map((record, at) => {
    const questions = Object.entries(record.request.questions).map(
      ([id, question]) =>
        `| \`${id}\` | **${answerOf(record.result, id)}** | ${question.instructions.replace(/\|/g, "\\|")} |`,
    );
    return [
      `## #${at + 1} — ${record.caller} — ${record.ts}`,
      "",
      `Session \`${record.session}\`, request ${record.index + 1} of ${record.of}, sent to \`${record.request.model}\`. ${resultLine(record.result)}.`,
      "",
      "| question | answer | asked |",
      "| --- | --- | --- |",
      ...questions,
      "",
      "### Request body, as sent",
      "",
      fenced(JSON.stringify(record.request, null, 2)),
      "",
      `### Response, as it arrived (${record.attempts.length} HTTP ${record.attempts.length === 1 ? "answer" : "answers"})`,
      "",
      fenced(JSON.stringify(record.attempts, null, 2)),
      "",
      "### What the client read from it",
      "",
      fenced(JSON.stringify(record.result, null, 2)),
    ].join("\n");
  });
  return [`# Jev exchanges (${records.length})`, ...sections].join("\n\n").concat("\n");
}
