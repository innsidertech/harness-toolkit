import { coreFacade, type Policy } from "../core/index.ts";
import { estimateCostUsd } from "../platform/pricing.ts";
import { obsConfigFor } from "./support.ts";

type AdviseArgs = Parameters<typeof coreFacade.advisor.advise>[0];
type AdvisorOutcome = Awaited<ReturnType<typeof coreFacade.advisor.advise>>;

/**
 * Ask Jev one advisory question and write the reading beside what the existing rule decided.
 *
 * invariant: recorded whenever a request was made or refused for want of a key, and never otherwise. With the
 * advisors off — the default — this reads one policy field and returns ([/decisions/ad-148.md](/decisions/ad-148.md)).
 *
 * invariant: it returns readings and decides nothing. A caller in `record` ignores the return value.
 */
export async function adviseAndRecord(args: {
  root: string;
  provider: string;
  sessionKey: string;
  policy: Policy;
  use: AdviseArgs["use"];
  items: AdviseArgs["items"];
  /** What the rule that already exists decided, so a record is a comparison rather than a number on its own. */
  existing: Record<string, string | number | boolean>;
}): Promise<AdvisorOutcome> {
  const config = args.policy.intelligence.jev;
  const outcome = await coreFacade.advisor.advise({
    root: args.root,
    sessionKey: args.sessionKey,
    config,
    use: args.use,
    items: args.items,
  });
  if (outcome.outcome === "skipped") {
    return outcome;
  }
  const cost = estimateCostUsd("typesafe", outcome.model, { inputTokens: outcome.inputTokens });
  coreFacade.observability.recordObs(args.root, obsConfigFor(args.policy), {
    provider: args.provider,
    kind: "policy.observe",
    sessionKey: args.sessionKey,
    model: outcome.model === "none" ? config.model : outcome.model,
    attrs: coreFacade.advisor.advisorObsAttrs(outcome, config, args.existing),
    gen_ai: {
      input_tokens: outcome.inputTokens,
      output_tokens: 0,
      cost_usd: cost.costUsd,
      cost_source: cost.source,
      duration_ms: Math.round(outcome.latencyMs),
    },
  });
  return outcome;
}
