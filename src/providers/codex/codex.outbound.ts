import type { Decision, HarnessEvent, Rendered } from "../../contracts/index.ts";
import type { HookFailureCause } from "../provider.port.ts";

/**
 * why: on the measured `PreToolUse`, empty stdout, `{}`, non-JSON, exit 1 and exit 2 all leave the tool running.
 * The only refusal the host honoured is this object, with exit 0.
 */
function denyEnvelope(reason: string): Rendered {
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
    exitCode: 0,
  };
}

export function codexRender(decision: Decision, _event: HarnessEvent): Rendered {
  switch (decision.kind) {
    case "allow":
    case "abstain":
      return { stdout: null, exitCode: 0 };
    case "deny":
      return denyEnvelope(decision.reason);
    // why: this host has no channel for these kinds. Emitting their fields would copy a shape the capture did not
    // show. `continue` is the same envelope: silence here would let the tool run.
    case "ask":
    case "context":
    case "continue":
    case "rewriteInput":
    case "rewriteOutput":
      return denyEnvelope("unsupported");
    default: {
      const exhaustive: never = decision;
      throw new Error(`unreachable decision kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function renderCodexFailure(cause: HookFailureCause): Rendered {
  return denyEnvelope(cause);
}
