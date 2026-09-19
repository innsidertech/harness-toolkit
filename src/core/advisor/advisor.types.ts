import type { JevTransport } from "../jev/jev.transport.ts";

/**
 * `record` asks, writes the reading beside what the existing rule decided, and changes nothing. `apply` lets the
 * reading decide, and exists only where a wrong answer is cheap.
 *
 * why record is what every use ships in: none of these questions has been measured against real work, and a number
 * nobody has compared with the rule it would replace is not a reason to replace it
 * ([/decisions/ad-148.md](/decisions/ad-148.md)).
 */
type AdvisorMode = "off" | "record";

export type AdvisorUse = "lessonRank" | "shipClaim" | "commentNarration" | "stagnation";

export type JevAdvisorConfig = JevTransport & {
  enabled: boolean;
  /** The only use with `apply`: a lesson ranked badly costs one less useful paragraph, and nothing else. */
  lessonRank: AdvisorMode | "apply";
  shipClaim: AdvisorMode;
  commentNarration: AdvisorMode;
  stagnation: AdvisorMode;
  /** Text handed to a question is cut here, for the same reason the judge cuts an entry. */
  maxChars: number;
};

export const DEFAULT_JEV_ADVISOR: JevAdvisorConfig = {
  enabled: false,
  lessonRank: "off",
  shipClaim: "off",
  commentNarration: "off",
  stagnation: "off",
  maxChars: 4000,
  // invariant: the judge's transport defaults, so one machine's measurements describe both.
  model: "jev-1.13.0",
  timeoutMs: 2500,
  concurrency: 8,
  trace: false,
};

const MODE_FIELDS = ["lessonRank", "shipClaim", "commentNarration", "stagnation"] as const;
const POSITIVE_FIELDS = ["timeoutMs", "concurrency", "maxChars"] as const;

function modeErrors(config: Partial<JevAdvisorConfig>): string[] {
  return MODE_FIELDS.filter((field) => {
    const value = config[field];
    const allowed = field === "lessonRank" ? ["off", "record", "apply"] : ["off", "record"];
    return value !== undefined && !allowed.includes(value as string);
  }).map(
    (field) =>
      `intelligence.jev.${field} must be ${field === "lessonRank" ? "off, record or apply" : "off or record"}, got ${JSON.stringify(config[field])}`,
  );
}

function numberErrors(config: Partial<JevAdvisorConfig>): string[] {
  const errors: string[] = [];
  for (const field of POSITIVE_FIELDS) {
    const value = config[field];
    if (value === undefined) {
      continue;
    }
    const whole = field !== "concurrency" || Number.isInteger(value);
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || !whole) {
      errors.push(
        `intelligence.jev.${field} must be a positive ${field === "concurrency" ? "whole " : ""}number, got ${JSON.stringify(value)}`,
      );
    }
  }
  return errors;
}

/**
 * invariant: pure, and it reports rather than corrects — the same contract as the judge's own validator, for the
 * same reason: a value silently replaced by a default is an inert control ([/decisions/ad-076.md](/decisions/ad-076.md)).
 */
export function advisorConfigErrors(config: Partial<JevAdvisorConfig> | undefined): string[] {
  if (config === undefined || config === null) {
    return [];
  }
  const errors = [...modeErrors(config), ...numberErrors(config)];
  if (config.trace !== undefined && typeof config.trace !== "boolean") {
    errors.push(`intelligence.jev.trace must be true or false, got ${JSON.stringify(config.trace)}`);
  }
  const model = config.model;
  if (
    model !== undefined &&
    (typeof model !== "string" || model.trim() === "" || model.endsWith("-latest"))
  ) {
    errors.push(
      `intelligence.jev.model must name a pinned version such as ${DEFAULT_JEV_ADVISOR.model}, got ${JSON.stringify(model)}`,
    );
  }
  return errors;
}
