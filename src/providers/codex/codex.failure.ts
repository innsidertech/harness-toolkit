import type { FailClosedPosture } from "../provider.port.ts";
import { CODEX_EVENT_PREFIX } from "./codex.events.ts";
import { renderCodexFailure } from "./codex.outbound.ts";

export const codexFailClosed: FailClosedPosture = {
  hostEventPrefix: CODEX_EVENT_PREFIX,
  failureResponse: renderCodexFailure,
  // why: no workspace key is named. Null means stderr only.
  diagnosticRoot(_parsed: unknown): string | null {
    return null;
  },
};
