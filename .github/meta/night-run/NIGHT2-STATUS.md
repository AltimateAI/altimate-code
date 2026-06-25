# Night-2 status — PR #964 (v1.17.9 merge), honest current state

## Correction to the prior record
The earlier docs claimed the unit suite was **"10,560 pass / 1 fail"**. That did NOT reflect the real
`cd packages/opencode && bun test` invocation. The real full suite has an **inherent DB-migration race**
(~324 fails, `table \`project\` already exists`) that is:
- present on BOTH bun 1.3.10 (CI: 1437 `already exists` log lines, the bulk of its 748 fails) and 1.3.14,
- NOT external contention (a fully-quiet run still fails),
- NOT a production bug — the compiled binary boots one process, migrates once, and is fine
  (proven by the 88/88 gpt-5.5 e2e and the live TUI run).
It is a parallel-TEST race on the shared `OPENCODE_DB`. This is the **real CI blocker**.

## Fixed tonight
1. **CI bun-version 1.3.10 → 1.3.14** (commit 117b6b0583, pushed). Root cause of CI's 748 *subprocess-boot*
   failures: the merge bumped `packageManager` to bun@1.3.14 but CI/pre-push stayed on 1.3.10, too old to
   boot the merged CLI as a subprocess. Local bun upgraded to 1.3.14 to match.
2. **4 residual branding leaks** the regex scanner missed (uncommitted, pending rebuild re-verify):
   - sidebar footer wordmark (split `<b>Open</b><b>Code</b>` → `altimate code`)
   - home tips (`opencode <cmd>`→`altimate`, `.opencode/`→`.altimate-code/`, `/opencode`→`/oc`, config file/dir)
   - error.ts hints, attention.ts terminal title.

## Verified tonight
- **WS2** — all upstream v1.17.9 TUI changes present (audit: 0 missing files/behaviors/commands).
- **WS3** — TUI visually inspected via tmux: logo=altimate, command palette, model picker (providers+models
  load, no /api flood), theme picker, prompt→response loop (`TUI_OK` 3.8s), sidebar, help — all working.
- **e2e** — gpt-5.5 compiled-binary battery: **88/88 (100%)** across 22 coding/data tasks.

## In progress / remaining
- **#16 DB-race fix** — delegated to codex (DBRACE-PROMPT.md). Sound fix rubric: serialize migration
  process-globally (the module `lock` is likely duplicated across module instances) and/or make `schema.up`
  idempotent; must NOT reduce production concurrency, swallow errors, or just blind-retry. busy_timeout=5000
  is already set (database.ts:29); `{behavior:"immediate"}` is passed (migration.ts:60).
- **WS4 commands** + **WS5 traces** — codex, queued AFTER the DB fix (kept quiet for codex-A's suite runs).
- After DB fix: rebuild binary once (branding + DB fix), re-verify footer/tips visually, commit+push
  branding + DB fix, update the PR body with honest final numbers, confirm CI green.

## Deferred cosmetic (not blockers)
- Default theme named "opencode" (config-compat risk to rename) and "OpenCode Zen" provider display name.
