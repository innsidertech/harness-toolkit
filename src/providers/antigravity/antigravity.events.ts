/**
 * why: the host sends no event name on stdin, so the event travels in argv as the token after the handler. The
 * prefix keeps this host's tokens apart from a bare `PreToolUse` that another provider's wiring could carry
 * ([/decisions/ad-156.md](/decisions/ad-156.md)).
 */
export const ANTIGRAVITY_EVENT_PREFIX = "antigravity:";

export type AntigravityHostEvent = "PreToolUse" | "PostToolUse" | "Stop";

export const ANTIGRAVITY_TIMEOUT_SECONDS: Record<AntigravityHostEvent, number> = {
  PreToolUse: 10,
  PostToolUse: 10,
  Stop: 120,
};

/**
 * Events whose success is zero bytes on stdout; `bin/tlc-exec.mjs` repeats these tokens in `silentSuccessTokens`.
 *
 * why: on these two events the host reads any JSON as the tool's result or a verdict — measured on `agy` 1.2.14, an
 * allow object after a tool replaced its result with `unknown field "decision"` ([/decisions/ad-156.md](/decisions/ad-156.md)).
 */
export const ANTIGRAVITY_SILENT_SUCCESS_EVENTS: readonly AntigravityHostEvent[] = ["PostToolUse", "Stop"];

/** Returns the suffix only for an exact wired token; null for a bare, absent, or unknown token. */
export function parseHostEvent(hostEvent: string | undefined): AntigravityHostEvent | null {
  if (hostEvent === undefined || !hostEvent.startsWith(ANTIGRAVITY_EVENT_PREFIX)) {
    return null;
  }
  const suffix = hostEvent.slice(ANTIGRAVITY_EVENT_PREFIX.length);
  if (suffix === "PreToolUse" || suffix === "PostToolUse" || suffix === "Stop") {
    return suffix;
  }
  return null;
}

export function hostEventToken(event: AntigravityHostEvent): string {
  return `${ANTIGRAVITY_EVENT_PREFIX}${event}`;
}
