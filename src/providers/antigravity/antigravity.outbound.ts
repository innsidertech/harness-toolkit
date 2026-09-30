import type { Decision, HarnessEvent, HarnessEventKind, Rendered } from "../../contracts/index.ts";
import type { HookFailureCause } from "../provider.port.ts";
import { ANTIGRAVITY_TOOLS } from "./antigravity.tools.ts";

/**
 * hazard: this host reads its output the other way round from the other two — `{}` refuses the tool and an
 * empty stdout lets it run. Before a tool, every path therefore writes an explicit decision; a null stdout there
 * would be an approval nobody made ([/decisions/ad-156.md](/decisions/ad-156.md)).
 */
const ALLOW = JSON.stringify({ decision: "allow" });

/**
 * hazard: after a tool and at Stop the host reads any JSON as the tool's result or a verdict, so an allow object
 * there replaced the tool's result with `unknown field "decision"` (measured on `agy` 1.2.14). Success on those
 * events is zero bytes; the floor already acted before the tool, so silence here opens nothing.
 */
const SILENT = "";

/**
 * invariant: the kinds this adapter produces from PostToolUse and Stop. They are disjoint from the PreToolUse kinds
 * in the tool table, so the kind alone names the host event and no host event name reaches core.
 */
const SILENT_SUCCESS_KINDS: ReadonlySet<HarnessEventKind> = new Set<HarnessEventKind>([
  "stop",
  "tool.after",
  ...ANTIGRAVITY_TOOLS.map((tool) => tool.post),
]);

function denyOf(reason: string): string {
  return JSON.stringify({ decision: "deny", reason });
}

export function antigravityRender(decision: Decision, event: HarnessEvent): Rendered {
  switch (decision.kind) {
    case "abstain":
    case "allow":
    case "context":
    case "continue":
    case "rewriteOutput":
      return { stdout: SILENT_SUCCESS_KINDS.has(event.event) ? SILENT : ALLOW, exitCode: 0 };
    case "deny":
      return { stdout: denyOf(decision.reason), exitCode: 0 };
    // why: the host has no escalation and no input rewrite. Either one reaching here was never approved, so it
    // is refused rather than let through.
    case "ask":
    case "rewriteInput":
      return { stdout: denyOf(decision.reason), exitCode: 0 };
    default: {
      const exhaustive: never = decision;
      throw new Error(`unreachable decision kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function renderAntigravityFailure(cause: HookFailureCause): Rendered {
  return { stdout: denyOf(`tlc-harness: ${cause}`), exitCode: 0 };
}
