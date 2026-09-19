import type { Decision } from "../../contracts/decision.ts";
import type {
  NoulQuestion,
  SystemOneRequest,
  SystemOneResult,
  TypesafeErrorCategory,
} from "../../platform/typesafe.ts";
import {
  type AskFn,
  askWithinBudget,
  credentialsPath,
  liveAsk,
  resolveApiKey,
} from "../jev/jev.transport.ts";
import { maskSecrets } from "../secret-scan/secret-scan.service.ts";
import { placeholderFor } from "../secret-scan/secret-scan.store.ts";
import {
  ACTION_FIELD,
  instructsQuestion,
  type JudgeActionKind,
  QUESTION_IDS,
  questionsFor,
} from "./untrusted.judge.questions.ts";
import { readOperatorPrompt } from "./untrusted.prompt.ts";
import { normalise, type Recall, type RecallEntry } from "./untrusted.recall.ts";
import { readRecall, writeRecall } from "./untrusted.store.ts";
import type { UntrustedJudgeConfig, UntrustedPolicyConfig } from "./untrusted.types.ts";

export { type AskFn, credentialsPath, QUESTION_IDS, resolveApiKey };

/** The rule an operator sees on the ask, and the name this rail is counted by in the rollup. */
export const JUDGE_RULE = "untrusted-judge";

/** One entry's answers, plus what produced them. Never the content text and never the prompt. */
type JudgeReading = {
  source: string;
  instructs: number;
  follows: number;
  /** Null when the session had no stored prompt, so the third question was not asked. */
  serves: number | null;
  model: string;
  inputTokens: number;
  latencyMs: number;
  /** Whether the version that answered differs from the pin. */
  drift: boolean;
};

export type JudgeOutcome = {
  decision: Decision;
  /**
   * `skipped` is the state that costs nothing and is recorded by nothing: disabled, `frame` mode, or an empty
   * recall. A row for it on every command in every session would be the noise AD-034 names.
   */
  outcome: "ask" | "abstain" | "skipped";
  readings: JudgeReading[];
  /**
   * The entry that cleared both thresholds, in either mode.
   *
   * why beside `outcome` rather than folded into it: `record` abstains on a clearing entry by design, so the outcome
   * alone cannot say how often `ask` mode would have interrupted — and that rate is what `record` exists to measure
   * ([/decisions/ad-146.md](/decisions/ad-146.md)).
   */
  cleared: JudgeReading | null;
  failure?: { category: TypesafeErrorCategory; detail: string };
  requests: number;
  /** Chunks the read-time screen put below the first threshold, so no request was spent on them. */
  screenedOut: number;
  /** The action the run was about, masked and cut the way the ask shows it. Empty when nothing ran. */
  commandExcerpt: string;
  kind: JudgeActionKind;
  inputTokens: number;
  latencyMs: number;
};

const SKIPPED: JudgeOutcome = {
  decision: { kind: "abstain" },
  outcome: "skipped",
  readings: [],
  cleared: null,
  requests: 0,
  screenedOut: 0,
  commandExcerpt: "",
  kind: "command",
  inputTokens: 0,
  latencyMs: 0,
};

/**
 * why chunked in code rather than sent whole: the documented failure is accuracy loss as the state fills with
 * material the question does not need, and a 64,000-character recall is that failure by construction. A chunk that
 * clears the thresholds is an entry that clears them, so attribution stays at the entry.
 */
export function chunk(text: string, maxChars: number): string[] {
  if (maxChars <= 0 || text.length <= maxChars) {
    return [text];
  }
  const out: string[] = [];
  for (let at = 0; at < text.length; at += maxChars) {
    out.push(text.slice(at, at + maxChars));
  }
  return out;
}

/** `screened` is the `content_instructs_agent` score taken when the entry was read, when there is a usable one. */
export type JudgeTask = { source: string; text: string; screened?: number };

/** invariant: a screen taken with another model or another chunk size is unread, so its chunks are asked in full. */
function screenFor(entry: RecallEntry, judge: UntrustedJudgeConfig, pieces: number): number[] | null {
  const screen = entry.screen;
  if (!screen || screen.model !== judge.model || screen.maxEntryChars !== judge.maxEntryChars) {
    return null;
  }
  return screen.instructs.length === pieces ? screen.instructs : null;
}

export function tasksFor(recall: Recall, judge: UntrustedJudgeConfig): JudgeTask[] {
  const tasks: JudgeTask[] = [];
  for (const entry of recall.entries) {
    const pieces = chunk(entry.text, judge.maxEntryChars);
    const screen = screenFor(entry, judge, pieces.length);
    for (const [index, piece] of pieces.entries()) {
      tasks.push({
        source: entry.source,
        text: piece,
        ...(screen === null ? {} : { screened: screen[index] as number }),
      });
    }
  }
  return tasks;
}

export function requestFor(args: {
  judge: UntrustedJudgeConfig;
  kind: JudgeActionKind;
  action: string;
  prompt: string | null;
  task: JudgeTask;
}): SystemOneRequest {
  const asked = questionsFor(args.kind);
  const { instructs, follows, serves } = QUESTION_IDS;
  // why: with no stored prompt the third question is left out rather than sent against an empty field. An empty
  // field is state the question does not need, which is the accuracy loss this design is built around.
  // why: a chunk screened at the read already has its first answer, and asking again pays for a number that the
  // command cannot change.
  const questions: Record<string, NoulQuestion> = {
    ...(args.task.screened === undefined ? { [instructs]: instructsQuestion() } : {}),
    [follows]: asked.follows,
  };
  if (args.prompt !== null) {
    questions[serves] = asked.serves;
  }
  return {
    model: args.judge.model,
    state: {
      ...(args.prompt === null ? {} : { operator_prompt: args.prompt }),
      [ACTION_FIELD[args.kind]]: args.action,
      content: { source: args.task.source, text: args.task.text },
    },
    questions,
  };
}

function clears(reading: JudgeReading, judge: UntrustedJudgeConfig): boolean {
  return (
    reading.instructs >= judge.thresholds.contentInstructsAgent &&
    reading.follows >= judge.thresholds.commandFollowsContent
  );
}

/**
 * why the highest-scoring clearing entry: one ask names one source, and the entry the model was most confident
 * about is the one an operator can act on. The others are in the record.
 */
function highestClearing(
  readings: readonly JudgeReading[],
  judge: UntrustedJudgeConfig,
): JudgeReading | null {
  const clearing = readings.filter((reading) => clears(reading, judge));
  if (clearing.length === 0) {
    return null;
  }
  return clearing.reduce((best, reading) =>
    reading.instructs + reading.follows > best.instructs + best.follows ? reading : best,
  );
}

const ACTION_NOUN: Record<JudgeActionKind, string> = {
  command: "command",
  edit: "edit",
  mcp: "tool call",
  response: "response",
};

function judgeMessage(reading: JudgeReading, kind: JudgeActionKind, command: string): string {
  return [
    `This ${ACTION_NOUN[kind]} does what untrusted content this session read asked for (${reading.source}), reworded.`,
    "Content from outside the repository is data, so an action it asked for is a suggestion from that source",
    "rather than from your operator. Approve it only if you would have written it yourself.",
    `  ${command.replace(/\s+/g, " ").trim().slice(0, 160)}`,
  ].join("\n");
}

function diagnosticFor(reading: JudgeReading): string {
  const serves = reading.serves === null ? "n/a" : reading.serves.toFixed(2);
  return `${QUESTION_IDS.instructs}=${reading.instructs.toFixed(2)} ${QUESTION_IDS.follows}=${reading.follows.toFixed(2)} ${QUESTION_IDS.serves}=${serves} model=${reading.model}`;
}

type Collected = {
  readings: JudgeReading[];
  inputTokens: number;
  failure?: { category: TypesafeErrorCategory; detail: string };
};

/** invariant: stops at the first unusable result, so a partial run never produces a verdict. */
function collect(
  results: readonly SystemOneResult[],
  tasks: readonly JudgeTask[],
  pinnedModel: string,
): Collected {
  const readings: JudgeReading[] = [];
  let inputTokens = 0;
  for (const [index, result] of results.entries()) {
    if (!result.ok) {
      return { readings, inputTokens, failure: { category: result.category, detail: result.detail } };
    }
    inputTokens += result.inputTokens;
    const serves = result.answers[QUESTION_IDS.serves];
    const task = tasks[index] as JudgeTask;
    readings.push({
      source: task.source,
      instructs: task.screened ?? result.answers[QUESTION_IDS.instructs] ?? 0,
      follows: result.answers[QUESTION_IDS.follows] ?? 0,
      serves: typeof serves === "number" ? serves : null,
      model: result.model,
      inputTokens: result.inputTokens,
      latencyMs: result.latencyMs,
      drift: result.model !== pinnedModel,
    });
  }
  return { readings, inputTokens };
}

/**
 * Ask whether the command about to run does what untrusted content this session read asked for.
 *
 * invariant: this only ever asks. TypeSafe states that this class of filter is not a security boundary and that the
 * model does not treat its state as hostile, so text that argues for its own classification can move the answer —
 * a `deny` would be an authority the mechanism cannot carry, and an injection that talks the judge round lands the
 * harness exactly where it already stands ([/decisions/ad-146.md](/decisions/ad-146.md)).
 *
 * invariant: every failure yields `abstain` and none of them is silent. A network fault must not stop an operator's
 * command, and a control that is inert without saying so is worse than no control
 * ([/decisions/ad-076.md](/decisions/ad-076.md)).
 */
export function judgeShellCommand(args: {
  root: string;
  sessionKey: string;
  command: string | undefined;
  config: UntrustedPolicyConfig;
  env?: NodeJS.ProcessEnv;
  ask?: AskFn;
  now?: () => number;
}): Promise<JudgeOutcome> {
  return judgeAction({ ...args, kind: "command", action: args.command });
}

/**
 * The same judgement over anything the agent is about to do, or has just said.
 *
 * invariant: a kind outside `judge.scope` is `skipped` — no read, no request, no record. Only `command` is in scope
 * by default, so an install that enabled the judge before the other kinds existed sends exactly what it sent then.
 *
 * hazard: `response` has already reached the operator when it is judged, so nothing can ask about it. It is
 * recorded, in either mode, and routes nothing.
 */
export async function judgeAction(args: {
  root: string;
  sessionKey: string;
  kind: JudgeActionKind;
  action: string | undefined;
  config: UntrustedPolicyConfig;
  env?: NodeJS.ProcessEnv;
  ask?: AskFn;
  now?: () => number;
}): Promise<JudgeOutcome> {
  const judge = args.config.judge;
  if (!judge.scope[args.kind]) {
    return SKIPPED;
  }
  // why: every branch that costs anything is behind this. Disabled means no read, no request and no record, so an
  // upgraded install spends on `shell.before` exactly what it spent before the judge existed.
  if (!args.config.enabled || !judge.enabled || args.config.mode !== "enforce" || !args.action) {
    return SKIPPED;
  }

  const recall = readRecall(args.root, args.sessionKey);
  if (recall.entries.length === 0) {
    return SKIPPED;
  }

  const now = args.now ?? (() => Date.now());
  const started = now();
  const key = resolveApiKey(args.env ?? process.env);
  if (key === null) {
    return {
      decision: { kind: "abstain" },
      outcome: "abstain",
      readings: [],
      cleared: null,
      failure: {
        category: "auth",
        detail: `no key in TYPESAFE_API_KEY or ${credentialsPath(args.env ?? process.env)}`,
      },
      requests: 0,
      screenedOut: 0,
      commandExcerpt: "",
      kind: args.kind,
      inputTokens: 0,
      latencyMs: now() - started,
    };
  }

  // invariant: unconditional. `secrets.redactOutput` is an operator's choice about what their own agent sees; it
  // was never consent to send a credential to a third party, and nothing sent can be taken back.
  const mask = (text: string): string =>
    maskSecrets(text, (matchedText, kind) => placeholderFor(args.root, args.sessionKey, matchedText, kind));

  const prompt = readOperatorPrompt(args.root, args.sessionKey);
  const every = tasksFor(recall, judge);
  // why: content that does not address an agent cannot clear whatever the command is, so a chunk the read-time
  // screen put below the first threshold is not asked about again. A session that only read ordinary pages then
  // pays nothing per command, which is most sessions.
  const tasks = every
    .filter((task) => task.screened === undefined || task.screened >= judge.thresholds.contentInstructsAgent)
    .map((task) => ({ ...task, text: mask(task.text) }));
  if (tasks.length === 0) {
    return SKIPPED;
  }
  const screenedOut = every.length - tasks.length;
  // why: cut, because an edit or a response can be as long as a file, and the question is about what it does, which its
  // opening states. The cap is the one the content already has.
  const action = mask(args.action.slice(0, judge.maxEntryChars));
  const commandExcerpt = normalise(action).slice(0, 160);
  const maskedPrompt = prompt === null ? null : mask(prompt);
  const ask = args.ask ?? liveAsk;

  // invariant: one `timeoutMs` covers the whole run, waves included, because the wait before the operator's
  // command is wall-clock. A request that finds the budget spent is never sent, and collapses the run as a timeout
  // like any other ([/decisions/ad-012.md](/decisions/ad-012.md)).
  const results = await askWithinBudget({
    requests: tasks.map((task) => requestFor({ judge, kind: args.kind, action, prompt: maskedPrompt, task })),
    judge,
    key,
    ask,
    now,
    started,
  });

  const collected = collect(results, tasks, judge.model);
  const readings = collected.readings;
  const inputTokens = collected.inputTokens;
  if (collected.failure) {
    // invariant: one bad request collapses the whole run. A verdict computed from the entries that happened to
    // answer would report a judgement over a recall it did not see.
    return {
      decision: { kind: "abstain" },
      outcome: "abstain",
      readings,
      cleared: null,
      failure: collected.failure,
      requests: results.length,
      screenedOut,
      commandExcerpt,
      kind: args.kind,
      inputTokens,
      latencyMs: now() - started,
    };
  }

  const hit = highestClearing(readings, judge);
  const base = {
    readings,
    cleared: hit,
    requests: results.length,
    screenedOut,
    commandExcerpt,
    kind: args.kind,
    inputTokens,
    latencyMs: now() - started,
  };
  // why: the reading is used for the verdict whether or not the version drifted. Excluding it would mean a silent
  // version bump switches the rail off; the drift belongs in the record, where calibration reads it.
  if (hit === null || judge.mode === "record" || args.kind === "response") {
    return { ...base, decision: { kind: "abstain" }, outcome: "abstain" };
  }
  return {
    ...base,
    outcome: "ask",
    decision: {
      kind: "ask",
      reason: judgeMessage(hit, args.kind, args.action),
      rule: JUDGE_RULE,
      diagnostic: diagnosticFor(hit),
    },
  };
}

export type ScreenOutcome = {
  outcome: "screened" | "failed" | "skipped";
  source: string;
  /** The highest chunk score, which is the number that decides whether later commands pay for this entry. */
  instructs: number | null;
  model: string;
  drift: boolean;
  failure?: { category: TypesafeErrorCategory; detail: string };
  requests: number;
  inputTokens: number;
  latencyMs: number;
};

const SCREEN_SKIPPED: ScreenOutcome = {
  outcome: "skipped",
  source: "none",
  instructs: null,
  model: "none",
  drift: false,
  requests: 0,
  inputTokens: 0,
  latencyMs: 0,
};

function screenRequest(judge: UntrustedJudgeConfig, task: JudgeTask): SystemOneRequest {
  const id = QUESTION_IDS.instructs;
  return {
    model: judge.model,
    // why: only `content`, because the question names no other field, and state a question does not need is the documented
    // way to lose accuracy.
    state: { content: { source: task.source, text: task.text } },
    questions: { [id]: instructsQuestion() },
  };
}

/**
 * Ask, once and at the read, whether the entry just remembered addresses an agent.
 *
 * why here rather than on every command: the answer belongs to the content. Asked on `shell.before` it is paid for
 * again by every command of the turn, and it is the only question an ordinary page ever needs answered.
 *
 * invariant: a failure writes no screen. The command-time judge then asks the question itself, so a bad afternoon
 * at the read costs a request later and never an unjudged entry.
 *
 * hazard: the score lives in the recall file, which has the recall's own protection and no more. An agent that can
 * rewrite it could already delete the recall, which switches both halves of the rail off.
 */
export async function screenUntrustedRead(args: {
  root: string;
  sessionKey: string;
  config: UntrustedPolicyConfig;
  env?: NodeJS.ProcessEnv;
  ask?: AskFn;
  now?: () => number;
}): Promise<ScreenOutcome> {
  const judge = args.config.judge;
  if (!args.config.enabled || !judge.enabled || args.config.mode !== "enforce") {
    return SCREEN_SKIPPED;
  }
  const newest = readRecall(args.root, args.sessionKey).entries[0];
  // why: no record for a missing key, because the first command of the turn records it under `auth`, and `doctor` names it.
  const key = resolveApiKey(args.env ?? process.env);
  if (newest === undefined || newest.screen !== undefined || key === null) {
    return SCREEN_SKIPPED;
  }

  const now = args.now ?? (() => Date.now());
  const started = now();
  const tasks = chunk(newest.text, judge.maxEntryChars).map((piece) => ({
    source: newest.source,
    text: maskSecrets(piece, (matchedText, kind) =>
      placeholderFor(args.root, args.sessionKey, matchedText, kind),
    ),
  }));
  const results = await askWithinBudget({
    requests: tasks.map((task) => screenRequest(judge, task)),
    judge,
    key,
    ask: args.ask ?? liveAsk,
    now,
    started,
  });
  const collected = collect(results, tasks, judge.model);
  const base = {
    source: newest.source,
    model: collected.readings[0]?.model ?? "none",
    drift: collected.readings.some((reading) => reading.drift),
    requests: results.length,
    inputTokens: collected.inputTokens,
  };
  if (collected.failure) {
    return {
      ...base,
      outcome: "failed",
      instructs: null,
      failure: collected.failure,
      latencyMs: now() - started,
    };
  }

  const instructs = collected.readings.map((reading) => reading.instructs);
  // hazard: another hook may have remembered a newer entry while this one was out on the network. The recall is
  // read again and the score attached to the entry it was taken from, never to whatever is first now.
  const current = readRecall(args.root, args.sessionKey);
  const entries = current.entries.map((entry) =>
    entry.source === newest.source && entry.text === newest.text && entry.screen === undefined
      ? { ...entry, screen: { model: judge.model, maxEntryChars: judge.maxEntryChars, instructs } }
      : entry,
  );
  writeRecall(args.root, args.sessionKey, { ...current, entries });
  return { ...base, outcome: "screened", instructs: Math.max(...instructs), latencyMs: now() - started };
}

/** The record for one read-time screen, in the same shape and under the same rail as a command-time run. */
export function screenObsAttrs(outcome: ScreenOutcome, judge: UntrustedJudgeConfig): Record<string, unknown> {
  return {
    rail: JUDGE_RULE,
    rule: JUDGE_RULE,
    phase: "read",
    outcome: outcome.failure ? `error:${outcome.failure.category}` : outcome.outcome,
    mode: judge.mode,
    requests: outcome.requests,
    latency_ms: Math.round(outcome.latencyMs),
    pinned_model: judge.model,
    answered_by: outcome.model,
    drift: outcome.drift,
    source: outcome.source,
    instructs: outcome.instructs,
    category: outcome.failure?.category ?? "none",
    detail: outcome.failure?.detail ?? "none",
  };
}

/**
 * The usage half of a judge record, in the `gen_ai` shape every cost consumer already reads.
 *
 * invariant: the input tokens are always reported. The cost is whatever the machine's price catalogue can say
 * about the answering model and `cost_source: "missing"` when it carries no rate for it — no price is versioned
 * in this repository, so a hardcoded Jev rate is not available to this design.
 */
export function judgeGenAi(
  outcome: { readings?: JudgeReading[]; model?: string; inputTokens: number; latencyMs: number },
  estimate: (model: string, inputTokens: number) => { costUsd: number | null; source: string },
): Record<string, unknown> {
  const answered = outcome.readings?.[0]?.model ?? outcome.model ?? "none";
  const cost = estimate(answered, outcome.inputTokens);
  return {
    input_tokens: outcome.inputTokens,
    output_tokens: 0,
    cost_usd: cost.costUsd,
    cost_source: cost.source,
    duration_ms: Math.round(outcome.latencyMs),
  };
}

/**
 * The record for one run, ready for `policy.observe`.
 *
 * invariant: sources, probabilities and metrics only. The content text and the operator's prompt are what this
 * rail sends to a third party; putting either in a local record as well would double the exposure for nothing.
 */
export function judgeObsAttrs(outcome: JudgeOutcome, judge: UntrustedJudgeConfig): Record<string, unknown> {
  // why: the clearing entry first, because the record has to describe the entry the verdict was about. The loudest
  // `instructs` is often a different entry, and its numbers then read as a run that never cleared.
  const top =
    outcome.cleared ??
    outcome.readings.reduce<JudgeReading | null>(
      (best, reading) => (best === null || reading.instructs > best.instructs ? reading : best),
      null,
    );
  return {
    rail: JUDGE_RULE,
    rule: JUDGE_RULE,
    outcome: outcome.failure ? `error:${outcome.failure.category}` : outcome.outcome,
    phase: "command",
    mode: judge.mode,
    cleared: outcome.cleared !== null,
    // why: the command and not only its readings, because a reading nobody can match to a command cannot be labelled, and
    // labelled readings are what calibration is made of. It is the agent's own command, masked, cut the way the
    // ask already shows it to the operator — never the content and never the prompt.
    action: outcome.kind,
    command: outcome.commandExcerpt,
    requests: outcome.requests,
    screened_out: outcome.screenedOut,
    entries: outcome.readings.length,
    latency_ms: Math.round(outcome.latencyMs),
    // hazard: the token count is not in `attrs`. `redactDeep` masks any attribute whose key matches
    // `token`, so `input_tokens` recorded here reads `[REDACTED]` in every record — measured. It belongs in
    // `gen_ai.input_tokens`, which is the field the report and the cost estimate already read.
    pinned_model: judge.model,
    answered_by: top?.model ?? "none",
    drift: outcome.readings.some((reading) => reading.drift),
    source: top?.source ?? "none",
    instructs: top?.instructs ?? null,
    follows: top?.follows ?? null,
    serves: top?.serves ?? null,
    category: outcome.failure?.category ?? "none",
    detail: outcome.failure?.detail ?? "none",
  };
}
