/**
 * why: the payload has no `hook_event_name`, which both other providers require, so these three fields alone
 * cannot collide with either of them.
 */
export function detectAntigravity(raw: unknown): boolean {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return false;
  }
  const record = raw as Record<string, unknown>;
  return (
    typeof record.conversationId === "string" &&
    Array.isArray(record.workspacePaths) &&
    typeof record.transcriptPath === "string"
  );
}
