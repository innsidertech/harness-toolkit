import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectStateDir } from "../../platform/paths.ts";
import { sanitizeSegment } from "../../platform/sanitize.ts";

/**
 * The previous gate failure's tail, so the next one can be compared with it.
 *
 * hazard: this is gate output on disk, so it is written only while the stagnation advisor is on — an install that
 * never opted in gets no file and no directory, which is the judge's own rule for the operator's prompt
 * ([/decisions/ad-148.md](/decisions/ad-148.md)).
 */
function failurePath(root: string, sessionKey: string): string {
  return join(projectStateDir(root), "advisor", `${sanitizeSegment(sessionKey)}.failure`);
}

export function readPreviousFailure(root: string, sessionKey: string): string | null {
  try {
    const text = readFileSync(failurePath(root, sessionKey), "utf8");
    return text === "" ? null : text;
  } catch {
    return null;
  }
}

export function rememberFailure(root: string, sessionKey: string, tail: string): void {
  try {
    mkdirSync(join(projectStateDir(root), "advisor"), { recursive: true });
    writeFileSync(failurePath(root, sessionKey), tail);
  } catch {
    // invariant: a failed write costs the next comparison, never the turn.
  }
}
