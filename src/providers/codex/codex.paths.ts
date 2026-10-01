import { homedir } from "node:os";
import { join } from "node:path";

/**
 * why: the measured home is `CODEX_HOME` when that variable is a non-empty string, and `~/.codex` otherwise.
 * An empty string counts as unset. Any other string counts as set, including surrounding whitespace — trimming
 * would invent a third state the capture did not show.
 */
export function codexHooksPath(): string {
  const home = process.env.CODEX_HOME;
  const root = typeof home === "string" && home !== "" ? home : join(homedir(), ".codex");
  return join(root, "hooks.json");
}
