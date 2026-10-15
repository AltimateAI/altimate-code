# S5 — CLAUDE.md fallback instructions

Date: 2026-10-15. Upstream: OpenCode v2.0.29. Bun: 1.4.2.

**All four requested SDK/model acceptance cases pass. Classification: P\*.**
The context hook is sufficient to deliver v1's CLAUDE.md selection and ordering on
primary model requests without upstream edits. Custom hosts must pass their
effective instruction settings explicitly; core's durable instruction lifecycle
is not exposed through this hook.

## Implementation and integration

`src/instructions.ts` provides `claudeInstructions(options)` and a default
`ClaudeInstructions` definition. The existing default server plugin calls its
setup at `src/server.ts:25`. This module wiring is intentional:
`packages/core/src/plugin/module.ts:78` validates a **default** plugin definition
and `:125` selects that default. An additional named `Plugin.define` export alone
would not activate when this package is installed.

The plugin registers `ctx.session.hook("context", ...)`, scans the public Location
session directory through its project root, and appends text system parts. Public
inputs are `packages/plugin/src/promise/plugin.ts:26` (location/options) and
`packages/plugin/src/promise/session.ts:25` (mutable `system`). The four requested
tests load the ordinary default Altimate plugin, not a test substitute.

Files use exactly `Instructions from: ${absolutePath}\n${content}`, as core does
at `packages/core/src/instruction-discovery.ts:123`. Paths are canonicalized to
handle macOS `/var` versus `/private/var`. Matching files are deduplicated by path;
a path already represented by an instruction header in `event.system` is skipped.
Empty/unreadable CLAUDE content is not injected, matching v1's read/render behavior.

## Exact v1 rule

Source: the v1 fork's `packages/opencode/src/session/instruction.ts:63`, `:67`,
`:120`, `:127`, and `:170`, with ancestor ordering from
`packages/core/src/fs-util.ts:132` in that fork.

1. Global selection is independent of project selection. The first existing
   global file wins: `<global config>/AGENTS.md`, otherwise
   `<home>/.claude/CLAUDE.md` when Claude prompt discovery is enabled.
2. Project selection tries the complete ancestor walk for **AGENTS.md first**,
   then CLAUDE.md, then deprecated CONTEXT.md. The first filename with any match
   wins; it does not choose a filename independently at each directory.
3. Therefore **root AGENTS.md suppresses subdirectory CLAUDE.md**. Even an empty
   AGENTS.md wins filename selection and suppresses CLAUDE.md.
4. When CLAUDE.md wins, all matches are included nearest directory first, project
   root last. Global instructions precede project instructions.
5. `OPENCODE_DISABLE_CLAUDE_CODE` or `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT` disables
   only the home Claude fallback. The fork deliberately keeps project CLAUDE
   discovery (`instruction.ts:69`; `effect/runtime-flags.ts:29`).
   `OPENCODE_DISABLE_PROJECT_CONFIG` suppresses project discovery.

This slice supplies only CLAUDE fallback; it does not add deprecated CONTEXT.md or
replace v2's configured instruction sources. Core owns AGENTS.md. A project
AGENTS file suppresses project CLAUDE, but does not suppress a separately selected
home CLAUDE fallback. Conversely global AGENTS permits project CLAUDE.

## Core injection and ordering

Core loads global AGENTS then nearest-to-farthest project AGENTS in
`packages/core/src/config/plugin/instruction.ts:69` and `:90`. Its initial
instruction baseline is already part of `event.system` before our hook:
`packages/core/src/session/instruction-state.ts:164` renders it;
`packages/core/src/session/model-request.ts:110` adds it to system parts;
`:427` invokes the primary context hook. The tests observe these same system
parts and inspect the actual scripted model's received system prompt.

Project CLAUDE is appended after core global instructions. When home CLAUDE is
selected alongside core project AGENTS, it is inserted before the system part
containing core's instruction headers. No AGENTS content is copied by this plugin.

## SDK/model tests and non-vacuity

All fixtures initialize a real temporary Git repository so the project boundary
is genuine. Tests enable core project discovery, disable background title model
calls, and inspect `host.model.calls[0].prompt` system messages, including exact
path headers, marker counts, and order. The existing S1 host had
`config.project:false`; S5 explicitly enables it so the AGENTS assertions prove
core behavior.

| Test | Result |
| --- | --- |
| S5.1. root CLAUDE only, through default Altimate setup | PASS |
| S5.2. root AGENTS + CLAUDE: core AGENTS exactly once, no CLAUDE | PASS |
| S5.3. nested + root CLAUDE: nearest first, root last | PASS |
| S5.4. root AGENTS + nested CLAUDE: AGENTS wins entire walk | PASS |
| S5.5. home CLAUDE precedes project CLAUDE | PASS |
| S5.6. global AGENTS suppresses home CLAUDE, permits project CLAUDE | PASS |
| S5.7. home Claude disable preserves project CLAUDE | PASS |
| S5.8. project discovery disable preserves home fallback | PASS |
| S5.9. home CLAUDE precedes core project AGENTS; project CLAUDE absent | PASS |
| S5.10. empty root AGENTS still suppresses nested CLAUDE | PASS |

Non-vacuity: temporarily disabled `await ClaudeInstructions.setup(ctx)` in
`server.ts`, ran `bun test --test-name-pattern '^S5\.1\.'`, and observed exit 1:
the root marker was absent from the actual model system prompt. Restored the hook
in `finally`. See [negative-control output](evidence/s5-hook-mutation.txt).

## v2 API gaps and classification

| Gap / limitation | Exact v2 evidence | Handling / classification |
| --- | --- | --- |
| Effective global config directory, home, and instruction discovery policy are not public plugin context fields. | `packages/plugin/src/promise/plugin.ts:26`; host directory override at `packages/server/src/routes.ts:124`, project override at `:132`; internal policy at `packages/core/src/instruction-discovery.ts:38`. | **P\***: explicit options `home`, `configDirectory`, `project`, `global`, `disableClaudeCodePrompt`; defaults follow environment conventions. Hosts using overrides must mirror them into plugin options. |
| Core walks to HOME when the session lies beneath HOME, potentially beyond the project root; v1 stops at the worktree root. | `packages/core/src/config/plugin/instruction.ts:33` through `:37`. | Plugin scans only the v1 project range and never removes core content. An AGENTS above the project may therefore remain alongside project CLAUDE. Complete core discovery parity would need a policy change; this is outside the four acceptance cases. |
| No public instruction-source registration domain for durable baselines, updates, or compaction. | Public context at `packages/plugin/src/promise/plugin.ts:26`; internal discovery transform at `packages/core/src/instruction-discovery.ts:38`; frozen update events at `packages/core/src/session/instruction-state.ts:44`. | **P\*** for this requested context-hook slice: reread on each primary request. Exact participation in core's durable instruction lifecycle would require a new public extension point (**U** if that broader requirement is adopted). |
| Context hook is used only by primary requests. | `packages/core/src/session/model-request.ts:422` through `:430` dispatches separate context, compaction, generate, and title hooks. | This implementation covers primary system prompts. Auxiliary request parity is not claimed. Other public hooks exist, but were not added to this slice. |

No upstream files or Protocol/HttpApi surfaces were changed. No client generation
was needed. No files were staged or committed. No Obsidian copy was made because
the explicit task write boundary permits only the two package trees.

## Verification receipts

Commands used the requested Bun 1.4.2 PATH prefix and installed dependencies;
no network or install was required.

- `cd packages/altimate && bun test`: **25 pass / 0 fail / 0 TODO, 106 assertions**
  (12 S1 + 3 driver regressions + 10 S5), exit 0;
  [full combined results](evidence/round2-tests.txt).
- `cd packages/altimate && bun run typecheck`: exit 0;
  [package typecheck](evidence/round2-typecheck.txt).
- Repository-root `bun run check`: exit 0; 1,353 lint warnings, zero errors,
  zero SDK documentation problems, 37/37 successful package typechecks;
  [canonical lint/typecheck](evidence/round2-root-check.txt).
- `git diff --check`: pass. Index empty; pre-existing `bun.lock` change preserved.
- Round-2 elapsed work: approximately 13 minutes, within the 40-minute budget.

See [S1 findings](S1-findings.md#s1b--interruptible-duckdb-binding-2026-10-15-round-2)
for native cancellation, its separate negative control, and independent database
reopen evidence.
