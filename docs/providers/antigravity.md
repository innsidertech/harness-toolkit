---
type: Provider
title: "Antigravity provider"
description: "The Antigravity adapter — the CLI (agy 1.2.13) as the one surface the floor is claimed for, the three wired events, the fail-closed posture that turns every harness failure into a refusal, recovery from the shared global hooks file, what is not supported, and the gaps nobody measured."
tags: [provider, antigravity, fail-closed]
timestamp: "2026-09-30"
---

# Antigravity provider

Source: `src/providers/antigravity/`. Decision record: [/decisions/ad-156.md](/decisions/ad-156.md).

## Surfaces

| Surface | Floor |
| --- | --- |
| Antigravity CLI (`agy` 1.2.13) | enforced — the only surface this provider claims |
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

A tool not in this table passes with its native name.

## Wiring target

`antigravity.wiring.ts` writes one root key, `tlc-harness`, into `~/.gemini/config/hooks.json`
(strategy `named-group`). Every other key in that file is the operator's: install keeps their values and their
order, and a second install with the same runtime leaves the file byte-identical. Install refuses a launcher
path containing a space, and refuses to touch a file that is not a JSON object.

Install, update and init never write the workspace `.agents/hooks.json` nor
`~/.gemini/antigravity-cli/settings.json`. `tlc harness init` says so when the host is present.

Both hooks files are protected wiring targets for **every** provider: the global file, and
`<projectDir>/.agents/hooks.json` for the event's own project. A `Write`, `Edit` or `MultiEdit` to either, from
any host, is refused as `wiring-tamper`. Reading them with `view_file` or `Read` stays allowed.

## Failure posture

This host reads an empty hook stdout as permission and `{}` as a refusal — the opposite of Cursor and Claude
Code. Under an `antigravity:` token, every harness failure is an explicit refusal with exit 0:

| Cause | Output |
| --- | --- |
| the launcher's runtime cannot run, the child does not start, exits non-zero or ends without a verdict | `{"decision":"deny","reason":"tlc-harness: launcher-error"}` |
| the child does not finish two seconds before the host's timeout (8 s, 8 s, 118 s) | `{"decision":"deny","reason":"tlc-harness: timeout"}` |
| stdin is empty, blank or not JSON | `{"decision":"deny","reason":"tlc-harness: invalid-stdin"}` |
| valid JSON that no provider detects, another provider detects, or this adapter does not translate | `{"decision":"deny","reason":"tlc-harness: unrecognized-payload"}` |
| the handler throws | `{"decision":"deny","reason":"tlc-harness: handler-error"}` |

The reason never carries a path, an environment value or parse detail. The detail goes to stderr, and a
diagnostic reaches disk only under the payload's `workspacePaths[0]`, never under the hook's working
directory. Cursor and Claude Code keep their fail-open behaviour.

A decision the harness did make renders as follows. Abstain renders `{"decision":"allow"}`, because empty
stdout already means allow on this host and there is no neutral output; the provider conformance test
"abstain never renders anything that reads as an approval" matches the other hosts' approval keys and does not
catch this shape. `allow`, `context`, `continue` and a rewritten output also render `{"decision":"allow"}`.
`deny`, and the `ask` and rewritten input this host has no channel for, render a deny carrying the reason.
`{}` and empty stdout are never produced.

## Recovery

The global file is shared with the IDE and the app. With the group in place, a surface nobody verified, or a
CLI newer than 1.2.13 that sends another payload, can fire the group and have **every tool denied** with
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

- Hooks fired from inside a subagent were not measured.
- MCP tool calls were not captured.
- `multi_replace_file_content` is not verified: its arguments are assumed from its single-edit sibling, and only
  the path is read.
- `Remove-Item` and other PowerShell cmdlets are outside the floor's POSIX destructive verbs.
- A relative path is resolved against `projectDir`, not against the command's `Cwd`, so a `Cwd` the model
  chooses inside `.agents` with `./hooks.json` reaches the file without `wiring-tamper`.
- Only the `.agents/hooks.json` of `workspacePaths[0]` is protected; the other roots of a multi-root workspace
  are not.
- A tool outside the translation table passes with its native name and is not seen by the floor's path rules.
- `define_subagent` can turn on `enable_write_tools`, and the floor sees it as a generic tool.
- Stop may run twice per execution loop; there is no deduplication.
- The effect of a deny on `Stop` was not measured.
- Two differently named hooks, one in the global file and one in the workspace file, both fire, about 90 ms
  apart; the same name `tlc-harness` in both files was not measured.
- A `tlc-harness` hook with `enabled: false` in the workspace `.agents/hooks.json` might disable the global
  group; this was not measured, and the doctor does not read the workspace file.
- `allow` in an interactive session was not measured.
- The payload of a CLI newer than 1.2.13 was not measured.
- A launcher path containing a space is not supported.
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
