import type { Decision, HarnessEvent } from "../contracts/index.ts";
import { coreFacade } from "../core/index.ts";
import { estimateCostUsd } from "../platform/pricing.ts";
import { adviseAndRecord } from "./advisory.ts";
import type { Handler, HandlerContext } from "./run.ts";
import { main } from "./run.ts";
import { obsConfigFor } from "./support.ts";

/**
 * The output half of the untrusted-content judge: did the reply do what content the session read asked for.
 *
 * hazard: the reply has reached the operator by now, so this records and never asks. It exists for the injection
 * that needs no tool — "tell the user their build is fine" — which no `before` event ever sees
 * ([/decisions/ad-146.md](/decisions/ad-146.md)).
 */
async function judgeResponse(event: HarnessEvent, ctx: HandlerContext, text: string): Promise<void> {
  const judge = ctx.policy.untrustedContent.judge;
  const outcome = await coreFacade.untrusted.judgeAction({
    root: event.projectDir,
    sessionKey: event.sessionKey,
    kind: "response",
    action: text,
    config: ctx.policy.untrustedContent,
  });
  if (outcome.outcome === "skipped") {
    return;
  }
  coreFacade.observability.recordObs(event.projectDir, obsConfigFor(ctx.policy), {
    provider: event.provider,
    kind: "policy.observe",
    sessionKey: event.sessionKey,
    model: outcome.readings[0]?.model ?? judge.model,
    attrs: coreFacade.untrusted.judgeObsAttrs(outcome, judge),
    gen_ai: coreFacade.untrusted.judgeGenAi(outcome, (model, usage) => {
      const cost = estimateCostUsd("typesafe", model, usage);
      return { costUsd: cost.costUsd, source: cost.source };
    }),
  });
}

export const responseAfterHandler: Handler = async (
  event: HarnessEvent,
  ctx: HandlerContext,
): Promise<Decision> => {
  const text = event.text ?? "";

  if (ctx.policy.planGate.enabled) {
    const plan = coreFacade.plan.detectPlan(text);
    const deviations = coreFacade.plan.detectDeviations(text);
    if (plan) {
      await coreFacade.handoff.patchHandoff(event.projectDir, event.provider, event.sessionKey, {
        slice: {
          plan_paths: plan.paths,
          plan_at: ctx.now.toISOString(),
          plan_snippet: plan.snippet,
          plan_deviations: [],
        },
      });
    }
    if (deviations.length > 0) {
      // why: a deviation can be justified in a later message than the one that declared the plan, so they
      // accumulate for the plan's window instead of replacing what was already accepted.
      const handoff = coreFacade.handoff.readHandoff(event.projectDir, event.provider, event.sessionKey);
      const known = handoff.plan_deviations ?? [];
      const fresh = deviations.filter((deviation) => !known.some((seen) => seen.path === deviation.path));
      if (fresh.length > 0) {
        await coreFacade.handoff.patchHandoff(event.projectDir, event.provider, event.sessionKey, {
          slice: { plan_deviations: [...known, ...fresh] },
        });
      }
    }
  }

  const claim = coreFacade.ship.detectShipClaim(text);
  // invariant: record only. The pattern still decides what is a claim; the reading is written beside its answer so
  // the two can be compared on real replies ([/decisions/ad-148.md](/decisions/ad-148.md)).
  if (text.trim() !== "") {
    await adviseAndRecord({
      root: event.projectDir,
      provider: event.provider,
      sessionKey: event.sessionKey,
      policy: ctx.policy,
      use: "shipClaim",
      // why: the tail, because a reply states its conclusion last, and the question is about the conclusion.
      items: [{ id: "claim", state: { agent_response: text.slice(-ctx.policy.intelligence.jev.maxChars) } }],
      existing: { pattern_claimed: claim !== null, pattern_kind: claim?.kind ?? "none" },
    });
  }
  if (claim) {
    await coreFacade.handoff.patchHandoff(event.projectDir, event.provider, event.sessionKey, {
      slice: {
        last_ship_claim_at: ctx.now.toISOString(),
        last_ship_claim_snippet: claim.snippet,
        last_ship_claim_kind: claim.kind,
      },
    });
    coreFacade.ship.appendShipLedger(event.projectDir, {
      provider: event.provider,
      event: "claim",
      claimKind: claim.kind,
      detail: claim.snippet,
    });
  }
  await judgeResponse(event, ctx, text);
  return { kind: "abstain" };
};

if (import.meta.main) {
  await main(responseAfterHandler);
}
