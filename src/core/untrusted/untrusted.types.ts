export type UntrustedSource = "web" | "mcp" | "shell";

export type UntrustedHit = {
  source: UntrustedSource;
  detail: string;
};

export type UntrustedDetectInput = {
  event: string;
  toolName?: string;
  command?: string;
  tools: readonly string[];
  commandPatterns: readonly string[];
};

/**
 * `frame` states once per turn that outside content is data. `enforce` adds the question framing cannot ask —
 * did this command come from that content — and answers it verbatim
 * ([/decisions/ad-077.md](/decisions/ad-077.md)).
 */
export type UntrustedMode = "frame" | "enforce";

/**
 * `record` makes the call, writes the reading and returns `abstain`; `ask` puts the command to the operator.
 *
 * why record is the default an operator gets when they first switch the judge on: the thresholds ship from a spike
 * of twenty cases their own author wrote, which is a direction and not a calibration. It still costs money and
 * latency, which is the point — a shadow that does not pay the real cost does not measure it
 * ([/decisions/ad-146.md](/decisions/ad-146.md)).
 */
type UntrustedJudgeMode = "record" | "ask";

export type UntrustedJudgeConfig = {
  enabled: boolean;
  mode: UntrustedJudgeMode;
  thresholds: {
    contentInstructsAgent: number;
    commandFollowsContent: number;
  };
  timeoutMs: number;
  concurrency: number;
  maxEntryChars: number;
  maxOperatorPromptChars: number;
  /** invariant: pinned. `jev-latest` moves without notice, and every threshold is tuned against one version. */
  model: string;
};

export type UntrustedPolicyConfig = {
  enabled: boolean;
  mode: UntrustedMode;
  extraTools: string[];
  extraCommandPatterns: string[];
  judge: UntrustedJudgeConfig;
};

/**
 * hazard: these thresholds are the spike's, not a calibration — 0.50/0.55 was the widest pair that still asked on
 * nothing benign across twenty authored cases. The PRD's 0.70/0.80 cost three of ten injections for no gain in
 * false asks, so shipping those would have been worse and neither number is defensible as final. The calibration
 * task replaces them before `ask` is recommended to anybody.
 */
export const DEFAULT_UNTRUSTED_JUDGE: UntrustedJudgeConfig = {
  enabled: false,
  mode: "record",
  thresholds: {
    contentInstructsAgent: 0.5,
    commandFollowsContent: 0.55,
  },
  // why: 2500 ms against a measured 600 ms p95 for one request, with concurrency 8 putting a full 64,000-character
  // recall in one wave. Three seconds of wait before every shell command gets the rail switched off in a week
  // ([/decisions/ad-034.md](/decisions/ad-034.md)).
  timeoutMs: 2500,
  concurrency: 8,
  maxEntryChars: 8000,
  maxOperatorPromptChars: 4000,
  model: "jev-1.13.0",
};

const PROBABILITY_FIELDS = ["contentInstructsAgent", "commandFollowsContent"] as const;
const POSITIVE_FIELDS = ["timeoutMs", "concurrency", "maxEntryChars", "maxOperatorPromptChars"] as const;

/**
 * The judge fields whose value cannot be read as anything, named one by one.
 *
 * why named rather than counted: an operator reading "invalid judge config" has to bisect their own file. The
 * field and what it accepts is the whole remediation ([/decisions/ad-076.md](/decisions/ad-076.md)).
 *
 * invariant: pure, and it reports rather than corrects. The loader decides what to do with a rejection, because a
 * value silently replaced by a default is the inert control this project keeps removing.
 */
export function judgeConfigErrors(judge: Partial<UntrustedJudgeConfig> | undefined): string[] {
  if (judge === undefined || judge === null) {
    return [];
  }
  const errors: string[] = [];
  for (const field of PROBABILITY_FIELDS) {
    const value = judge.thresholds?.[field];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      errors.push(
        `untrustedContent.judge.thresholds.${field} must be a number between 0 and 1, got ${JSON.stringify(value)}`,
      );
    }
  }
  for (const field of POSITIVE_FIELDS) {
    const value = judge[field];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      errors.push(`untrustedContent.judge.${field} must be a positive number, got ${JSON.stringify(value)}`);
    }
  }
  if (judge.mode !== undefined && judge.mode !== "record" && judge.mode !== "ask") {
    errors.push(`untrustedContent.judge.mode must be record or ask, got ${JSON.stringify(judge.mode)}`);
  }
  return errors;
}

// why: a declared list, never an inference over output. Guessing whether text came from outside the repo
// would make the rail fire on ordinary work and teach the operator to ignore it. Each entry is matched at
// the start of a command segment, so naming one inside a string or a heredoc is not a read.
export const DEFAULT_UNTRUSTED_COMMAND_PATTERNS = [
  "gh pr view",
  "gh pr diff",
  "gh pr list",
  "gh issue view",
  "gh issue list",
  "gh api",
  "curl",
  "wget",
] as const;
