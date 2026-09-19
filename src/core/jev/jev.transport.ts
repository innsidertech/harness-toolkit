import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { machineHome } from "../../platform/paths.ts";
import {
  askSystemOne,
  type SystemOneAttempt,
  type SystemOneRequest,
  type SystemOneResult,
} from "../../platform/typesafe.ts";
import { type JevTraceTarget, traceExchange } from "./jev.trace.ts";

/**
 * What every use of Jev shares: where the key comes from, and one wall-clock budget over a bounded fan-out.
 *
 * why apart from the judge: the judge was the first caller and is not the only one. A second caller importing the
 * key and the budget out of the untrusted-content rail would make that rail a dependency of things that have
 * nothing to do with untrusted content ([/decisions/ad-148.md](/decisions/ad-148.md)).
 */
export type JevTransport = {
  model: string;
  timeoutMs: number;
  concurrency: number;
  /**
   * Keep every exchange — the body sent and the answer as it arrived — in `state/jev-trace.jsonl`.
   *
   * hazard: off by default, because it is the only switch that puts the sent text on disk. The obs records stay
   * numbers whatever this says ([/decisions/ad-149.md](/decisions/ad-149.md)).
   */
  trace: boolean;
};

/** why a file rather than the environment alone: measured — a hook inherits the host's environment, and no host
 * passes an arbitrary variable through, so an environment-only rule would ship a capability nobody could switch on.
 * The machine home is the plane `model-prices.json` already uses: machine state, never versioned, outside any
 * repository. A project config field stays forbidden — it puts a live credential in a file git tracks. */
export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(machineHome(env), "credentials.json");
}

export function resolveApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.TYPESAFE_API_KEY?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const path = credentialsPath(env);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { typesafeApiKey?: unknown };
    const key = typeof parsed.typesafeApiKey === "string" ? parsed.typesafeApiKey.trim() : "";
    return key === "" ? null : key;
  } catch {
    // invariant: unreadable reads as absent, which `doctor` then names. A throw here would break the turn over a
    // malformed file that belongs to a capability the operator opted into.
    return null;
  }
}

export type AskFn = (
  request: SystemOneRequest,
  apiKey: string,
  timeoutMs: number,
  observe?: (attempt: SystemOneAttempt) => void,
) => Promise<SystemOneResult>;

export const liveAsk: AskFn = (request, apiKey, timeoutMs, observe) =>
  askSystemOne(request, { apiKey, timeoutMs, ...(observe ? { observe } : {}) });

/**
 * invariant: at most `concurrency` requests outstanding. Eight 8,000-character entries at `concurrency` 8 are one
 * wave at roughly the single-request p95, which is the number the added latency target was written to mean.
 *
 * hazard: the recall bounds characters and not entries, so forty short reads are forty requests and five waves.
 * The waves share the run's one deadline for that reason, rather than each request bringing a budget of its own.
 */
async function inWaves<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  // hazard: `new Array(2.5)` throws, and a throw here reaches the handler as an adapter error on every command.
  const width = Math.max(1, Math.min(Math.floor(limit), items.length));
  const workers = new Array(width).fill(0).map(async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) {
        return;
      }
      results[index] = await run(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

/** One budget for a whole run, whoever is asking — the command-time judge and the read-time screen alike. */
export function askWithinBudget(args: {
  requests: readonly SystemOneRequest[];
  judge: JevTransport;
  key: string;
  ask: AskFn;
  now: () => number;
  started: number;
  /** Where a trace goes and who is asking. Read only when `judge.trace` is on. */
  trace?: JevTraceTarget;
}): Promise<SystemOneResult[]> {
  const deadline = args.started + args.judge.timeoutMs;
  const target = args.judge.trace ? args.trace : undefined;
  const indexed = args.requests.map((request, index) => ({ request, index }));
  return inWaves(indexed, args.judge.concurrency, async ({ request, index }): Promise<SystemOneResult> => {
    const attempts: SystemOneAttempt[] = [];
    const remaining = deadline - args.now();
    // why: a request the budget never let out is traced too, because "nothing was sent" is part of what happened.
    const result: SystemOneResult =
      remaining <= 0
        ? {
            ok: false,
            category: "timeout",
            detail: `run budget of ${args.judge.timeoutMs} ms spent before this request was sent`,
            latencyMs: 0,
          }
        : await args.ask(
            request,
            args.key,
            remaining,
            target ? (attempt) => attempts.push(attempt) : undefined,
          );
    if (target) {
      traceExchange(target, {
        ts: new Date(args.now()).toISOString(),
        index,
        of: args.requests.length,
        request,
        attempts,
        result,
      });
    }
    return result;
  });
}
