import type { Decision, HarnessEvent, Rendered } from "../../contracts/index.ts";
import type { HookFailureCause } from "../provider.port.ts";

/**
 * hazard: this host reads its output the other way round from the other two — `{}` refuses the tool and an
 * empty stdout lets it run. Every path therefore writes an explicit decision; a null stdout here would be an
 * approval nobody made ([/decisions/ad-156.md](/decisions/ad-156.md)).
 */
const ALLOW = JSON.stringify({ decision: "allow" });

function denyOf(reason: string): string {
  return JSON.stringify({ decision: "deny", reason });
}

export function antigravityRender(decision: Decision, _event: HarnessEvent): Rendered {
  switch (decision.kind) {
    case "abstain":
    case "allow":
    case "context":
    case "continue":
    case "rewriteOutput":
      return { stdout: ALLOW, exitCode: 0 };
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
