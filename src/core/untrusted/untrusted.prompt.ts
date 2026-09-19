import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectStateDir } from "../../platform/paths.ts";
import { sanitizeSegment } from "../../platform/sanitize.ts";
import type { UntrustedJudgeConfig } from "./untrusted.types.ts";

/**
 * The turn's operator prompt, held per session so the judge can ask whether a command serves it.
 *
 * hazard: this is prompt text on disk, so it is written only while the judge is enabled and cleared on the same
 * turn boundary that clears the recall. An install that never opted in gets no file at all — not an empty one, not
 * a directory ([/decisions/ad-146.md](/decisions/ad-146.md)).
 *
 * invariant: state, never a log line. It is read by the judge and never written to `obs.jsonl`, where the record
 * carries the entry's source and nothing an operator typed.
 */
function promptDir(root: string): string {
  return join(projectStateDir(root), "untrusted");
}

export function operatorPromptPath(root: string, sessionKey: string): string {
  return join(promptDir(root), `${sanitizeSegment(sessionKey)}.prompt`);
}

/**
 * why truncation rather than rejection: a prompt's opening is what states the task, so the head is the part the
 * question needs. A prompt too long to send whole is still worth asking about.
 */
export function rememberOperatorPrompt(args: {
  root: string;
  sessionKey: string;
  text: string | undefined;
  judge: UntrustedJudgeConfig;
}): boolean {
  if (!args.judge.enabled || args.text === undefined || args.text.trim() === "") {
    return false;
  }
  try {
    mkdirSync(promptDir(args.root), { recursive: true });
    writeFileSync(
      operatorPromptPath(args.root, args.sessionKey),
      args.text.slice(0, args.judge.maxOperatorPromptChars),
    );
    return true;
  } catch {
    // invariant: a failed write costs the third question, never the turn. The judge sends two questions when it
    // finds no prompt, which is the same path a host that delivers no prompt text already takes.
    return false;
  }
}

export function readOperatorPrompt(root: string, sessionKey: string): string | null {
  const path = operatorPromptPath(root, sessionKey);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const text = readFileSync(path, "utf8");
    return text === "" ? null : text;
  } catch {
    return null;
  }
}

/**
 * why on the turn boundary, beside the recall and the framing marker: a prompt from a previous turn would be asked
 * about a command from this one. It is cleared unconditionally, so switching the judge off leaves nothing behind
 * on the next prompt rather than leaving the last turn's text on disk indefinitely.
 */
export function clearOperatorPrompt(root: string, sessionKey: string): void {
  try {
    rmSync(operatorPromptPath(root, sessionKey), { force: true });
  } catch {}
}
