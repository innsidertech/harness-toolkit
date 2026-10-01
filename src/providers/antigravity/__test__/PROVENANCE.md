# Provenance — Antigravity fixtures and goldens

## Source

- Host: `agy` CLI 1.2.13, print mode.
- Machine: Windows 10.0.19045.
- Model: `gemini-3.8-flash-high`.
- Captured: 2026-09-29.
- Origin: `.specs/features/tlc-harness-antigravity/captures/` in the agentic-squad repository. Each capture file holds
  the capture hook's own bookkeeping (`mode`, `eventArg`, `why`, `cwd`, `argvTail`) and, under `stdin`, the payload
  the host sent. A fixture here is that `stdin` object.
- The stdin captures are from `agy` 1.2.13. The success output of `PostToolUse` and `Stop` (empty stdout, exit 0) was
  measured on `agy` 1.2.14, print mode, the CLI's default model, on 2026-09-30, recorded as decision AD-048 of the
  agentic-squad repository (not this repository's `ad-048.md`).

## Redaction

Each fixture is the capture's `stdin` after exactly two rules, and no other field differs:

1. Identifiers become `<id>` (`conversationId` and the same value inside `artifactDirectoryPath` and
   `transcriptPath`). The captures already carry this rule.
2. The user segment `MCorsato` becomes `dev`, in the forward-slash form (`/Users/<user>` becomes `/Users/dev`) and in
   the backslash form (`\Users\<user>` becomes `\Users\dev`, written `\\` in JSON). The repository's
   `no-personal-paths` gate refuses a home path with a real account name in any tracked file, and JSON cannot carry
   that gate's per-line exception.

The 48 captures are copied in `__test__/captures/`, from `.specs/features/tlc-harness-antigravity/captures/` in the
agentic-squad repository. Both rules were applied to the whole file, to every string value at any depth, not only to
`stdin`; the account segment is read from each capture's own `stdin.workspacePaths[0]`.

The test for AGH-51 (`antigravity.fixtures.test.ts`) compares each fixture with its capture by applying both rules
to the capture. The captures sit beside the tests, so the tests that read them no longer skip.

## Fixture → capture

| Fixture | Capture | Note |
| --- | --- | --- |
| `allow-PreToolUse-define_subagent--.json` | `allow-PreToolUse-define_subagent--.json` | |
| `allow-PreToolUse-invoke_subagent--.json` | `allow-PreToolUse-invoke_subagent--.json` | |
| `allow-PreToolUse-replace_file_content--.json` | `allow-PreToolUse-replace_file_content--.json` | |
| `allow-PreToolUse-run_command--.json` | `allow-PreToolUse-run_command--.json` | |
| `allow-PreToolUse-view_file--.json` | `allow-PreToolUse-view_file--.json` | |
| `allow-PreToolUse-write_to_file--.json` | `allow-PreToolUse-write_to_file--.json` | |
| `allow-PostToolUse-define_subagent--.json` | `allow-PostToolUse-define_subagent--.json` | |
| `allow-PostToolUse-invoke_subagent--.json` | `allow-PostToolUse-invoke_subagent--.json` | |
| `allow-PostToolUse-replace_file_content--.json` | `allow-PostToolUse-replace_file_content--.json` | |
| `allow-PostToolUse-run_command--.json` | `allow-PostToolUse-run_command--.json` | |
| `allow-PostToolUse-view_file--.json` | `allow-PostToolUse-view_file--.json` | |
| `allow-PostToolUse-write_to_file--.json` | `allow-PostToolUse-write_to_file--.json` | |
| `allow-Stop--NO_TOOL_CALL-.json` | `allow-Stop--NO_TOOL_CALL-.json` | `fullyIdle: false` |
| `allow-Stop--NO_TOOL_CALL-idle.json` | `allow-Stop--NO_TOOL_CALL-idle.json` | `fullyIdle: true` |
| `allow-PreInvocation---.json` | `allow-PreInvocation---.json` | not wired; `toEvent` returns null |
| `allow-PostInvocation---.json` | `allow-PostInvocation---.json` | not wired; `toEvent` returns null |
| `synthetic-PreToolUse-multi_replace_file_content--.json` | none | **synthetic**, unverified — see below |

`synthetic-PreToolUse-multi_replace_file_content--.json` is `allow-PreToolUse-replace_file_content--.json` with only
`toolCall.name` changed. No capture of `multi_replace_file_content` exists, so its argument names are an assumption
and the adapter marks the mapping `verified: false`.

## Goldens

The host's response table comes from the discovery's Q3 (response mode → effect on the tool), not from the captures.

| Golden | Content | Q3 row | Corroborating capture |
| --- | --- | --- | --- |
| `golden/allow.json` | `{"decision":"allow"}` | `allow` → the tool runs | `allow-PostToolUse-*` exist: the tool ran and its after-event fired |
| `golden/deny.json` | `{"decision":"deny","reason":"<reason>"}` | `deny` → the tool is refused | `deny-PreToolUse-view_file--.json` exists and no `deny-PostToolUse-*` does: the tool never ran |

The same table is why `{}` and an empty stdout are forbidden outputs on `PreToolUse`: `-PreToolUse-view_file--.json`
(the `{}` mode) shows `{}` refusing the tool, and `empty-PostToolUse-view_file--.json` shows an empty stdout letting it
run. `golden/allow.json` is therefore the success output on `PreToolUse` only. On `PostToolUse` and `Stop` the success
output is empty stdout, from the 1.2.14 measurement above: there `{"decision":"allow"}` replaced the tool's result with
`unknown field "decision"`, and `{}` is still forbidden because it refuses the tool on `PreToolUse`.

## Notes

- The captures are the stdin the hook received, not the stdout the hook wrote. The mapping from response mode to
  output comes from the discovery's Q3.
- A capture's file name is derived from mode, event and tool. An event repeated with the same key overwrote the
  earlier file, so each capture keeps only the last occurrence of its key.
