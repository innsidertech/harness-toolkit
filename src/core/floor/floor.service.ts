import { isAbsolute } from "node:path";
import type { Decision } from "../../contracts/decision.ts";
import type { FloorHostFacts } from "../../contracts/floor-host-facts.ts";
import { executedTexts, type PosixExecutors } from "./floor.exec-text.ts";
import { type Head, segmentHeads } from "./floor.head.ts";
import { firstName, isParameterWord } from "./floor.name.ts";
import {
  isInside,
  isScratch,
  isSecretPath,
  matchesProtectedAncestor,
  matchesProtectedTarget,
  resolveTarget,
  type WiringMatch,
} from "./floor.paths.ts";
import { checkPolicySurface } from "./floor.policy-surface.ts";
import { type ShellSegment, type ShellWord, tokenizeShell } from "./floor.tokenize.ts";
import { type SegmentHead, verbOf } from "./floor.verb.ts";
import {
  MOVE_VERBS,
  TEXT_EXECUTING_VERBS,
  VOLUME_VERBS,
  WINDOWS_DESTRUCTIVE_VERBS,
  WINDOWS_FETCH_VERBS,
  WINDOWS_MACHINE_VERBS,
  WINDOWS_READER_VERBS,
} from "./floor.verbs.ts";

export type FloorRule =
  | "machine-control"
  | "secret-access"
  | "unprovable-destruction"
  | "history-rewrite"
  | "outside-project-destruction"
  | "policy-surface-write"
  | "unprovable-execution"
  | "wiring-tamper";

export type FloorInput = {
  projectDir: string;
  toolName?: string | undefined;
  filePath?: string | undefined;
  command?: string | undefined;
  isReadEvent?: boolean | undefined;
  protectedPaths?: readonly string[] | undefined;
  /** What the event's provider knows about its wiring; absent means the floor judges with the project directory alone. */
  host?: FloorHostFacts | undefined;
};

const DESTRUCTIVE_VERBS = new Set(["dd", "rm", "rmdir", "shred", "truncate"]);
const MACHINE_VERBS = new Set(["halt", "poweroff", "reboot", "shutdown"]);
const READER_VERBS = new Set(["base64", "cat", "head", "less", "more", "od", "strings", "tail", "xxd"]);
const READING_TOOLS = new Set(["Read", "Edit", "MultiEdit", "NotebookEdit"]);
// why: the spec's own AC3 names these three tool calls, not the wider WRITE_TOOLS set (which also carries
// `Delete`/`NotebookEdit`) — a provider's wiring target is a settings/hooks document, never a notebook.
const WIRING_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);
const EXPANDING_VERBS = new Set([".", "eval", "source"]);
const SHELLS = new Set(["ash", "bash", "dash", "fish", "ksh", "sh", "zsh"]);

/**
 * why: a verb whose job is to bring bytes from the network. The set is the reason the rule can be stated at all —
 * a program that arrives over the wire does not exist when the decision is made
 * ([/decisions/ad-074.md](/decisions/ad-074.md)).
 */
const FETCH_VERBS = new Set(["aria2c", "curl", "fetch", "http", "httpie", "https", "wget"]);

/**
 * The link-local services that hand out cloud credentials over HTTP.
 *
 * why: `secret-access` matched by path, so `~/.aws/credentials` was refused while the address returning the same
 * credential was allowed. A credential is not always a file.
 */
const METADATA_HOSTS = ["169.254.169.254", "169.254.170.2", "100.100.100.200", "metadata.google.internal"];

/**
 * invariant: verbs that speak to the network, and nothing else. `grep -rn 169.254.169.254 .` searches this
 * repository for a literal string and stays allowed — scoping to the verb is what keeps it that way.
 */
const NETWORK_VERBS = new Set([...FETCH_VERBS, "nc", "ncat", "socat", "telnet", "lwp-request"]);

function namesFetcher(text: string): boolean {
  return [...FETCH_VERBS].some((verb) => new RegExp(`\\b${verb}\\b`).test(text));
}

/**
 * A program assembled from a network fetch and handed to a shell.
 *
 * hazard: measured against the floor before this existed, all four spellings were allowed — and each one hands
 * the shell a payload that satisfies every other floor rule by containing nothing the gate can see. The wrapper
 * deletes nothing, reads nothing and forces nothing; whatever arrives does
 * ([/decisions/ad-074.md](/decisions/ad-074.md)).
 */
function fetchedProgramReachesShell(command: string, segments: readonly ShellSegment[]): boolean {
  // hazard: the tokenizer splits on `;`, `|` and `&` alike, so carrying a flag across segments treated
  // `curl --version && bash ./scripts/deploy.sh` as a download piped to a shell. Requiring a literal pipe keeps
  // every real `curl … | bash` and drops a sequence that merely mentions a fetcher — a false positive is
  // expensive in a rule with no switch ([/decisions/ad-034.md](/decisions/ad-034.md)).
  const piped = command.includes("|");
  let upstreamFetches = false;
  for (const segment of segments) {
    const head = verbOf(segment.words);
    if (!head) {
      continue;
    }
    const { verb, args } = head;

    // 1. a pipeline whose upstream fetched and whose downstream is a shell
    if (piped && upstreamFetches && SHELLS.has(verb)) {
      return true;
    }

    if (SHELLS.has(verb) || EXPANDING_VERBS.has(verb)) {
      for (const word of args) {
        // 2. process substitution: `bash <(curl …)`
        // 3. and 4. an unresolved word that names a fetcher — `sh -c "$(curl …)"`, `eval "$(curl …)"`
        const substitution = word.text.includes("<(") || word.unresolved;
        if (substitution && namesFetcher(word.text)) {
          return true;
        }
      }
    }

    upstreamFetches = FETCH_VERBS.has(verb);
  }
  return false;
}

// why: `bash script.sh` runs a file this gate cannot see, which is a coverage limit rather than evasion.
// `bash -c "..."` carries the command inline, which is the case worth refusing.
function buildsCommandAtRuntime(verb: string, args: ShellWord[]): boolean {
  return EXPANDING_VERBS.has(verb) || (SHELLS.has(verb) && args.some((word) => word.text === "-c"));
}

function reason(rule: FloorRule, detail: string): string {
  return [
    `FLOOR: ${detail}`,
    "This is a floor rule — it has no config switch, because a limit an agent can turn off is not a limit.",
    "Restate what you need and let the operator decide; do not work around this.",
    `rule=${rule}`,
  ].join("\n");
}

// why: the rule was already written into the reason prose as `rule=<name>`. Carrying it structurally as well is
// what lets a refusal be counted and attributed without parsing English
// ([/decisions/ad-027.md](/decisions/ad-027.md)).
function denial(rule: FloorRule, detail: string, note: string): Decision {
  return {
    kind: "deny",
    reason: reason(rule, detail),
    userNote: `Floor rule ${rule}: ${note}`,
    rule,
  };
}

function isMkfs(verb: string): boolean {
  return verb === "mkfs" || verb.startsWith("mkfs.");
}

function isDangerousVerb(token: string): boolean {
  const verb = token.split("/").pop() ?? token;
  return DESTRUCTIVE_VERBS.has(verb) || MACHINE_VERBS.has(verb) || isMkfs(verb);
}

function hidesDestructiveVerb(segment: ShellSegment): boolean {
  return segment.words.some((word) => word.text.split(/\s+/).some(isDangerousVerb));
}

function pathArgs(args: ShellWord[]): ShellWord[] {
  return args.filter((word) => !word.text.startsWith("-") && word.text !== "");
}

// hazard: `verbOf` strips a path down to its basename before comparing (`/usr/bin/git` → `git`) — a
// literal-text scan that skips the same normalization would deny `git push --force` but allow the identical
// command run as `/usr/bin/git push --force`, which is exactly the shape a path-qualifying wrapper produces.
function namesGit(text: string): boolean {
  return (text.split("/").pop() ?? text) === "git";
}

// why: `verbOf` only sees through a wrapper this gate already knows by name, and `WRAPPERS` cannot list
// every proxy or shim an operator's shell might inject ahead of the real command — discovered live when one
// such wrapper carried a force push straight past this rule. Matching the whole segment, not the resolved
// head verb, means an unrecognized wrapper can delay `git` but not hide it.
function forcedGitPush(segment: ShellSegment): boolean {
  const texts = segment.words.map((word) => word.text);
  return (
    texts.some(namesGit) &&
    texts.includes("push") &&
    texts.some((text) => text === "--force" || text === "-f")
  );
}

/** What the per-segment checks need besides the segment: where relative operands resolve, and what is protected. */
type ShellContext = {
  projectDir: string;
  base: string;
  protectedPaths: readonly string[];
  host?: FloorHostFacts | undefined;
};

function wiringMatch(host: FloorHostFacts | undefined): WiringMatch | undefined {
  return host === undefined ? undefined : { foldCase: host.foldCase, canonical: host.canonical };
}

// why ancestors only with facts: a host without them keeps the c31f3d4 decision, which removing a directory that
// holds its wiring did not change ([/decisions/ad-157.md](/decisions/ad-157.md)).
function isWiringPath(resolved: string, ctx: ShellContext): boolean {
  const match = wiringMatch(ctx.host);
  return (
    matchesProtectedTarget(resolved, ctx.protectedPaths, match) ||
    (ctx.host !== undefined &&
      matchesProtectedAncestor(resolved, ctx.host.protectedAncestors, match as WiringMatch))
  );
}

function isDestructiveName(name: string): boolean {
  return DESTRUCTIVE_VERBS.has(name) || WINDOWS_DESTRUCTIVE_VERBS.has(name) || isMkfs(name);
}

function isMachineName(name: string): boolean {
  return MACHINE_VERBS.has(name) || WINDOWS_MACHINE_VERBS.has(name);
}

function isHiddenDangerName(name: string): boolean {
  return isDestructiveName(name) || isMachineName(name) || VOLUME_VERBS.has(name);
}

function isFetchName(name: string): boolean {
  return FETCH_VERBS.has(name) || WINDOWS_FETCH_VERBS.has(name);
}

function fetchedTextDenial(): Decision {
  return denial(
    "unprovable-execution",
    "This runs a program fetched over the network, which does not exist for this gate to check. Download it to a file, read it, then run that file.",
    "fetched program handed to Invoke-Expression",
  );
}

function hiddenDestructionDenial(): Decision {
  return denial(
    "unprovable-destruction",
    "A destructive verb appears inside a command this gate cannot expand, so its target cannot be established. Run it directly with a literal path instead.",
    "hidden destructive verb",
  );
}

function pipedFromFetch(segments: readonly ShellSegment[], index: number): boolean {
  for (let at = index - 1; at >= 0 && segments[at]?.separator === "|"; at -= 1) {
    if (segmentHeads((segments[at] as ShellSegment).words).some((head) => isFetchName(head.name))) {
      return true;
    }
  }
  return false;
}

function argumentFetches(words: readonly ShellWord[], head: Head): boolean {
  const word = (words[head.index] as ShellWord).text;
  const open = word.indexOf("(");
  const rest = open >= 0 ? [word.slice(open + 1)] : [];
  return [...rest, ...words.slice(head.index + 1).map((next) => next.text)].some((text) =>
    isFetchName(firstName(text)),
  );
}

// why: an `&` at depth zero splits `iex (& irm …)` into `iex (` and `irm …)`, so the fetch sits in the next segment.
function splitFetches(segments: readonly ShellSegment[], index: number): boolean {
  const words = (segments[index] as ShellSegment).words;
  const next = segments[index + 1];
  return (
    words[words.length - 1]?.text.endsWith("(") === true &&
    next !== undefined &&
    segmentHeads(next.words).some((head) => isFetchName(head.name))
  );
}

/**
 * A download handed to `Invoke-Expression`: piped from a fetch, fetched inside its argument, or split off by `&`.
 *
 * invariant: read through the Windows fetch names composed next to `FETCH_VERBS`, never into it, so
 * `fetchedProgramReachesShell` and the metadata check keep the list they had ([/decisions/ad-157.md](/decisions/ad-157.md)).
 */
function fetchReachesExpression(segments: readonly ShellSegment[], index: number): boolean {
  const segment = segments[index] as ShellSegment;
  const expressions = segmentHeads(segment.words).filter((head) => TEXT_EXECUTING_VERBS.has(head.name));
  if (expressions.length === 0) {
    return false;
  }
  return (
    pipedFromFetch(segments, index) ||
    expressions.some((head) => argumentFetches(segment.words, head)) ||
    splitFetches(segments, index)
  );
}

const MAX_TEXT_DEPTH = 4;
const POSIX_EXECUTORS: PosixExecutors = { shells: SHELLS, expanding: EXPANDING_VERBS };

function subSegmentsDenial(segments: readonly ShellSegment[], level: number): Decision | null {
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] as ShellSegment;
    const heads = segmentHeads(segment.words);
    if (heads.some((head) => isHiddenDangerName(head.name))) {
      return hiddenDestructionDenial();
    }
    if (fetchReachesExpression(segments, index)) {
      return fetchedTextDenial();
    }
    const nested = textExecutionDenial(segment, heads, level + 1);
    if (nested !== null) {
      return nested;
    }
  }
  return null;
}

/**
 * hazard: `bash -c` was the only way through a string the floor could see, so `powershell -Command`, `cmd /c`,
 * `iex`, a script block or a subexpression ran any destructive verb unexamined. Each executed text is split like a
 * command and its heads compared, never its substrings, so `cmd /c "echo del"` stays allowed.
 *
 * invariant: `level` is the depth of the texts this segment hands on; past four the floor refuses rather than
 * recursing without end.
 */
function textExecutionDenial(segment: ShellSegment, heads: readonly Head[], level: number): Decision | null {
  const { texts, undecodable } = executedTexts(segment, heads, POSIX_EXECUTORS);
  if (undecodable) {
    return denial(
      "unprovable-destruction",
      "An encoded PowerShell command does not decode, so what it would run cannot be established. Pass the command as plain text.",
      "undecodable encoded command",
    );
  }
  if (texts.length > 0 && level > MAX_TEXT_DEPTH) {
    return denial(
      "unprovable-destruction",
      "Commands nested more than four levels deep cannot be followed, so what they would run cannot be established. Run the inner command directly.",
      "command nested too deep",
    );
  }
  for (const text of texts) {
    const nested = subSegmentsDenial(tokenizeShell(text), level);
    if (nested !== null) {
      return nested;
    }
  }
  return null;
}

// why: checked before `verbOf` resolves anything — a wrapper this gate does not recognize can delay which word
// `verbOf` treats as the head, or exhaust the segment before a head is ever found, but it cannot remove
// `git`/`push`/`--force` from the segment's own words.
function historyDenial(segment: ShellSegment): Decision | null {
  if (!forcedGitPush(segment)) {
    return null;
  }
  return denial(
    "history-rewrite",
    "`git push --force` discards remote commits that are not in your history. Use --force-with-lease, which refuses when the remote moved.",
    "force push",
  );
}

// hazard: `eval "rm -rf /"` and `bash -c "rm -rf /"` build their command at runtime, so the head word does not
// describe what will run. Reasoning about the nested quoting is the weak-parser trap — refuse the segment instead
// of interpreting it. Scanning words is only sound here: doing it for any opaque segment flags an `rm` quoted as
// data somewhere in a long script.
function runtimeBuiltDenial(segment: ShellSegment, head: SegmentHead | null): Decision | null {
  return head !== null && buildsCommandAtRuntime(head.verb, head.args) && hidesDestructiveVerb(segment)
    ? hiddenDestructionDenial()
    : null;
}

function executionDenial(
  segments: readonly ShellSegment[],
  index: number,
  heads: readonly Head[],
): Decision | null {
  if (fetchReachesExpression(segments, index)) {
    return fetchedTextDenial();
  }
  return textExecutionDenial(segments[index] as ShellSegment, heads, 1);
}

function machineDenial(head: SegmentHead | null, heads: readonly Head[]): Decision | null {
  const verb =
    head !== null && MACHINE_VERBS.has(head.verb)
      ? head.verb
      : heads.find((candidate) => isMachineName(candidate.name))?.name;
  return verb === undefined
    ? null
    : denial("machine-control", `\`${verb}\` controls the machine, not the project.`, verb);
}

function volumeDenial(heads: readonly Head[]): Decision | null {
  const verb = heads.find((candidate) => VOLUME_VERBS.has(candidate.name))?.name;
  return verb === undefined
    ? null
    : denial(
        "outside-project-destruction",
        `\`${verb}\` formats or clears a volume or a disk, which is outside the project whatever its arguments.`,
        `${verb} of a volume`,
      );
}

function targetDenial(verb: string, word: ShellWord, ctx: ShellContext): Decision | null {
  const resolved = resolveTarget(ctx.base, word.text);
  // why: a destructive verb targeting a provider's wiring path is the same tampering the redirect and in-place-edit
  // cases already name — attributing it to `outside-project-destruction` instead would be technically safe (the
  // file still cannot be destroyed) but would hide which rule actually did the work.
  if (isWiringPath(resolved, ctx)) {
    return denial(
      "wiring-tamper",
      `${resolved} is where a provider reads its own hook registration from, and destroying it would stop every hook this harness has for that host from firing.`,
      `${verb} of ${resolved}`,
    );
  }
  if (!isInside(ctx.projectDir, resolved) && !isScratch(resolved)) {
    return denial(
      "outside-project-destruction",
      `\`${verb}\` targets ${resolved}, which is outside the project and outside scratch space.`,
      `${verb} outside project`,
    );
  }
  return null;
}

function destructionDenial(
  segment: ShellSegment,
  verb: string,
  targets: readonly ShellWord[],
  ctx: ShellContext,
): Decision | null {
  // hazard: an opaque segment or an unresolved word means the target is unknown. The floor must prove the target
  // is safe, not prove it is dangerous, so unknown resolves to denied.
  if (segment.opaque || targets.some((word) => word.unresolved) || targets.length === 0) {
    return denial(
      "unprovable-destruction",
      `\`${verb}\` was called with a target this gate cannot resolve, so its safety cannot be established. Re-run it with a literal path inside the project.`,
      `unresolvable ${verb}`,
    );
  }
  for (const word of targets) {
    const found = targetDenial(verb, word, ctx);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

function destructiveHeadsDenial(
  segment: ShellSegment,
  head: SegmentHead | null,
  heads: readonly Head[],
  ctx: ShellContext,
): Decision | null {
  if (head !== null && (DESTRUCTIVE_VERBS.has(head.verb) || isMkfs(head.verb))) {
    const found = destructionDenial(segment, head.verb, pathArgs(head.args), ctx);
    if (found !== null) {
      return found;
    }
  }
  for (const candidate of heads.filter((each) => isDestructiveName(each.name))) {
    const found = destructionDenial(segment, candidate.name, candidate.operands, ctx);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

function wiringMoveDenial(verb: string, resolved: string): Decision {
  return denial(
    "wiring-tamper",
    `${resolved} is or holds where a provider reads its own hook registration from, and moving it would stop every hook this harness has for that host from firing.`,
    `${verb} of ${resolved}`,
  );
}

// why only with facts: moving a wiring file is a route the host's facts name; a provider without them keeps the
// c31f3d4 decision ([/decisions/ad-157.md](/decisions/ad-157.md)).
function moveDenial(heads: readonly Head[], ctx: ShellContext): Decision | null {
  if (ctx.host === undefined) {
    return null;
  }
  for (const head of heads.filter((each) => MOVE_VERBS.has(each.name))) {
    for (const word of head.operands) {
      const resolved = word.unresolved ? null : resolveTarget(ctx.base, word.text);
      if (resolved !== null && isWiringPath(resolved, ctx)) {
        return wiringMoveDenial(head.name, resolved);
      }
    }
  }
  return null;
}

function segmentDenial(segments: readonly ShellSegment[], index: number, ctx: ShellContext): Decision | null {
  const segment = segments[index] as ShellSegment;
  const head = verbOf(segment.words);
  const heads = segmentHeads(segment.words);
  return (
    historyDenial(segment) ??
    runtimeBuiltDenial(segment, head) ??
    executionDenial(segments, index, heads) ??
    machineDenial(head, heads) ??
    volumeDenial(heads) ??
    destructiveHeadsDenial(segment, head, heads, ctx) ??
    moveDenial(heads, ctx)
  );
}

// "Relative" is the spec's: not absolute for this platform and not starting with `~`.
function isRelativeWord(word: ShellWord): boolean {
  return word.text !== "" && !isAbsolute(word.text) && !word.text.startsWith("~");
}

function relativeDestructionVerb(segment: ShellSegment): string | null {
  const head = verbOf(segment.words);
  if (head !== null && (DESTRUCTIVE_VERBS.has(head.verb) || isMkfs(head.verb))) {
    if (pathArgs(head.args).some(isRelativeWord)) {
      return head.verb;
    }
  }
  const found = segmentHeads(segment.words).find(
    (candidate) => isDestructiveName(candidate.name) && candidate.operands.some(isRelativeWord),
  );
  return found?.name ?? null;
}

function relativeMoveVerb(segment: ShellSegment): string | null {
  const found = segmentHeads(segment.words).find(
    (candidate) => MOVE_VERBS.has(candidate.name) && candidate.operands.some(isRelativeWord),
  );
  return found?.name ?? null;
}

/**
 * A working directory the floor cannot resolve, decided in the spec's order: the wiring file named anywhere in the
 * command, then a destructive verb with a relative operand, then a move with one.
 *
 * hazard: the host runs the command in a directory the model chose, so `$HOME/.x` plus `rm ./file` reaches a file
 * the floor would otherwise resolve inside the project ([/decisions/ad-157.md](/decisions/ad-157.md)).
 */
function unresolvableBaseDenial(
  command: string,
  segments: readonly ShellSegment[],
  host: FloorHostFacts,
): Decision | null {
  const lower = command.toLowerCase();
  const named = host.wiringFileNames.find((name) => lower.includes(name));
  if (named !== undefined) {
    return denial(
      "wiring-tamper",
      `This command names ${named} while running in a directory this gate cannot resolve, so it may reach where a provider reads its own hook registration from. Run it with a literal working directory.`,
      `${named} under an unresolvable directory`,
    );
  }
  for (const segment of segments) {
    const verb = relativeDestructionVerb(segment);
    if (verb !== null) {
      return denial(
        "unprovable-destruction",
        `\`${verb}\` was called with a relative target in a directory this gate cannot resolve, so its safety cannot be established. Run it with a literal working directory.`,
        `unresolvable ${verb}`,
      );
    }
  }
  for (const segment of segments) {
    const verb = relativeMoveVerb(segment);
    if (verb !== null) {
      return denial(
        "wiring-tamper",
        `\`${verb}\` was called with a relative operand in a directory this gate cannot resolve, so it may move where a provider reads its own hook registration from. Run it with a literal working directory.`,
        `${verb} under an unresolvable directory`,
      );
    }
  }
  return null;
}

// invariant: the rest of the floor then sees each relative operand as the unresolvable word it is, which is the
// c31f3d4 decision for `$X/<operand>`.
function withRelativeUnresolved(segment: ShellSegment): ShellSegment {
  const head = verbOf(segment.words);
  if (head === null) {
    return segment;
  }
  const after = new Set(head.args);
  return {
    ...segment,
    words: segment.words.map((word) =>
      after.has(word) && !isParameterWord(word.text) && isRelativeWord(word)
        ? { ...word, text: `$X/${word.text}`, unresolved: true }
        : word,
    ),
  };
}

type ShellFrame = { segments: ShellSegment[]; ctx: ShellContext };

function shellFrame(input: FloorInput, command: string): Decision | ShellFrame {
  const tokenized = tokenizeShell(command);
  const { projectDir, host } = input;
  const protectedPaths = input.protectedPaths ?? [];
  if (host?.shellBaseUnresolvable !== true) {
    return {
      segments: tokenized,
      ctx: { projectDir, base: host?.shellBase ?? projectDir, protectedPaths, host },
    };
  }
  return (
    unresolvableBaseDenial(command, tokenized, host) ?? {
      segments: tokenized.map(withRelativeUnresolved),
      ctx: { projectDir, base: projectDir, protectedPaths, host },
    }
  );
}

function checkShell(input: FloorInput): Decision {
  const command = input.command;
  if (!command) {
    return { kind: "allow" };
  }

  const frame = shellFrame(input, command);
  if ("kind" in frame) {
    return frame;
  }
  const { segments, ctx } = frame;
  const protectedPaths = ctx.protectedPaths;
  const surfaceOptions = { base: ctx.base, match: wiringMatch(ctx.host) };

  // invariant: asked before the rest. A fetched program satisfies every other rule by containing nothing this
  // gate can read, so checking the wrapper first and the payload never is the order that let it through.
  if (fetchedProgramReachesShell(command, segments)) {
    return denial(
      "unprovable-execution",
      "This runs a program fetched over the network, which does not exist for this gate to check. Download it to a file, read it, then run that file.",
      "fetched program piped to a shell",
    );
  }

  for (let index = 0; index < segments.length; index += 1) {
    const found = segmentDenial(segments, index, ctx);
    if (found !== null) {
      return found;
    }
  }

  // hazard: the guard that used to defend this surface keyed off tool names, so a single shell line went
  // around it. The rule belongs here, where the decision is made before any policy is read.
  const surface = checkPolicySurface(input.projectDir, command, segments, protectedPaths, surfaceOptions);
  if (surface.kind === "deny") {
    // invariant: the remedy comes from the branch that denied, so a read refusal names how to read and a write
    // refusal names who may write. One fixed tail on both handed write advice to an agent trying to read
    // ([/decisions/ad-047.md](/decisions/ad-047.md)).
    const remedy =
      surface.remedy ??
      "Set a gate command with `tlc harness gate test-command` or `gate lint-command`, and run policy changes from your own terminal rather than from inside this session.";
    // why: the same segment logic protects both surfaces, so the only way to attribute the right rule is to ask
    // whether the harness's own surface — with no wiring targets in the mix — would have denied this on its own.
    // If it would not, the only thing that changed the answer is a provider's wiring target.
    const harnessOnly =
      protectedPaths.length === 0
        ? surface
        : checkPolicySurface(input.projectDir, command, segments, [], surfaceOptions);
    const rule: FloorRule = harnessOnly.kind === "deny" ? "policy-surface-write" : "wiring-tamper";
    return denial(rule, `${surface.detail} ${remedy}`, surface.note);
  }

  return checkShellSecrets(segments, ctx.base);
}

function metadataDenial(head: SegmentHead): Decision | null {
  if (!NETWORK_VERBS.has(head.verb)) {
    return null;
  }
  const target = head.args.map((word) => word.text).join(" ");
  const endpoint = METADATA_HOSTS.find((host) => target.includes(host));
  return endpoint === undefined
    ? null
    : denial(
        "secret-access",
        `${endpoint} is the instance metadata service, and \`${head.verb}\` would copy the credentials it returns into the transcript.`,
        `read of ${endpoint}`,
      );
}

function readerDenial(verb: string, operands: readonly ShellWord[], base: string): Decision | null {
  for (const word of operands) {
    if (word.unresolved) {
      continue;
    }
    const resolved = resolveTarget(base, word.text);
    if (isSecretPath(resolved)) {
      return denial(
        "secret-access",
        `\`${verb}\` would read ${resolved} into the transcript. Credentials do not belong in an agent's context.`,
        `read of ${resolved}`,
      );
    }
  }
  return null;
}

function rawSecretDenial(segment: ShellSegment, base: string): Decision | null {
  const head = verbOf(segment.words);
  if (!head) {
    return null;
  }
  return (
    metadataDenial(head) ??
    (READER_VERBS.has(head.verb) ? readerDenial(head.verb, pathArgs(head.args), base) : null)
  );
}

function headSecretDenial(segment: ShellSegment, base: string): Decision | null {
  for (const head of segmentHeads(segment.words)) {
    if (READER_VERBS.has(head.name) || WINDOWS_READER_VERBS.has(head.name)) {
      const found = readerDenial(head.name, head.operands, base);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

function checkShellSecrets(segments: ShellSegment[], base: string): Decision {
  for (const segment of segments) {
    const found = rawSecretDenial(segment, base) ?? headSecretDenial(segment, base);
    if (found !== null) {
      return found;
    }
  }
  return { kind: "allow" };
}

function checkFile(input: FloorInput): Decision {
  const filePath = input.filePath;
  if (!filePath) {
    return { kind: "allow" };
  }
  const resolved = resolveTarget(input.projectDir, filePath);

  const writes = input.toolName !== undefined && WIRING_EDIT_TOOLS.has(input.toolName);
  if (writes && matchesProtectedTarget(resolved, input.protectedPaths ?? [], wiringMatch(input.host))) {
    return denial(
      "wiring-tamper",
      `${resolved} is where a provider reads its own hook registration from, and overwriting it would stop every hook this harness has for that host from firing.`,
      `write to ${resolved}`,
    );
  }

  const reads =
    input.isReadEvent === true || (input.toolName !== undefined && READING_TOOLS.has(input.toolName));
  if (!reads) {
    return { kind: "allow" };
  }
  if (!isSecretPath(resolved)) {
    return { kind: "allow" };
  }
  return denial(
    "secret-access",
    `${resolved} holds credentials, and reading it would copy them into the transcript.`,
    `read of ${resolved}`,
  );
}

// invariant: this function takes no policy. Adding a config parameter here would turn the floor into
// a guardrail, which is the one thing it must not be.
/**
 * hazard: a tool the adapter cannot translate reaches the floor with no path or command it can read, so a write to a
 * wiring file through it was allowed. Its arguments are only asked whether they name one.
 */
function untranslatedToolDenial(host: FloorHostFacts | undefined): Decision | null {
  const strings = host?.untranslatedToolStrings;
  if (host === undefined || strings === undefined) {
    return null;
  }
  const named = strings.some((text) => {
    const normalized = text.replace(/\\/g, "/").toLowerCase();
    return host.wiringTextNames.some((name) => normalized.includes(name));
  });
  return named
    ? denial(
        "wiring-tamper",
        "An argument of a tool this harness cannot translate names a provider's wiring target, and the call could overwrite where that host reads its own hook registration from.",
        "untranslated tool naming a wiring target",
      )
    : null;
}

export function evaluateFloor(input: FloorInput): Decision {
  const untranslated = untranslatedToolDenial(input.host);
  if (untranslated !== null) {
    return untranslated;
  }
  const file = checkFile(input);
  if (file.kind !== "allow") {
    return file;
  }
  return checkShell(input);
}
