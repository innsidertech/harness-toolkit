import { join } from "node:path";
import type {
  Decision,
  FloorHostFacts,
  HarnessEvent,
  ProviderCapabilities,
  Rendered,
} from "../contracts/index.ts";
import { isWriteTool } from "../contracts/tool-names.ts";
import { coreFacade, type Policy } from "../core/index.ts";
import { appendRecord } from "../platform/fs-jsonl.ts";
import { projectStateDir } from "../platform/paths.ts";
import { readStdinText } from "../platform/process.ts";
import {
  degrade,
  type FailClosedPosture,
  type HookFailureCause,
  type ProviderPort,
  providers as providerRegistry,
  resolveFromRegistry,
} from "../providers/index.ts";
import { effectiveBlockedPatterns, obsConfigFor, sessionIdFromKey } from "./support.ts";

export type HandlerContext = {
  policy: Policy;
  capabilities: ProviderCapabilities;
  provider: ProviderPort;
  now: Date;
  protectedPaths: string[];
  /** The path the floor judges instead of the event's own, set only when an adapter matched a protected target through a path alias. */
  floorFilePath?: string;
  /** What the provider knows about this event that the floor needs to judge wiring routes; absent for a provider without the port member. */
  floorHostFacts?: FloorHostFacts;
};

export type Handler = (event: HarnessEvent, ctx: HandlerContext) => Decision | Promise<Decision>;

export type RunIo = {
  readStdin?: () => Promise<string>;
  now?: () => Date;
  /** Overrides the argv token after the handler; default hostEventOf(process.argv). `null` = no token. */
  hostEvent?: string | null;
  writeStderr?: (line: string) => void;
};

export type RunOutcome = {
  event: HarnessEvent | null;
  decision: Decision;
  rendered: Rendered;
  /** Set only when a fail-closed host's invocation ended in one of its failure responses. */
  failure?: HookFailureCause;
};

/** The token a wiring puts after the handler: `node <launcher> <handler> <token>` reaches here as `argv[2]`. */
export function hostEventOf(argv: readonly string[]): string | undefined {
  return argv[2];
}

/**
 * hazard: every provider's targets are protected in every session, not only the session's own host's. An agent
 * under one host that can edit another host's wiring switches that host's floor off for the next session there
 * ([/decisions/ad-156.md](/decisions/ad-156.md)).
 */
export function composeProtectedPaths(registry: readonly ProviderPort[], projectDir: string): string[] {
  return registry.flatMap((p) => [...p.wiringTargets(), ...(p.projectWiringTargets?.(projectDir) ?? [])]);
}

// invariant: this caps the whole injected context. Lessons carry their own, smaller budget
// (lessons.maxCharsSession) — reusing that here truncated the operator posture and handoff.
export const CONTEXT_BUDGET_CHARS = 6000;

/**
 * Whether this event may claim its file against other sessions.
 *
 * invariant: a claim exists so that two writers do not lose each other's work. A reader loses nothing, so a read
 * carries no claim however many files it opens ([/decisions/ad-099.md](/decisions/ad-099.md)).
 *
 * why `edit.after` with no tool name still claims: the write already happened, and the host does not always name
 * the tool on that event. An event that reports a completed edit is a writer by definition.
 */
export function claimsFile(event: HarnessEvent): boolean {
  if (event.filePath === undefined) {
    return false;
  }
  if (event.event === "edit.after") {
    return true;
  }
  return isWriteTool(event.toolName);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// why: ObsKind is a closed union with no adapter-boundary member — these fire before a provider/session is known, so they bypass core's typed observability rather than widening that union from outside core.
function recordAdapterEvent(
  root: string,
  kind: string,
  attrs: Record<string, unknown>,
  provider = "unknown",
  top: Record<string, unknown> = {},
): void {
  try {
    appendRecord(join(projectStateDir(root), "obs.jsonl"), {
      schema: "harness.observability.v1",
      provider,
      kind,
      level: "signal",
      ts: new Date().toISOString(),
      ...top,
      attrs,
    });
  } catch {}
}

// hazard: unscoped, one record per hook invocation of any kind flooded the signal plane and pushed
// `prompt.submit`/`policy.deny` out of two readers' fixed-count tails ([/decisions/ad-136.md](/decisions/ad-136.md)).
function isGateRelevantHookEvent(event: HarnessEvent): boolean {
  return event.event === "shell.before" || event.event === "mcp.before";
}

/**
 * AD-136 — a hook invocation that never reaches the point where any existing record gets written (the handler
 * killed mid-flight, a host-side timeout) previously left nothing in `obs.jsonl` at all — indistinguishable
 * from a hook that never started. This is the earliest point after an event is known: before `loadPolicy`,
 * before `handler` runs, before anything that could throw or take time. A future incident reads as "entered,
 * no paired completion" instead of being reconstructed from raw provider traces after the fact.
 */
function recordHookEnter(event: HarnessEvent): void {
  if (!isGateRelevantHookEvent(event)) {
    return;
  }
  recordAdapterEvent(
    event.projectDir,
    "hook.enter",
    { event: event.event, toolName: event.toolName ?? "none", sessionKey: event.sessionKey },
    event.provider,
    {
      trace_id: coreFacade.observability.deriveTraceId(event.sessionKey),
      session_id: event.sessionKey,
    },
  );
}

/**
 * hazard: `policy.deny` fed `rollup.denials` and the report's "Policy denials" line, and had no producer — so a
 * harness whose whole purpose is refusing things reported zero refusals
 * ([/decisions/ad-027.md](/decisions/ad-027.md)).
 *
 * why: recorded here, after `degrade`, because this is the one place every entrypoint's decision passes through
 * and the only place that sees the decision the provider will actually render. A per-entrypoint recording would
 * miss whichever entrypoint is added next, and would record a decision that degrade could still change.
 *
 * invariant: shell decisions are recorded by `tool-before` as `shell.start`, with their own permission attribute.
 * Recording them here as well would double-count every interruption.
 */
function recordRefusal(event: HarnessEvent, policy: Policy, decision: Decision): void {
  if (decision.kind !== "deny" && decision.kind !== "ask") {
    return;
  }
  if (event.event === "shell.before") {
    return;
  }
  coreFacade.observability.recordObs(event.projectDir, obsConfigFor(policy), {
    provider: event.provider,
    kind: "policy.deny",
    sessionKey: event.sessionKey,
    attrs: {
      event: event.event,
      tool_name: event.toolName,
      permission: decision.kind,
      // why: unattributed rather than guessed. A refusal an operator cannot trace to a rule is noise.
      rule: decision.rule ?? "none",
      diagnostic: decision.diagnostic ?? "none",
    },
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

type FailClosedOwner = ProviderPort & { readonly failClosed: FailClosedPosture };

type Resolution =
  | { kind: "resolved"; provider: ProviderPort; event: HarnessEvent }
  | { kind: "done"; outcome: RunOutcome };

/**
 * invariant: chosen from the argv token before stdin is read. A host that treats silence as consent needs a
 * refusal even when stdin is empty or unparseable, and by then there is no payload to detect a provider from
 * ([/decisions/ad-156.md](/decisions/ad-156.md)).
 */
function failClosedOwner(
  registry: readonly ProviderPort[],
  hostEvent: string | undefined,
): FailClosedOwner | null {
  if (hostEvent === undefined) {
    return null;
  }
  const owner = registry.find(
    (p) => p.failClosed !== undefined && hostEvent.startsWith(p.failClosed.hostEventPrefix),
  );
  return owner === undefined ? null : (owner as FailClosedOwner);
}

function resolveOpenInvocation(text: string, hostEvent: string | undefined): Resolution {
  const abstainRendered: Rendered = { stdout: null, exitCode: 0 };
  const abstained: Resolution = {
    kind: "done",
    outcome: { event: null, decision: { kind: "abstain" }, rendered: abstainRendered },
  };
  const trimmed = text.trim();
  if (!trimmed) {
    recordAdapterEvent(process.cwd(), "adapter.unrecognized", { reason: "empty-stdin" });
    return abstained;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    recordAdapterEvent(process.cwd(), "adapter.unrecognized", { reason: "invalid-json" });
    return abstained;
  }

  const resolved = resolveFromRegistry(parsed, providerRegistry);
  if (!resolved.provider) {
    recordAdapterEvent(process.cwd(), "adapter.unrecognized", { reason: "no-provider-match" });
    return abstained;
  }
  if (resolved.ambiguous) {
    recordAdapterEvent(process.cwd(), "adapter.ambiguous", { matched: resolved.matchedNames });
  }

  const provider = resolved.provider;
  const event = provider.toEvent(asRecord(parsed), hostEvent);
  if (!event) {
    recordAdapterEvent(process.cwd(), "adapter.unrecognized", {
      reason: "unrecognized-event",
      provider: provider.name,
    });
    return abstained;
  }
  return { kind: "resolved", provider, event };
}

type FailureNote = { cause: HookFailureCause; detail: string; code: string; diagRoot: string | null };

/**
 * hazard: a fail-closed host may start the hook with its working directory inside the folder that holds its own
 * wiring, so a diagnostic written under `process.cwd()` lands beside that file. Only the root the adapter names may
 * receive one; without it, stderr carries the whole record.
 */
function failOwned(owner: FailClosedOwner, note: FailureNote, io: RunIo): Resolution {
  const writeStderr = io.writeStderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  writeStderr(`tlc: hook failure (${note.cause}): ${note.detail}`);
  if (note.diagRoot !== null) {
    recordAdapterEvent(
      note.diagRoot,
      "adapter.unrecognized",
      { reason: note.code, provider: owner.name },
      owner.name,
    );
  }
  return {
    kind: "done",
    outcome: {
      event: null,
      decision: { kind: "abstain" },
      rendered: owner.failClosed.failureResponse(note.cause),
      failure: note.cause,
    },
  };
}

/** why no registry lookup: the token already names the host, so a payload another provider detects is foreign. */
function resolveOwnedInvocation(
  owner: FailClosedOwner,
  text: string,
  hostEvent: string | undefined,
  io: RunIo,
): Resolution {
  const trimmed = text.trim();
  if (!trimmed) {
    return failOwned(
      owner,
      { cause: "invalid-stdin", detail: "empty stdin", code: "empty-stdin", diagRoot: null },
      io,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return failOwned(
      owner,
      { cause: "invalid-stdin", detail: "stdin is not JSON", code: "invalid-json", diagRoot: null },
      io,
    );
  }
  const diagRoot = owner.failClosed.diagnosticRoot(parsed);
  if (!owner.detect(parsed)) {
    return failOwned(
      owner,
      {
        cause: "unrecognized-payload",
        detail: "payload is not this host's",
        code: "no-provider-match",
        diagRoot,
      },
      io,
    );
  }
  const event = owner.toEvent(asRecord(parsed), hostEvent);
  if (!event) {
    return failOwned(
      owner,
      { cause: "unrecognized-payload", detail: "event not translated", code: "unrecognized-event", diagRoot },
      io,
    );
  }
  return { kind: "resolved", provider: owner, event };
}

export async function runHandler(handler: Handler, io: RunIo = {}): Promise<RunOutcome> {
  const readStdin = io.readStdin ?? readStdinText;
  const now = io.now ? io.now() : new Date();
  const hostEvent = io.hostEvent === undefined ? hostEventOf(process.argv) : (io.hostEvent ?? undefined);
  const owner = failClosedOwner(providerRegistry, hostEvent);

  const text = await readStdin();
  const resolution =
    owner === null
      ? resolveOpenInvocation(text, hostEvent)
      : resolveOwnedInvocation(owner, text, hostEvent, io);
  if (resolution.kind === "done") {
    return resolution.outcome;
  }
  return runResolved(handler, resolution.provider, resolution.event, owner, now);
}

/**
 * invariant: the event itself stays raw. Only the floor's inputs change, and only when the adapter matched, so
 * presence, claims, the refusal record and the render never see an adapter's resolved path
 * ([/decisions/ad-156.md](/decisions/ad-156.md)).
 */
function handlerContext(event: HarnessEvent, base: HandlerContext): HandlerContext {
  const alias = base.provider.canonicalWiringMatch?.(event, base.protectedPaths) ?? null;
  // why the raw list: the facts derive ancestors from the composed targets, not from their alias-replaced forms.
  const facts = base.provider.floorHostFacts?.(event, base.protectedPaths) ?? null;
  const withFacts = facts === null ? base : { ...base, floorHostFacts: facts };
  if (alias === null) {
    return withFacts;
  }
  return { ...withFacts, protectedPaths: alias.protectedPaths, floorFilePath: alias.filePath };
}

async function runResolved(
  handler: Handler,
  provider: ProviderPort,
  event: HarnessEvent,
  owner: FailClosedOwner | null,
  now: Date,
): Promise<RunOutcome> {
  const capabilities = provider.capabilities();
  recordHookEnter(event);

  try {
    const policy = coreFacade.policy.loadPolicy(event.projectDir);
    if (event.model) {
      coreFacade.subagentPolicy.upsertParentModelState(
        event.projectDir,
        event.sessionKey,
        { model: event.model },
        effectiveBlockedPatterns(policy.subagents.blockedPatterns, provider),
      );
    }
    /**
     * hazard: this passed `event.filePath` for every event, and `read.before` carries one. So reading a file
     * claimed it for ten minutes, and the next session to write it was refused — under a rule called
     * `edit-collision`, with a message saying the file had been edited. Measured on a real machine: a review agent
     * that only read blocked the operator's own writes to two files, while their `git status` showed a single
     * modification, theirs ([/decisions/ad-099.md](/decisions/ad-099.md)).
     *
     * invariant: the heartbeat is unconditional — a reading session is still a live session, and staleness is what
     * expires a claim. Only the *claim* is write-only, because only a writer can lose somebody's work.
     */
    coreFacade.presence.heartbeat(event.projectDir, {
      provider: event.provider,
      session: sessionIdFromKey(event),
      ...(claimsFile(event) ? { file: event.filePath } : {}),
      now,
    });
    const protectedPaths = composeProtectedPaths(providerRegistry, event.projectDir);
    const context = handlerContext(event, { policy, capabilities, provider, now, protectedPaths });
    const decision = await handler(event, context);
    const degraded = degrade(decision, event, capabilities, {
      contextBudgetChars: CONTEXT_BUDGET_CHARS,
    });
    recordRefusal(event, policy, degraded);
    const rendered = provider.render(degraded, event);
    return { event, decision: degraded, rendered };
  } catch (error) {
    recordAdapterEvent(event.projectDir, "adapter.error", {
      provider: event.provider,
      event: event.event,
      message: errorMessage(error),
    });
    const abstain: Decision = { kind: "abstain" };
    if (owner !== null) {
      return {
        event,
        decision: abstain,
        rendered: owner.failClosed.failureResponse("handler-error"),
        failure: "handler-error",
      };
    }
    return { event, decision: abstain, rendered: provider.render(abstain, event) };
  }
}

export async function main(handler: Handler): Promise<void> {
  const outcome = await runHandler(handler);
  // invariant: an empty render means zero bytes. A lone newline is not silence to a host that reads silence as
  // success ([/decisions/ad-156.md](/decisions/ad-156.md)).
  const text = outcome.rendered.stdout;
  if (text !== null && text !== "") {
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  }
  process.exit(outcome.rendered.exitCode);
}
