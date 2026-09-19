import { nextDelay } from "./backoff.ts";

/**
 * The System One endpoint, as one request against one small state.
 *
 * hazard: this is the only module in the harness that sends anything off the machine. Every caller is behind an
 * opt-in capability that is off by default, and nothing here reads a credential from project configuration
 * ([/decisions/ad-146.md](/decisions/ad-146.md)).
 *
 * invariant: it never throws to its caller. A hook has ten seconds and one job, and an exception on this path
 * would turn a third party's bad afternoon into a broken turn.
 */
export const SYSTEMONE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/**
 * A question whose answer is one probability.
 *
 * why `criteria` is required rather than optional: the service reads the instruction literally, and an answer with
 * no stated true/false condition is the documented way to get a number that means something else than it looks.
 */
export type NoulQuestion = {
  type: "noul";
  instructions: string;
  criteria: { true: string; false: string };
};

export type SystemOneRequest = {
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, NoulQuestion>;
};

/**
 * Why a call did not produce a reading, in the terms a record is counted by.
 *
 * why no `unavailable`: retries are bounded by the shared deadline and by nothing else, so a service that keeps
 * answering `429` ends in `timeout` rather than in a sixth state whose difference from it nobody could act on.
 */
export type TypesafeErrorCategory = "invalid-request" | "auth" | "timeout" | "invalid-response" | "network";

export type SystemOneOk = {
  ok: true;
  /** Question id to probability, already checked to be finite numbers. */
  answers: Record<string, number>;
  /** The version that actually answered, which is the only signal that the pin moved. */
  model: string;
  inputTokens: number;
  latencyMs: number;
};

export type SystemOneError = {
  ok: false;
  category: TypesafeErrorCategory;
  /** One line for an operator, never a body dump and never a header. */
  detail: string;
  latencyMs: number;
};

export type SystemOneResult = SystemOneOk | SystemOneError;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type SystemOneOptions = {
  apiKey: string;
  /** The one budget the request and every retry of it draw on together. */
  timeoutMs: number;
  /** Injected so no test in this repository touches the network. */
  fetchImpl?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

/** invariant: retried on these and on nothing else. A validation fault repeated is the same validation fault. */
const RETRYABLE_STATUS = new Set([429, 529]);

/**
 * hazard: the docs say `422` for a validation fault and an open report says the API answers `400`. Both are the
 * same event and neither is worth a second attempt, so both land here.
 */
const INVALID_REQUEST_STATUS = new Set([400, 422]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ParsedBody = {
  model?: unknown;
  answers?: unknown;
  usage?: unknown;
};

/**
 * why a parse that refuses rather than defaults: a coerced `0` is a probability that routes, and a question that
 * silently answered zero is indistinguishable from a question the service declined to answer.
 */
function readAnswers(body: ParsedBody, ids: readonly string[]): Record<string, number> | string {
  const answers = body.answers;
  if (answers === null || typeof answers !== "object") {
    return "no answers object";
  }
  const out: Record<string, number> = {};
  for (const id of ids) {
    const answer = (answers as Record<string, unknown>)[id];
    if (answer === null || typeof answer !== "object") {
      return `no answer for ${id}`;
    }
    const { type, noul } = answer as { type?: unknown; noul?: unknown };
    if (type !== "noul") {
      return `answer for ${id} is ${typeof type === "string" ? type : "untyped"}, not noul`;
    }
    if (typeof noul !== "number" || !Number.isFinite(noul)) {
      return `answer for ${id} carries no finite noul`;
    }
    out[id] = noul;
  }
  return out;
}

function inputTokensOf(body: ParsedBody): number {
  const usage = body.usage;
  if (usage === null || typeof usage !== "object") {
    return 0;
  }
  const tokens = (usage as { input_tokens?: unknown }).input_tokens;
  return typeof tokens === "number" && Number.isFinite(tokens) ? tokens : 0;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

type Failure = { category: TypesafeErrorCategory; detail: string };

/** The three things a status can mean here, decided in one place so the loop below reads as a loop. */
type StatusVerdict = { kind: "usable" } | { kind: "retry" } | ({ kind: "failed" } & Failure);

function verdictForStatus(status: number): StatusVerdict {
  if (status === 401 || status === 403) {
    return { kind: "failed", category: "auth", detail: `service answered ${status}` };
  }
  if (INVALID_REQUEST_STATUS.has(status)) {
    return { kind: "failed", category: "invalid-request", detail: `service answered ${status}` };
  }
  if (RETRYABLE_STATUS.has(status)) {
    return { kind: "retry" };
  }
  if (status < 200 || status >= 300) {
    return { kind: "failed", category: "network", detail: `service answered ${status}` };
  }
  return { kind: "usable" };
}

type Reading = { answers: Record<string, number>; model: string; inputTokens: number };

async function readBody(response: Response, ids: readonly string[]): Promise<Reading | Failure> {
  let parsed: ParsedBody;
  try {
    parsed = (await response.json()) as ParsedBody;
  } catch {
    return { category: "invalid-response", detail: "body is not JSON" };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { category: "invalid-response", detail: "body is not an object" };
  }
  const answers = readAnswers(parsed, ids);
  if (typeof answers === "string") {
    return { category: "invalid-response", detail: answers };
  }
  return {
    answers,
    // why: reported as it came back, never defaulted to the pin. A missing version is drift that cannot be told
    // from agreement if the pin is substituted for it.
    model: typeof parsed.model === "string" ? parsed.model : "(absent)",
    inputTokens: inputTokensOf(parsed),
  };
}

/**
 * Ask one System One request and return a discriminated result.
 *
 * invariant: one `timeoutMs` covers the request and every retry together, because the hook's budget is wall-clock.
 * A per-attempt timeout with three attempts spends three times what the operator agreed to
 * ([/decisions/ad-012.md](/decisions/ad-012.md)).
 */
export async function askSystemOne(
  request: SystemOneRequest,
  options: SystemOneOptions,
): Promise<SystemOneResult> {
  const {
    apiKey,
    timeoutMs,
    fetchImpl = globalThis.fetch as FetchLike,
    now = () => Date.now(),
    sleep = defaultSleep,
    random = Math.random,
  } = options;

  const started = now();
  const deadline = started + timeoutMs;
  const ids = Object.keys(request.questions);
  const body = JSON.stringify(request);
  const failed = (failure: Failure): SystemOneError => ({
    ok: false,
    category: failure.category,
    detail: failure.detail,
    latencyMs: now() - started,
  });

  async function send(remaining: number): Promise<Response | Failure> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      return await fetchImpl(SYSTEMONE_ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbort(error) || now() >= deadline) {
        return { category: "timeout", detail: `aborted after ${timeoutMs} ms` };
      }
      return { category: "network", detail: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  for (let attempt = 0; ; attempt++) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      return failed({ category: "timeout", detail: `no budget left after ${attempt} attempts` });
    }

    const sent = await send(remaining);
    if (!(sent instanceof Response)) {
      return failed(sent);
    }

    const verdict = verdictForStatus(sent.status);
    if (verdict.kind === "failed") {
      return failed(verdict);
    }
    if (verdict.kind === "retry") {
      // why: the wait is capped by what is left of the budget, so a backoff cannot outlive the request it serves.
      const wait = Math.min(
        nextDelay({ attempt, baseMs: 50, capMs: 2000, random }),
        Math.max(0, deadline - now()),
      );
      await sleep(wait);
      continue;
    }

    const reading = await readBody(sent, ids);
    if ("category" in reading) {
      return failed(reading);
    }
    return { ok: true, ...reading, latencyMs: now() - started };
  }
}
