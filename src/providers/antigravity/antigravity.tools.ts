import type { HarnessEvent, HarnessEventKind } from "../../contracts/index.ts";

export type ToolTranslation = {
  native: string;
  /** The `toolName` core sees; null where the kind already says what the tool is, as a shell event does. */
  canonical: string | null;
  pre: HarnessEventKind;
  post: HarnessEventKind;
  /** False where no capture has shown the host's payload for this tool. */
  verified: boolean;
  fill(event: HarnessEvent, args: Record<string, unknown>): void;
  /** Fields only a PreToolUse carries: what the tool is about to write or where it is about to run. */
  fillPre?(event: HarnessEvent, args: Record<string, unknown>): void;
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function setFilePath(event: HarnessEvent, value: unknown): void {
  const filePath = asString(value);
  if (filePath !== undefined) {
    event.filePath = filePath;
  }
}

function singleSubagentType(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length !== 1) {
    return undefined;
  }
  const only: unknown = value[0];
  if (only === null || typeof only !== "object") {
    return undefined;
  }
  return asString((only as Record<string, unknown>).TypeName);
}

/**
 * invariant: the only place in the repository that names this host's tools. Core and the floor match canonical
 * names (`Read`, `Write`, `Edit`), so a tool missing here is invisible to every path rule
 * ([/decisions/ad-156.md](/decisions/ad-156.md)).
 */
export const ANTIGRAVITY_TOOLS: readonly ToolTranslation[] = [
  {
    native: "view_file",
    canonical: "Read",
    pre: "read.before",
    post: "tool.after",
    verified: true,
    fill: (event, args) => setFilePath(event, args.AbsolutePath),
  },
  {
    native: "write_to_file",
    canonical: "Write",
    pre: "tool.before",
    post: "edit.after",
    verified: true,
    fill: (event, args) => setFilePath(event, args.TargetFile),
    fillPre: (event, args) => {
      const content = asString(args.CodeContent);
      if (content !== undefined) {
        event.proposedContent = content;
      }
    },
  },
  {
    native: "replace_file_content",
    canonical: "Edit",
    pre: "tool.before",
    post: "edit.after",
    verified: true,
    fill: (event, args) => setFilePath(event, args.TargetFile),
    fillPre: (event, args) => {
      const oldContent = asString(args.TargetContent);
      if (oldContent !== undefined) {
        event.proposedOldContent = oldContent;
      }
      const content = asString(args.ReplacementContent);
      if (content !== undefined) {
        event.proposedContent = content;
      }
    },
  },
  // hazard: no capture exists for this tool. The argument names are assumed from its single-edit sibling, so
  // content is deliberately not read — a wrong guess there would feed the floor a fabricated edit.
  {
    native: "multi_replace_file_content",
    canonical: "MultiEdit",
    pre: "tool.before",
    post: "tool.after",
    verified: false,
    fill: (event, args) => setFilePath(event, args.TargetFile),
  },
  {
    native: "run_command",
    canonical: null,
    pre: "shell.before",
    post: "shell.after",
    verified: true,
    fill: (event, args) => {
      const command = asString(args.CommandLine);
      if (command !== undefined) {
        event.command = command;
      }
    },
    fillPre: (event, args) => {
      const cwd = asString(args.Cwd);
      if (cwd !== undefined) {
        event.cwd = cwd;
      }
    },
  },
  {
    native: "invoke_subagent",
    canonical: "Task",
    pre: "tool.before",
    post: "tool.after",
    verified: true,
    // why: a batch spawn carries several types, and picking one would let the others pass under its name.
    fill: (event, args) => {
      const type = singleSubagentType(args.Subagents);
      if (type !== undefined) {
        event.spawnSubagentType = type;
      }
    },
  },
];

export function translationFor(native: string | undefined): ToolTranslation | null {
  if (native === undefined) {
    return null;
  }
  return ANTIGRAVITY_TOOLS.find((entry) => entry.native === native) ?? null;
}
