import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, win32 } from "node:path";
import type { HarnessEvent } from "../../contracts/index.ts";

export function antigravityGlobalHooksPath(): string {
  return join(homedir(), ".gemini", "config", "hooks.json");
}

/** The CLI's own directory: its existence is what marks the host as installed. */
export function antigravityCliDir(): string {
  return join(homedir(), ".gemini", "antigravity-cli");
}

export function antigravityWorkspaceHooksPath(projectDir: string): string {
  return join(projectDir, ".agents", "hooks.json");
}

type CanonicalPathDeps = {
  platform: NodeJS.Platform;
  exists: (path: string) => boolean;
  /** Follows a junction and expands an 8.3 short name. */
  realpath: (path: string) => string;
  home: string;
};

const DEVICE_PREFIXES = ["\\\\?\\", "\\\\.\\"];

function lastSeparator(path: string): number {
  return Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
}

function withLastSegment(path: string, edit: (segment: string) => string): string {
  const cut = lastSeparator(path) + 1;
  return path.slice(0, cut) + edit(path.slice(cut));
}

function withoutStreamSuffix(segment: string): string {
  const stream = segment.indexOf("::");
  return stream === -1 ? segment : segment.slice(0, stream);
}

function withoutTrailingDotsAndSpaces(segment: string): string {
  return segment === "." || segment === ".." ? segment : segment.replace(/[. ]+$/, "");
}

/**
 * invariant: the same `~` rule as the floor's `resolveTarget`. Repeated rather than imported, because an adapter
 * may not import core.
 */
function absoluteWin32(path: string, projectDir: string, home: string): string {
  let expanded = path;
  if (path === "~") {
    expanded = home;
  } else if (path.startsWith("~\\") || path.startsWith("~/")) {
    expanded = win32.resolve(home, path.slice(2));
  }
  return win32.isAbsolute(expanded) ? win32.resolve(expanded) : win32.resolve(projectDir, expanded);
}

function realpathOfExistingAncestor(absolute: string, deps: CanonicalPathDeps): string {
  let ancestor = absolute;
  const missing: string[] = [];
  while (!deps.exists(ancestor)) {
    const parent = win32.dirname(ancestor);
    if (parent === ancestor) {
      return absolute;
    }
    missing.unshift(win32.basename(ancestor));
    ancestor = parent;
  }
  return win32.join(deps.realpath(ancestor), ...missing);
}

function resolveDeps(deps: Partial<CanonicalPathDeps>): CanonicalPathDeps {
  return {
    platform: deps.platform ?? process.platform,
    exists: deps.exists ?? existsSync,
    realpath: deps.realpath ?? ((path: string) => realpathSync.native(path)),
    home: deps.home ?? homedir(),
  };
}

/** Windows alias-free form of a path ([/decisions/ad-156.md](/decisions/ad-156.md)); off Windows, the path itself. Throws when realpath fails. */
export function antigravityCanonicalPath(
  path: string,
  projectDir: string,
  deps: Partial<CanonicalPathDeps> = {},
): string {
  const resolved = resolveDeps(deps);
  if (resolved.platform !== "win32") {
    return path;
  }
  const prefix = DEVICE_PREFIXES.find((candidate) => path.startsWith(candidate));
  const bare = prefix === undefined ? path : path.slice(prefix.length);
  const named = withLastSegment(withLastSegment(bare, withoutStreamSuffix), withoutTrailingDotsAndSpaces);
  return realpathOfExistingAncestor(absoluteWin32(named, projectDir, resolved.home), resolved);
}

const CANONICAL_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

/**
 * why the floor gets both sides canonical and only on a match: the floor compares its own `resolve` of the path
 * with the targets, so an alias on either side slips past it. Handing it the canonical form only when the two
 * forms meet keeps every other event, and the secret check, on the raw path
 * ([/decisions/ad-156.md](/decisions/ad-156.md)).
 */
export function antigravityCanonicalWiringMatch(
  event: HarnessEvent,
  protectedPaths: readonly string[],
  deps: Partial<CanonicalPathDeps> = {},
): { filePath: string; protectedPaths: string[] } | null {
  if (
    event.event !== "tool.before" ||
    !CANONICAL_WRITE_TOOLS.has(event.toolName ?? "") ||
    typeof event.filePath !== "string" ||
    (deps.platform ?? process.platform) !== "win32"
  ) {
    return null;
  }
  const filePath = antigravityCanonicalPath(event.filePath, event.projectDir, deps);
  const targets = protectedPaths.map((path) => antigravityCanonicalPath(path, event.projectDir, deps));
  return targets.includes(filePath) ? { filePath, protectedPaths: targets } : null;
}
