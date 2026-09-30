import { homedir } from "node:os";
import { join } from "node:path";

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
