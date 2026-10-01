import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The discovery captures these fixtures were cut from, copied beside this file with the two redaction rules of
 * PROVENANCE.md applied to every string, so a checkout that stands alone runs the tests that read them.
 */
export const CAPTURES_DIR =
  process.env.TLC_ANTIGRAVITY_CAPTURES ?? join(dirname(fileURLToPath(import.meta.url)), "captures");
