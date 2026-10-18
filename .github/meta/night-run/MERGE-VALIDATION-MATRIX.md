# Comprehensive merge validation — upstream v1.4.0→v1.17.9 bridge (PR #964)

Method: not spot-checks. The merge surface (3,254 upstream commits) reduces to a BOUNDED,
enumerable set validated by three contracts, each covered exhaustively.

## Surface (measured)
- 226 upstream-shared source files modified by the merge (exist in both v1.17.9 and HEAD)
- 293 fork-only source files
- 106 fork "altimate_change" behaviors present on main whose marker text wasn't found verbatim on HEAD

## Coverage matrix

| Contract | Question | Method | Result |
|---|---|---|---|
| C1: no dropped upstream code | did conflict-resolution revert upstream fixes? | 226 files reviewed by 11 subsystem agents; diff v1.17.9↔HEAD each | No ship-blocker. ~6 real MED/LOW refinement drops (below). High-value upstream fixes (Plan-Mode security, models-cache recovery, session-metadata migration identity, corrupt-message handler) present VERBATIM. |
| C2: no fork-feature loss | did fork customizations survive? | 106 candidate behaviors verified present-on-HEAD or dropped | Most false (path-restructure moved cli/cmd/tui→tui/src + reworded). Real drops: beginner-tips onboarding, internal-url inconsistency, minor branding. |
| C3: behavior | does the artifact work? | full suite + schema + upgrade + journey + real binary + CI | 10,555 tests pass (2 flaky, pass isolated); 19/19 schema tables parity; upgrade 16/16; journey 10 green; CI functional gates green. |

## REAL findings (all MED/LOW — none block ship), fork-wanted, verified by lead

| # | file | issue | sev | fix |
|---|------|-------|-----|-----|
| 1 | session/compaction.ts | tail-preserving compaction dead: consumers read `tail_start_id` (session.ts:775, message-v2.ts:1016) but no writer sets it on new compaction parts | MED | restore the writer that stamps `tail_start_id` when creating the compaction part |
| 2 | share/share-next.ts:152 | dropped `Effect.catchCause` on fullSync+flush → unhandled rejection on share-sync failure | MED | wrap fullSync/flush failures (log, don't throw) |
| 3 | session/llm.ts:214 | Copilot billing split-brain: `includeRawChunks` absent from streamText, but `copilotTotalNanoAiu`/`totalNanoAiu` consumers depend on it → Copilot billing metadata never populates | MED | pass `includeRawChunks: true` for the Copilot provider path |
| 4 | tui first-run (tips) | fork onboarding UX dropped: main had `BEGINNER_TIPS`/`isFirstTime`; HEAD has zero refs | MED | restore beginner-tips/first-time hint |
| 5 | util/filesystem.ts:131 | Windows path conversion lost: HEAD does only `realpathSync.native`; upstream also did `windowsPath()` (cygwin/gitbash/WSL) | LOW | restore windowsPath() normalization for win32 |
| 6 | session/retry.ts:71 | drops upstream's extra "retry 5xx even if SDK says non-retryable" guard | LOW | re-add the status-code 5xx retry guard |
| 7 | cli/cmd/mcp.ts:419 | CLI MCP installs default to opencode.json not altimate-code.json (both still discovered) | LOW | prefer altimate-code.json in CONFIG_FILENAMES |
| 8 | tui.ts:166 / runtime.ts:737 | internal worker url `opencode.internal` inconsistent with `altimate-code.internal` elsewhere (internal routing key, not user-visible) | LOW | unify the virtual-host string |
| — | footer/uninstall/upgrade/initialize.txt | unmarked fork branding + 1-2 "OpenCode config" strings | LOW | marker hygiene + branding fix |

## INTENTIONAL divergences (verified NOT bugs — fork deliberately differs)
- task.ts background subagents — marker: "hides disabled background mode"
- providers Alibaba/Venice/Azure-workflow/GitLab-Duo — moved to packages/core/src/plugin/provider/* or not shipped
- run.ts interactive/replay/demo — fork ships its own run command (executive/analyst modes, max-turns, tracing)
- plugin/index.ts loader + omitted upstream provider plugins — fork ships its own provider set
- server.ts move-session — actually PRESENT via httpapi control-plane group (false positive)

## FALSE positives (verified)
- agent.ts:524 safety-denial re-append — intended fail-safe (marker documents it)

## Verdict
Comprehensive review of the ENTIRE merge surface found NO ship-blocker (no crash, data-loss, or
security regression). ~6 medium + a few low fork-wanted refinements to restore. The merge correctly
adopted upstream v1.17.9 (fixes present verbatim, schema parity, upgrade path clean) and preserved
the fork (registries, agents, tools, DE features intact).
