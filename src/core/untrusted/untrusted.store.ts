import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectStateDir } from "../../platform/paths.ts";
import { sanitizeSegment } from "../../platform/sanitize.ts";
import { EMPTY_RECALL, type Recall } from "./untrusted.recall.ts";

function markerDir(root: string): string {
  return join(projectStateDir(root), "untrusted");
}

export function markerPath(root: string, sessionKey: string): string {
  return join(markerDir(root), `${sanitizeSegment(sessionKey)}.marker`);
}

export function wasFramingInjected(root: string, sessionKey: string): boolean {
  return existsSync(markerPath(root, sessionKey));
}

export function markFramingInjected(root: string, sessionKey: string): void {
  try {
    mkdirSync(markerDir(root), { recursive: true });
    writeFileSync(markerPath(root, sessionKey), new Date().toISOString());
  } catch {}
}

// why: the turn boundary is the prompt, so the marker is cleared there rather than expiring on a timer.
// A failure to clear costs one missing framing, never a duplicate on every tool call.
export function clearFramingMarker(root: string, sessionKey: string): void {
  try {
    rmSync(markerPath(root, sessionKey), { force: true });
  } catch {}
}

function recallPath(root: string, sessionKey: string): string {
  return join(markerDir(root), `${sanitizeSegment(sessionKey)}.recall.json`);
}

// invariant: a screen that cannot be read is dropped, never repaired. The judge then asks the question again,
// which costs one request and cannot route on a number nobody wrote.
function isScreen(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const screen = value as { model?: unknown; maxEntryChars?: unknown; instructs?: unknown };
  return (
    typeof screen.model === "string" &&
    typeof screen.maxEntryChars === "number" &&
    Array.isArray(screen.instructs) &&
    screen.instructs.every((score) => typeof score === "number" && Number.isFinite(score))
  );
}

/**
 * why: on disk and per session, because the read and the command are two hook invocations in two processes. A
 * value held in memory would be gone before the command it exists to check arrives
 * ([/decisions/ad-077.md](/decisions/ad-077.md)).
 */
export function readRecall(root: string, sessionKey: string): Recall {
  try {
    const parsed = JSON.parse(readFileSync(recallPath(root, sessionKey), "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || !Array.isArray((parsed as Recall).entries)) {
      return EMPTY_RECALL;
    }
    const recall = parsed as Recall;
    return {
      entries: recall.entries
        .filter((entry) => typeof entry?.source === "string" && typeof entry?.text === "string")
        .map((entry) => (isScreen(entry.screen) ? entry : { source: entry.source, text: entry.text })),
      droppedChars: typeof recall.droppedChars === "number" ? recall.droppedChars : 0,
    };
  } catch {
    // invariant: unreadable reads as empty. A rail that threw here would turn a corrupt cache into a broken turn.
    return EMPTY_RECALL;
  }
}

export function writeRecall(root: string, sessionKey: string, recall: Recall): void {
  try {
    mkdirSync(markerDir(root), { recursive: true });
    writeFileSync(recallPath(root, sessionKey), JSON.stringify(recall));
  } catch {}
}

// why: cleared with the framing marker, on the prompt boundary. Content read in a previous turn is content the
// operator has already had a chance to see the framing for.
export function clearRecall(root: string, sessionKey: string): void {
  try {
    rmSync(recallPath(root, sessionKey), { force: true });
  } catch {}
}
