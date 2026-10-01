/**
 * The name a shell actually runs, read out of the word an agent wrote.
 *
 * hazard: the floor compared the raw word, so `Remove-Item`, `C:\Windows\System32\shutdown.exe`, `` Re`move-Item ``,
 * `r^d` and `(Remove-Item ...)` each ran a verb the floor denies under its POSIX name while matching nothing. These
 * helpers serve only the membership and operand tests of the shell-verb rules; `verbOf` stays the head the policy
 * surface and the history rule read ([/decisions/ad-157.md](/decisions/ad-157.md)).
 */

const GROUP_OPENERS = new Set(["", "$", "@", ".", "&"]);
const UNICODE_DASHES = ["\u2013", "\u2014", "\u2015"];

function regroup(text: string): { text: string; regrouped: boolean } {
  let current = text;
  let regrouped = false;
  for (;;) {
    const open = current.indexOf("(");
    if (open < 0 || !GROUP_OPENERS.has(current.slice(0, open))) {
      return { text: current, regrouped };
    }
    regrouped = true;
    current =
      current
        .slice(open + 1)
        .replace(/[)'"]/g, "")
        .split(/[ \t]+/)
        .find((piece) => piece !== "") ?? "";
  }
}

/** The normalized verb name, and whether the grouping step changed the word. */
export function verbName(text: string): { name: string; regrouped: boolean } {
  const grouped = regroup(text.replace(/[`^]/g, ""));
  let name = grouped.text;
  const open = name.indexOf("(");
  if (open >= 0) {
    name = name.slice(0, open);
  }
  name = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1).toLowerCase();
  return { name: name.endsWith(".exe") ? name.slice(0, -4) : name, regrouped: grouped.regrouped };
}

export function normalizedVerbName(text: string): string {
  return verbName(text).name;
}

// invariant: parentheses split the text rather than vanish, so `iex(iwr('x'))` reads `iwr` and not `iwrx`.
export function firstName(text: string): string {
  const spaced = text
    .replace(/\$\(|@\(/g, " ")
    .replace(/[()]/g, " ")
    .replace(/["']/g, "");
  const piece = spaced.split(/[ \t]+/).find((part) => part !== "" && part !== "&" && part !== ".");
  return piece === undefined ? "" : normalizedVerbName(piece.replace(/^&+/, ""));
}

export function isParameterWord(text: string): boolean {
  return text.startsWith("-") || UNICODE_DASHES.some((dash) => text.startsWith(dash));
}

/** A PowerShell argument with its parameter prefix spelled `-`, lower-cased; null when it carries no prefix. */
export function powershellParameter(text: string): string | null {
  const first = text.charAt(0);
  if (first !== "-" && first !== "/" && !UNICODE_DASHES.includes(first)) {
    return null;
  }
  return `-${text.slice(1)}`.toLowerCase();
}
