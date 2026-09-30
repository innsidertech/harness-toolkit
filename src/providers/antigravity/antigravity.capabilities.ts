import type { ProviderCapabilities } from "../../contracts/index.ts";

/**
 * why every false: the host's hook output carries only `decision` and `reason`. No field injects context,
 * rewrites input or output, or asks the user, and the payload has no usage, effort, or tool output — each
 * value here is what the captures showed, not what the host might grow ([/decisions/ad-156.md](/decisions/ad-156.md)).
 */
export function antigravityCapabilities(): ProviderCapabilities {
  return {
    enforcesHooks: true,
    askSupportedOn: [],
    sessionEnv: false,
    nativeLoopCounter: false,
    dedicatedShellEvent: false,
    toolInputRewrite: false,
    toolOutputRewriteOn: [],
    contextAtToolBefore: false,
    contextAtToolAfter: false,
    contextAtStop: false,
    sessionStartContextReliable: false,
    toolOutputAtAfter: false,
    usageInPayload: false,
    effortSignal: false,
    thoughtEvent: false,
  };
}
