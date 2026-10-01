import { isParameterWord, verbName } from "./floor.name.ts";
import type { ShellWord } from "./floor.tokenize.ts";
import { WRAPPERS } from "./floor.verb.ts";
import { LAUNCHING_WRAPPERS, SWITCH_TAKING_VERBS } from "./floor.verbs.ts";

/** A head candidate: its normalized name, its word's index in the segment, and the words that are its operands. */
export type Head = { name: string; index: number; operands: ShellWord[] };

const START_SWITCH = /^\/[A-Za-z]+$/i;
const START_VALUED_SWITCHES = new Set(["/d", "/node", "/affinity"]);
const COMMAND_SWITCH = /^\/[A-Za-z?](:[^\\/]*)?$/;

// why: the same three skips `verbOf` makes, so a head this finds is never earlier than the one it finds.
function skipCount(words: readonly ShellWord[], index: number, afterStart: boolean): number {
  const text = (words[index] as ShellWord).text;
  if (WRAPPERS.has(text) || isParameterWord(text) || text.includes("=")) {
    return 1;
  }
  if (!afterStart) {
    return 0;
  }
  if (text === "") {
    return 1;
  }
  if (START_VALUED_SWITCHES.has(text.toLowerCase())) {
    return 2;
  }
  return START_SWITCH.test(text) ? 1 : 0;
}

function nextRemaining(words: readonly ShellWord[], from: number): number | null {
  let index = from;
  while (index < words.length) {
    const skip = skipCount(words, index, true);
    if (skip === 0) {
      return index;
    }
    index += skip;
  }
  return null;
}

function operandText(word: ShellWord, regrouped: boolean): ShellWord {
  return regrouped && word.text.endsWith(")") ? { ...word, text: word.text.slice(0, -1) } : word;
}

function headAt(words: readonly ShellWord[], index: number): Head {
  const { name, regrouped } = verbName((words[index] as ShellWord).text);
  const takesSwitches = SWITCH_TAKING_VERBS.has(name);
  const operands = words
    .slice(index + 1)
    .map((word) => operandText(word, regrouped))
    .filter((word) => word.text !== "" && !isParameterWord(word.text))
    .filter((word) => !takesSwitches || !COMMAND_SWITCH.test(word.text));
  return { name, index, operands };
}

/**
 * The head of a segment as the shell-verb rules read it: `verbOf`'s walk, plus `Start-Process`, `saps` and `start`
 * as wrappers. After `start` a quoted first word may be cmd's window title or PowerShell's executable, so both it
 * and the next word are candidates; a rule denies when any candidate denies.
 */
export function segmentHeads(words: readonly ShellWord[]): Head[] {
  let afterStart = false;
  let index = 0;
  while (index < words.length) {
    const skip = skipCount(words, index, afterStart);
    if (skip > 0) {
      index += skip;
      continue;
    }
    const { name } = verbName((words[index] as ShellWord).text);
    if (LAUNCHING_WRAPPERS.has(name)) {
      afterStart = afterStart || name === "start";
      index += 1;
      continue;
    }
    const heads = [headAt(words, index)];
    const second = afterStart && words[index]?.quotedStart ? nextRemaining(words, index + 1) : null;
    if (second !== null) {
      heads.push(headAt(words, second));
    }
    return heads;
  }
  return [];
}
