import type { HarnessEvent, HarnessEventKind } from "../../contracts/index.ts";

/** why: empty until a fixture names stdin keys. The docs generator accepts this and skips a fan-out table. */
export const EVENT_KIND_BY_HOOK: Record<string, HarnessEventKind> = {};

/** Never throws. No host-event string is classified, including a token this provider's wiring would write. */
export function codexToEvent(_raw: Record<string, unknown>, _hostEvent?: string): HarnessEvent | null {
  return null;
}
