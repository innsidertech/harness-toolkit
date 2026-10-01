/**
 * The Windows shell names the floor rules add, lower-case, compared against a normalized verb name.
 *
 * why a separate list: the POSIX sets in `floor.service.ts` are read raw by the rules that predate these, and
 * editing them would change what the policy surface and `fetchedProgramReachesShell` see. These are read only by
 * the shell-verb checks, next to the POSIX sets, never into them ([/decisions/ad-157.md](/decisions/ad-157.md)).
 */

/** Decided by target, like `rm`: inside the project or temp allows, outside denies, unresolvable denies. */
export const WINDOWS_DESTRUCTIVE_VERBS = new Set([
  "remove-item",
  "ri",
  "del",
  "erase",
  "rd",
  "clear-content",
  "clc",
]);

/** The target is a volume or a disk, so no argument can make it safe. */
export const VOLUME_VERBS = new Set(["format-volume", "clear-disk", "format", "format.com"]);

export const WINDOWS_READER_VERBS = new Set(["get-content", "gc", "type"]);

export const WINDOWS_MACHINE_VERBS = new Set(["stop-computer", "restart-computer"]);

export const WINDOWS_FETCH_VERBS = new Set(["invoke-webrequest", "iwr", "invoke-restmethod", "irm"]);

export const TEXT_EXECUTING_VERBS = new Set(["invoke-expression", "iex"]);

export const MOVE_VERBS = new Set(["mv", "move-item", "mi", "move", "rename-item", "rni", "ren", "rename"]);

export const LAUNCHING_WRAPPERS = new Set(["start-process", "saps", "start"]);

/** `del`, `erase` and `rd` take `/x` switches, which are not paths; `rm` and `rmdir` do not. */
export const SWITCH_TAKING_VERBS = new Set(["del", "erase", "rd"]);
