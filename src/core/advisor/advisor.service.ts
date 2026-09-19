import type { NoulQuestion, SystemOneRequest, TypesafeErrorCategory } from "../../platform/typesafe.ts";
import {
  type AskFn,
  askWithinBudget,
  credentialsPath,
  liveAsk,
  resolveApiKey,
} from "../jev/jev.transport.ts";
import { maskSecrets } from "../secret-scan/secret-scan.service.ts";
import { placeholderFor } from "../secret-scan/secret-scan.store.ts";
import type { AdvisorUse, JevAdvisorConfig } from "./advisor.types.ts";

/** The name these readings are recorded and counted under, apart from the judge's. */
export const ADVISOR_RAIL = "jev-advisor";

/** One thing to ask about: an id the caller will read the answer back by, and the named fields the question reads. */
export type AdvisorItem = { id: string; state: Record<string, string> };

export type AdvisorOutcome = {
  use: AdvisorUse;
  outcome: "advised" | "failed" | "skipped";
  /** Item id to probability. Empty unless every item answered. */
  scores: Record<string, number>;
  model: string;
  drift: boolean;
  failure?: { category: TypesafeErrorCategory; detail: string };
  requests: number;
  inputTokens: number;
  latencyMs: number;
};

/**
 * The four questions, one per use.
 *
 * invariant: each names its state fields directly, states both criteria, and is phrased so that `true` means yes.
 * The model reads literally and does not count, compare dates or follow indirection, so nothing here asks it to
 * ([/decisions/ad-146.md](/decisions/ad-146.md)).
 */
const QUESTIONS: Record<AdvisorUse, NoulQuestion> = {
  lessonRank: {
    type: "noul",
    instructions: "Does `lesson` address the problem shown in `failure_output`?",
    criteria: {
      true: "`lesson` gives advice about the same kind of failure that `failure_output` reports.",
      false: "`lesson` is about a different kind of failure, or `failure_output` reports no failure.",
    },
  },
  shipClaim: {
    type: "noul",
    instructions: "Does `agent_response` claim that the work is finished or verified?",
    criteria: {
      true: "`agent_response` states that the task is done, shipped, fixed, passing or verified.",
      false: "`agent_response` reports progress, asks a question, describes a plan, or says work remains.",
    },
  },
  commentNarration: {
    type: "noul",
    instructions: "Does `comment` only restate what the code next to it does?",
    criteria: {
      true: "`comment` describes the operation the code performs and gives no reason, hazard or constraint.",
      false:
        "`comment` explains why the code is this way, warns of a hazard, or states a rule the code must keep.",
    },
  },
  stagnation: {
    type: "noul",
    instructions: "Do `previous_failure` and `current_failure` report the same underlying problem?",
    criteria: {
      true: "Both report the same error, in the same place, for the same reason, even if line numbers or wording differ.",
      false: "`current_failure` reports a different error, a different place, or a different reason.",
    },
  },
};

function skipped(use: AdvisorUse): AdvisorOutcome {
  return {
    use,
    outcome: "skipped",
    scores: {},
    model: "none",
    drift: false,
    requests: 0,
    inputTokens: 0,
    latencyMs: 0,
  };
}

function requestFor(
  config: JevAdvisorConfig,
  use: AdvisorUse,
  state: Record<string, string>,
): SystemOneRequest {
  return { model: config.model, state, questions: { answer: QUESTIONS[use] } };
}

/**
 * Put one use's question to Jev about each item, inside one budget.
 *
 * invariant: never throws and never decides. It returns readings; what a caller does with them is the caller's,
 * and in `record` that is nothing at all.
 *
 * invariant: every string is masked before it is sent, unconditionally — the judge's rule, for the judge's reason.
 *
 * invariant: one unusable answer fails the whole call, so a caller never ranks or compares over a partial set.
 */
export async function advise(args: {
  root: string;
  sessionKey: string;
  config: JevAdvisorConfig;
  use: AdvisorUse;
  items: readonly AdvisorItem[];
  env?: NodeJS.ProcessEnv;
  ask?: AskFn;
  now?: () => number;
}): Promise<AdvisorOutcome> {
  const { config, use } = args;
  if (!config.enabled || config[use] === "off" || args.items.length === 0) {
    return skipped(use);
  }
  const now = args.now ?? (() => Date.now());
  const started = now();
  const env = args.env ?? process.env;
  const key = resolveApiKey(env);
  if (key === null) {
    return {
      ...skipped(use),
      outcome: "failed",
      failure: { category: "auth", detail: `no key in TYPESAFE_API_KEY or ${credentialsPath(env)}` },
    };
  }

  const mask = (text: string): string =>
    maskSecrets(text.slice(0, config.maxChars), (matchedText, kind) =>
      placeholderFor(args.root, args.sessionKey, matchedText, kind),
    );
  const requests = args.items.map((item) =>
    requestFor(
      config,
      use,
      Object.fromEntries(Object.entries(item.state).map(([field, text]) => [field, mask(text)])),
    ),
  );
  const results = await askWithinBudget({
    requests,
    judge: config,
    key,
    ask: args.ask ?? liveAsk,
    now,
    started,
  });

  const scores: Record<string, number> = {};
  let inputTokens = 0;
  let model = "none";
  let drift = false;
  for (const [index, result] of results.entries()) {
    if (!result.ok) {
      return {
        use,
        outcome: "failed",
        scores: {},
        model,
        drift,
        failure: { category: result.category, detail: result.detail },
        requests: results.length,
        inputTokens,
        latencyMs: now() - started,
      };
    }
    scores[(args.items[index] as AdvisorItem).id] = result.answers.answer ?? 0;
    inputTokens += result.inputTokens;
    model = result.model;
    drift = drift || result.model !== config.model;
  }
  return {
    use,
    outcome: "advised",
    scores,
    model,
    drift,
    requests: results.length,
    inputTokens,
    latencyMs: now() - started,
  };
}

/**
 * The record for one advisory call.
 *
 * invariant: ids, probabilities and metrics, plus whatever the caller says the existing rule decided — which is the
 * comparison `record` exists to collect. Never the text that was sent.
 */
export function advisorObsAttrs(
  outcome: AdvisorOutcome,
  config: JevAdvisorConfig,
  existing: Record<string, string | number | boolean>,
): Record<string, unknown> {
  return {
    rail: ADVISOR_RAIL,
    rule: ADVISOR_RAIL,
    use: outcome.use,
    mode: config[outcome.use],
    outcome: outcome.failure ? `error:${outcome.failure.category}` : outcome.outcome,
    requests: outcome.requests,
    latency_ms: Math.round(outcome.latencyMs),
    pinned_model: config.model,
    answered_by: outcome.model,
    drift: outcome.drift,
    scores: outcome.scores,
    ...existing,
    category: outcome.failure?.category ?? "none",
    detail: outcome.failure?.detail ?? "none",
  };
}
