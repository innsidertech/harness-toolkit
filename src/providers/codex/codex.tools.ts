import type { HarnessEvent, HarnessEventKind } from "../../contracts/index.ts";

type CodexToolRow = {
  native: string;
  canonical: null;
  pre: HarnessEventKind;
  post: HarnessEventKind;
  verified: true;
  fill(event: HarnessEvent, args: Record<string, unknown>): void;
};

function unread(_event: HarnessEvent, _args: Record<string, unknown>): void {
  // why: no stdin key is named, so nothing is copied onto the event.
}

/**
 * invariant: the only native names this provider claims. `post` is the `HarnessEventKind` the port requires.
 * It is not a wired host event.
 */
export const CODEX_TOOLS: readonly CodexToolRow[] = [
  {
    native: "Bash",
    canonical: null,
    pre: "shell.before",
    post: "shell.after",
    verified: true,
    fill: unread,
  },
  {
    native: "collaborationspawn_agent",
    canonical: null,
    pre: "tool.before",
    post: "tool.after",
    verified: true,
    fill: unread,
  },
  {
    native: "collaborationwait_agent",
    canonical: null,
    pre: "tool.before",
    post: "tool.after",
    verified: true,
    fill: unread,
  },
];
