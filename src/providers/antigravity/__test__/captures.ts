import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/**
 * The discovery captures these fixtures were cut from. They live in the repository that specified this host, not in
 * this one, so a test that needs them skips when the checkout stands alone.
 */
export const CAPTURES_DIR =
  process.env.TLC_ANTIGRAVITY_CAPTURES ??
  join(repoRoot, "..", "agentic-squad", ".specs", "features", "tlc-harness-antigravity", "captures");
