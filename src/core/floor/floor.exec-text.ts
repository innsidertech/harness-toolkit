import { Buffer } from "node:buffer";
import type { Head } from "./floor.head.ts";
import { isParameterWord, powershellParameter } from "./floor.name.ts";
import type { ShellSegment, ShellWord } from "./floor.tokenize.ts";
import { TEXT_EXECUTING_VERBS } from "./floor.verbs.ts";

/**
 * The text a segment hands to something that runs it, so the floor can judge that text as a command.
 *
 * hazard: the floor only saw through `bash -c`, `eval`, `source` and `.`. `powershell -Command`, `-EncodedCommand`,
 * `cmd /c`, `iex`, a script block and a subexpression each run a string the head word says nothing about, and every
 * destructive verb inside them passed ([/decisions/ad-157.md](/decisions/ad-157.md)).
 */
export type ExecutedTexts = { texts: string[]; undecodable: boolean };

/** The POSIX sets the floor already owns, passed in so this module never keeps a second copy of them. */
export type PosixExecutors = { shells: ReadonlySet<string>; expanding: ReadonlySet<string> };

const ENCODED = /^[A-Za-z0-9+/]+={0,2}$/;
const CMD_RUN_SWITCHES = new Set(["/c", "/k", "/r"]);

function joined(words: readonly ShellWord[]): string {
  return words.map((word) => word.text).join(" ");
}

export function decodeEncodedCommand(word: string | undefined): string | null {
  if (word === undefined || !ENCODED.test(word) || word.length % 4 !== 0) {
    return null;
  }
  const bytes = Buffer.from(word, "base64");
  return bytes.length % 2 === 0 ? bytes.toString("utf16le") : null;
}

function isCommandParameter(parameter: string): boolean {
  return (parameter.length >= 2 && "-command".startsWith(parameter)) || parameter.startsWith("-command");
}

function isEncodedParameter(parameter: string): boolean {
  return (
    parameter === "-e" ||
    parameter === "-ec" ||
    (parameter.length >= 3 && "-encodedcommand".startsWith(parameter))
  );
}

function positionalTexts(args: readonly ShellWord[]): string[] {
  return args.flatMap((word, index) => (isParameterWord(word.text) ? [] : [joined(args.slice(index))]));
}

function powershellTexts(args: readonly ShellWord[]): ExecutedTexts {
  const texts: string[] = [];
  let undecodable = false;
  let named = false;
  args.forEach((word, index) => {
    const parameter = powershellParameter(word.text);
    if (parameter !== null && isCommandParameter(parameter)) {
      named = true;
      texts.push(joined(args.slice(index + 1)));
    } else if (parameter !== null && isEncodedParameter(parameter)) {
      named = true;
      const decoded = decodeEncodedCommand(args[index + 1]?.text);
      undecodable = undecodable || decoded === null;
      texts.push(...(decoded === null ? [] : [decoded]));
    }
  });
  return named ? { texts, undecodable } : { texts: positionalTexts(args), undecodable: false };
}

function afterEach(args: readonly ShellWord[], matches: (text: string) => boolean): string[] {
  return args.flatMap((word, index) => (matches(word.text) ? [joined(args.slice(index + 1))] : []));
}

function headTexts(head: Head, words: readonly ShellWord[], posix: PosixExecutors): ExecutedTexts {
  const args = words.slice(head.index + 1);
  if (TEXT_EXECUTING_VERBS.has(head.name) || posix.expanding.has(head.name)) {
    return { texts: [joined(args)], undecodable: false };
  }
  if (posix.shells.has(head.name)) {
    return { texts: afterEach(args, (text) => text === "-c"), undecodable: false };
  }
  if (head.name === "powershell" || head.name === "pwsh") {
    return powershellTexts(args);
  }
  if (head.name === "cmd") {
    return { texts: afterEach(args, (text) => CMD_RUN_SWITCHES.has(text.toLowerCase())), undecodable: false };
  }
  return { texts: [], undecodable: false };
}

/** The words from `start` in word `from` up to the first `}`, or to the end of the segment. */
function blockFrom(words: readonly ShellWord[], from: number, start: number): string {
  const pieces: string[] = [];
  for (let index = from; index < words.length; index += 1) {
    const text = (words[index] as ShellWord).text.slice(index === from ? start : 0);
    const close = text.indexOf("}");
    if (close >= 0) {
      pieces.push(text.slice(0, close));
      break;
    }
    pieces.push(text);
  }
  return pieces.join(" ");
}

function scriptBlocks(words: readonly ShellWord[]): string[] {
  const texts: string[] = [];
  words.forEach((word, index) => {
    if (word.quotedStart) {
      return;
    }
    for (let at = word.text.indexOf("{"); at >= 0; at = word.text.indexOf("{", at + 1)) {
      texts.push(blockFrom(words, index, at + 1));
    }
  });
  return texts;
}

/** The words from `start` in word `from` up to the `)` that closes the group, counting parentheses. */
function groupFrom(words: readonly ShellWord[], from: number, start: number): string {
  const pieces: string[] = [];
  let depth = 1;
  for (let index = from; index < words.length; index += 1) {
    const text = (words[index] as ShellWord).text.slice(index === from ? start : 0);
    for (let at = 0; at < text.length; at += 1) {
      if (text[at] === "(") {
        depth += 1;
      } else if (text[at] === ")") {
        depth -= 1;
      }
      if (depth === 0) {
        pieces.push(text.slice(0, at));
        return pieces.join(" ");
      }
    }
    pieces.push(text);
  }
  return pieces.join(" ");
}

function opensGroup(word: ShellWord): boolean {
  return !word.quotedStart && (word.text.startsWith("(") || word.text.startsWith("@("));
}

// invariant: a head word is left to the grouping step of the verb name, so `(Remove-Item ./build)` is decided by
// its target and not refused as an expression.
function subexpressions(words: readonly ShellWord[], heads: readonly Head[]): string[] {
  const headIndexes = new Set(heads.map((head) => head.index));
  const firstHead = heads[0]?.index ?? words.length;
  const texts: string[] = [];
  words.forEach((word, index) => {
    if (headIndexes.has(index)) {
      return;
    }
    for (let at = word.text.indexOf("$("); at >= 0; at = word.text.indexOf("$(", at + 2)) {
      texts.push(groupFrom(words, index, at + 2));
    }
    if (index > firstHead && opensGroup(word)) {
      texts.push(groupFrom(words, index, word.text.indexOf("(") + 1));
    }
  });
  return texts;
}

export function executedTexts(
  segment: ShellSegment,
  heads: readonly Head[],
  posix: PosixExecutors,
): ExecutedTexts {
  const byHead = heads.map((head) => headTexts(head, segment.words, posix));
  return {
    texts: [
      ...byHead.flatMap((form) => form.texts),
      ...scriptBlocks(segment.words),
      ...subexpressions(segment.words, heads),
    ],
    undecodable: byHead.some((form) => form.undecodable),
  };
}
