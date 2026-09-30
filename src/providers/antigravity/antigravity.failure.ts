import { resolve } from "node:path";
import type { FailClosedPosture } from "../provider.port.ts";
import { ANTIGRAVITY_EVENT_PREFIX } from "./antigravity.events.ts";
import { renderAntigravityFailure } from "./antigravity.outbound.ts";

export const antigravityFailClosed: FailClosedPosture = {
  hostEventPrefix: ANTIGRAVITY_EVENT_PREFIX,
  failureResponse: renderAntigravityFailure,
  // why: the hook runs with its working directory inside `.agents`, so the payload's workspace is the only root
  // a diagnostic may land under; without one, stderr is the whole record.
  diagnosticRoot(parsed) {
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const paths = (parsed as Record<string, unknown>).workspacePaths;
    if (!Array.isArray(paths)) {
      return null;
    }
    const first: unknown = paths[0];
    return typeof first === "string" && first !== "" ? resolve(first) : null;
  },
};
