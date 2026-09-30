export const MIN_NODE_MAJOR: number;

export function conventionalHarnessHome(home?: string): string;

export function isPackagedCopy(candidate: string): boolean;

export type HarnessHomeDeps = {
  realpath: (path: string) => string;
  home: () => string;
  exists?: (path: string) => boolean;
};

export function resolveHarnessHome(
  binDir: string,
  env?: Record<string, string | undefined>,
  invoked?: string,
  deps?: HarnessHomeDeps,
): string;

export function bunExecutableName(platform?: string): string;

export function findBunOnPath(
  env?: Record<string, string | undefined>,
  platform?: string,
): string | null;

export function runtimeCachePath(harnessHome: string): string;

export type RuntimeCache = { bunPath: string | null; checkedAt: string };

export function readRuntimeCache(harnessHome: string): RuntimeCache | null;

export function writeRuntimeCache(harnessHome: string, bunPath: string | null): RuntimeCache;

export function resolveBunPath(
  harnessHome: string,
  env?: Record<string, string | undefined>,
  platform?: string,
): string | null;

export function entrySourceCandidates(harnessHome: string, entry: string): string[];

export function resolveEntrySource(harnessHome: string, entry: string): string | null;

export type RuntimeDecisionInput = {
  harnessHome: string;
  entry: string;
  bunPath: string | null;
  nodeMajor: number;
  distExists: boolean;
  srcPath: string | null;
};

export type RuntimeDecision =
  | { kind: "run"; command: string; args: string[] }
  | { kind: "error"; status: number; message: string };

export function decideRuntime(input: RuntimeDecisionInput): RuntimeDecision;

export function main(argv?: string[]): void | Promise<void>;
export const HOOK_ENTRIES: Set<string>;

export type FailClosedHost = {
  prefix: string;
  deadlineMs: Record<string, number>;
  fallbackDeadlineMs: number;
  silentSuccessTokens: string[];
};

export const FAIL_CLOSED_HOSTS: FailClosedHost[];

export function failClosedHostFor(
  entry: string,
  token: string | undefined,
): { prefix: string; deadlineMs: number; silentSuccess: boolean } | null;

export function failClosedVerdict(cause: string): string;

export function isHostVerdict(text: string, silentSuccess?: boolean): boolean;

export function childEnv(harnessHome: string, origin: string): Record<string, string | undefined>;

export type CapturedChild = {
  stdout?: { on(event: "data", listener: (chunk: { toString(): string }) => void): unknown } | null;
  kill(): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null, signal: string | null) => void): unknown;
};

export type CaptureDeps = {
  spawn: (command: string, args: string[], options: Record<string, unknown>) => CapturedChild;
  write: (text: string, done: () => void) => unknown;
  writeErr: (line: string) => void;
  exit: (code: number) => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
};

export function runCaptured(
  command: string,
  args: string[],
  options: { env: Record<string, string | undefined>; deadlineMs: number; silentSuccess?: boolean },
  deps?: CaptureDeps,
): Promise<void>;
