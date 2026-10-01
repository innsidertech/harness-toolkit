---
type: Provider
title: "Codex provider"
description: "The Codex adapter — codex exec of codex-cli 0.159.3 is the only claimed surface, a hooks.json on disk is not the floor, and what stayed unverified."
tags: [provider, codex, fail-closed]
timestamp: "2026-10-01"
---

# Codex provider

Source: `src/providers/codex/`. Decision record: [/decisions/ad-158.md](/decisions/ad-158.md).

## Claim

The claim is `codex exec` of `codex-cli 0.159.3` with SHA256
`57E1BDAB42C0559A74558CA17E85D5C7893CAA5F1E582F67E9DDD6D97FA705A7`.

| Surface | Floor |
| --- | --- |
| `codex exec` of `codex-cli 0.159.3` | the deny object below, and only while the hook actually runs |
| interactive CLI | unverified |
| desktop app | unverified |
| IDE extension | unverified |

## Floor inactive

Without hook trust and without `--dangerously-bypass-hook-trust`, the hook does not run, the tool still runs,
and that state is `floor inactive`. The flag does not persist to the next invocation. A `hooks.json` file on
disk is not the floor.

On `PreToolUse`, empty stdout, `{}`, `not-json`, exit `1`, and exit `2` leave the tool running. The deny object
is what blocks:

`{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"<reason>"}}`

with exit code `0`.

## Out of the claim

- install without the bypass flag
- `hooks.json` versus `[hooks]` precedence
- `apply_patch`
- wiring tamper
- `PostToolUse` deny
- `Stop` deny
- hook timeout deny
- managed `requirements.toml`
- `/hooks` hash trust

## Windows

The Windows hooks key is `commandWindows`. A quoted value may contain spaces. The hooks key `command` alone is
not the Windows path. `-s workspace-write` rejecting `powershell.exe` is host policy. The hook cwd is the
session workspace. A `CODEX_HOME` under Temp is refused by the host with
`Refusing to create helper binaries under temporary dir`. This provider does not require the child `session_id`
to equal the parent `session_id`.

## Detection

`detect` returns `false` until a fixture names stdin keys. `toEvent` returns `null` for every record and every
host-event string, including `codex:PreToolUse`. Neither function reads a named stdin field.

## Capability descriptor

`codex.capabilities.ts`:

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

`codex.policy-defaults.ts` supplies no model allowlist (`allowedModels` is absent), no blocked patterns, and no
untrusted tools.

## Wired events

One hook event is wired: host event `PreToolUse`, handler `tool-before`, argv token `codex:PreToolUse`,
`timeoutSeconds` `10`. `SessionStart`, `PostToolUse`, `Stop`, `SubagentStart`, and `SubagentStop` are not wired.

## Event mapping

`codex.inbound.ts` exports `EVENT_KIND_BY_HOOK` as `{}` and does not export a fan-out table:

<!-- generated:event-mapping -->

| Hook | HarnessEventKind |
|---|---|

<!-- /generated -->

## Tools

The hand-written tool table names only these three. `post` is the `HarnessEventKind` the port requires. It is
not a measured `PostToolUse` claim. `canonical` is `null` on every row. `fill` does not read a named stdin field.

| Native tool | Before | After | Verified |
| --- | --- | --- | --- |
| `Bash` | `shell.before` | `shell.after` | trigger |
| `collaborationspawn_agent` | `tool.before` | `tool.after` | trigger |
| `collaborationwait_agent` | `tool.before` | `tool.after` | trigger only; a deny of this name is not a claim |

`apply_patch` is absent.

## Wiring target

`wiring().target`, `presencePath`, and the single `wiringTargets()` entry are the same path: `hooks.json` inside
`CODEX_HOME` when that variable is a non-empty string, otherwise `hooks.json` inside `~/.codex`. An empty
`CODEX_HOME` counts as unset. The path does not end in `config.toml`. `strategy` is `replace`. This provider
does not write `hooks.json` or `config.toml`.

`tlc harness doctor` reports `codex wiring` / `not installed` when the file is absent. When the file is present,
the level is `warn` and the detail is `Codex hooks.json is present and this check does not call it installed wiring.`
The same sentence is used for an empty body, a `not-json` body, and a body the Cursor checker would call wired.
That sentence does not name a command that writes the file. The check is never `wired`.

## See also

- [/providers/index.md](/providers/index.md)
- [/decisions/ad-158.md](/decisions/ad-158.md)
