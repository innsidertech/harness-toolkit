import type {
  Decision,
  FloorHostFacts,
  HarnessEvent,
  ProviderCapabilities,
  ProviderPolicyDefaults,
  ProviderWiring,
  Rendered,
  RuntimePaths,
} from "../contracts/index.ts";

export type HookFailureCause =
  | "launcher-error"
  | "timeout"
  | "invalid-stdin"
  | "unrecognized-payload"
  | "handler-error";

/** Present only on a host whose silence lets a tool run, so every failure must be an explicit refusal. */
export type FailClosedPosture = {
  /** argv token prefix that marks an invocation as this host's; `bin/tlc-exec.mjs` matches the same literal. */
  readonly hostEventPrefix: string;
  failureResponse(cause: HookFailureCause): Rendered;
  /** Root under which a diagnostic for an untranslatable payload may be written; null means stderr only. */
  diagnosticRoot(parsed: unknown): string | null;
};

/** Core never imports this type — it receives a HarnessEvent and ProviderCapabilities as plain arguments instead. */
export type ProviderPort = {
  readonly name: string;
  detect(raw: unknown): boolean;
  capabilities(): ProviderCapabilities;
  policyDefaults(): ProviderPolicyDefaults;
  /** `hostEvent` is the argv token after the handler, opaque to everything but the adapter that wired it. */
  toEvent(raw: Record<string, unknown>, hostEvent?: string): HarnessEvent | null;
  render(decision: Decision, event: HarnessEvent): Rendered;
  wiring(runtime: RuntimePaths): ProviderWiring;
  wiringTargets(): string[];
  /** Wiring files inside the project the event names. Absent: the host reads none there. */
  projectWiringTargets?(projectDir: string): string[];
  readonly failClosed?: FailClosedPosture;
  /** Floor inputs for a write that matches a protected target only through a path alias; null leaves the raw inputs. Throws when a path cannot be resolved. */
  canonicalWiringMatch?(
    event: HarnessEvent,
    protectedPaths: readonly string[],
  ): { filePath: string; protectedPaths: string[] } | null;
  /** What the floor needs about this host to judge wiring routes; absent or null means the floor judges with the project directory alone. Throws when a path cannot be resolved. */
  floorHostFacts?(event: HarnessEvent, protectedPaths: readonly string[]): FloorHostFacts | null;
  lessonsView(root: string): string | null;
};
