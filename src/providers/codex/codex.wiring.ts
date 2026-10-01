import type { ProviderWiring, RuntimePaths } from "../../contracts/index.ts";
import { CODEX_PRE_TOOL_USE_TIMEOUT_SECONDS, CODEX_PRE_TOOL_USE_TOKEN } from "./codex.events.ts";
import { codexHooksPath } from "./codex.paths.ts";

/**
 * why `presencePath` is the file, not its directory: `~/.codex` already exists when `config.toml` does, and that
 * must not count as an installed hooks file. `strategy` stays `replace`; the doctor guard is what stops the
 * Cursor checker from calling a present file wired.
 */
export function codexWiring(runtime: RuntimePaths): ProviderWiring {
  const target = codexHooksPath();
  return {
    target,
    strategy: "replace",
    presencePath: target,
    entries: [
      {
        hookEvent: "PreToolUse",
        handler: "tool-before",
        command: "node",
        args: [runtime.launcherPath, "tool-before", CODEX_PRE_TOOL_USE_TOKEN],
        timeoutSeconds: CODEX_PRE_TOOL_USE_TIMEOUT_SECONDS,
      },
    ],
  };
}

export function codexWiringTargets(): string[] {
  return [codexHooksPath()];
}
