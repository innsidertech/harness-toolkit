import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import type { FloorHostFacts, HarnessEvent } from "../../contracts/index.ts";
import { antigravityCanonicalPath } from "./antigravity.paths.ts";
import { translationFor } from "./antigravity.tools.ts";

type CanonicalDeps = NonNullable<Parameters<typeof antigravityCanonicalPath>[2]>;

/** The two files this host reads its hooks from, as they appear in free text once `\` is `/` and case is folded. */
const WIRING_TEXT_NAMES = [".agents/hooks.json", ".gemini/config/hooks.json"];
const WIRING_FILE_NAMES = ["hooks.json"];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringsIn(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(stringsIn);
  }
  const record = asRecord(value);
  return record === undefined ? [] : Object.values(record).flatMap(stringsIn);
}

function untranslatedToolStrings(event: HarnessEvent): string[] | undefined {
  if (event.event !== "tool.before") {
    return undefined;
  }
  const toolCall = asRecord(event.raw.toolCall);
  const name = typeof toolCall?.name === "string" ? toolCall.name : undefined;
  return translationFor(name) === null ? stringsIn(toolCall?.args) : undefined;
}

// why no realpath and no `\` rewrite: the Cwd is a text the model chose. Off Windows `\` is a filename character,
// and a directory that does not exist yet is still where the command would run.
function resolvedCwd(cwd: string, projectDir: string, home: string): string {
  let expanded = cwd;
  if (cwd === "~") {
    expanded = home;
  } else if (cwd.startsWith("~/") || cwd.startsWith("~\\")) {
    expanded = resolve(home, cwd.slice(2));
  }
  return isAbsolute(expanded) ? resolve(expanded) : resolve(projectDir, expanded);
}

function shellBaseFacts(
  event: HarnessEvent,
  home: string,
): Pick<FloorHostFacts, "shellBase" | "shellBaseUnresolvable"> {
  if (event.event !== "shell.before" || event.cwd === undefined) {
    return {};
  }
  if (/[$%`]/.test(event.cwd)) {
    return { shellBaseUnresolvable: true };
  }
  return { shellBase: resolvedCwd(event.cwd, event.projectDir, home) };
}

function protectedAncestors(protectedPaths: readonly string[], projectDir: string, home: string): string[] {
  const excluded = new Set([resolve(projectDir), resolve(home)]);
  const found = new Set<string>();
  for (const target of protectedPaths) {
    let current = resolve(target);
    for (let parent = dirname(current); parent !== current; parent = dirname(current)) {
      current = parent;
      if (dirname(current) !== current && !excluded.has(current)) {
        found.add(current);
      }
    }
  }
  return [...found];
}

/**
 * What the floor needs about an event of this host to judge the wiring routes the tool table does not show.
 *
 * hazard: the tool table maps six tools and `run_command` runs in a directory the model chose, so a write to either
 * hooks file through an unmapped tool, a Cwd, the folder that holds it, another case or a path alias reached the
 * floor as an ordinary path ([/decisions/ad-157.md](/decisions/ad-157.md)).
 */
export function antigravityFloorHostFacts(
  event: HarnessEvent,
  protectedPaths: readonly string[],
  deps: Partial<CanonicalDeps> = {},
): FloorHostFacts {
  const home = deps.home ?? homedir();
  const strings = untranslatedToolStrings(event);
  const canonicalOn = event.event === "shell.before" && (deps.platform ?? process.platform) === "win32";
  return {
    wiringTextNames: WIRING_TEXT_NAMES,
    ...(strings === undefined ? {} : { untranslatedToolStrings: strings }),
    ...shellBaseFacts(event, home),
    wiringFileNames: WIRING_FILE_NAMES,
    protectedAncestors: protectedAncestors(protectedPaths, event.projectDir, home),
    foldCase: true,
    ...(canonicalOn
      ? { canonical: (path: string) => antigravityCanonicalPath(path, event.projectDir, deps) }
      : {}),
  };
}
