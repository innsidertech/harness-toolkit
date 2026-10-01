import type { ProviderCapabilities } from "../../contracts/index.ts";

/**
 * why: `enforcesHooks` is the measured deny. Every other flag is false or empty because the capture did not show
 * that channel — an ask list, a rewrite, context, usage, effort, or a thought event.
 */
export function codexCapabilities(): ProviderCapabilities {
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
