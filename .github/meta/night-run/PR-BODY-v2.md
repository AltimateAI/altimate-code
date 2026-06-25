### What does this PR do?

Bridges the fork from upstream OpenCode **v1.4.0 → v1.17.9** (a no-common-ancestor tree-overlay merge of ~1850 files) and reconciles all fork customizations on top.

Highlights:
- **Effect-API migration**: reconciled the fork's Promise/namespace code against upstream's `Context.Service`/`Layer`/Effect-Schema rewrite (Service facades + `makeRuntime` Promise wrappers; `zod()`↔Effect-Schema bridges; new Tool API via `tool-zod-compat`).
- **Bootstrap deadlock fixed**: `withStatics` infinite recursion + a re-entrant runtime build that prevented the agent from running at all.
- **CI runtime aligned**: the merge bumped the required `bun@1.3.14` but CI/pre-push stayed on `1.3.10`, which couldn't boot the merged CLI as a subprocess (748 false failures). All 6 CI pins → 1.3.14.
- **Test-suite DB migration race fixed**: parallel test files replayed baseline `CREATE TABLE` migrations against an already-current schema (`table \`project\` already exists`, ~324 cascading fails). `applyOnly()` now adopts the current schema when the journal diverges; test-DB reset preserves schema; boot-time project-copy refresh isolated. **Production is unaffected** (single-process boot migrates once — proven by 88/88 real-model e2e).
- **Branding regressions fixed**: restored fork branding the merge re-leaked into system prompts/themes/httpapi, **plus** TUI leaks the regex scanner missed (sidebar wordmark split across JSX spans, home-screen tips pointing at the wrong binary/dirs/trigger, error hints, terminal title).
- **8 dropped v1.17.9 session behaviors restored** (partial bash-output forwarding, `server_error` retryable, content-filter→error, snapshot pre-capture, `compaction.auto:false`, shell expansion, signed-reasoning spacing, stop-with-tools continuation).

### Type of change

- [x] Bug fix (non-breaking)
- [x] New feature (upstream version bump v1.4.0 → v1.17.9)
- [x] This change requires a documentation update

### Issue for this PR

Closes #963

### How did you verify your code works?

- **typecheck: 0 errors** monorepo-wide (13/13 workspace tasks, enforced by the pre-push hook).
- **Unit suite green**: full `bun test` = **10,455 pass / 0 functional fail** after the DB-race fix (was ~324 inherent fails masked as the prior over-stated "1 fail"). Independently re-verified; 0 `SQLiteError`/`database is locked`/`disk I/O` residue. (One test was a local-only artifact — a dev's gcloud ADC made `config.providers()` return a google-vertex provider whose model `variants`/`release_date` fail the generated SDK's `Declaration` schema; the preload now isolates Google creds so local matches CI.)
- **Real-model e2e — compiled binary**: **88/88 (100%)** azure/gpt-5.5 across 22 coding/data tasks (dbt, sql-join, python, refactor, multi-step…), plus ~220 earlier azure/gpt-4o-mini runs.
- **TUI visually inspected** (tmux capture of the binary): altimate logo, command palette, model/theme pickers, prompt→response loop, sidebar, help — all render correctly with no `/api` error flood.
- **Independent verification**: a git-differential audit, a 3-agent accept-vs-restore jury, an independent TUI-upstream-diff audit (0 missing upstream TUI files/behaviors/commands), and 2 codex audits.

### Checklist

- [x] My code follows the style guidelines of this project
- [x] I have performed a self-review of my own code
- [x] I have commented my code (`// altimate_change` markers)
- [x] I have made corresponding changes to the documentation
- [x] My changes generate no new warnings (branding scan: 0 leaks; Marker Guard green)
- [x] I have added tests that prove my fix is effective (90+ new tests incl. DB-race regression)
- [x] New and existing unit tests pass locally

### Known remaining work (tracked, non-blocking)

- `config.providers()` returns model data (`variants`, `release_date`, `experimentalOver200K`) richer than the generated SDK's `Declaration` response schema for providers like google-vertex — the SDK schema/codegen should be regenerated to match (route works in production; only the strict SDK response-validator is behind).
- Cosmetic: the default theme is still named `opencode` (renaming needs a config-compat alias).

Full validation artifacts under `.github/meta/night-run/`: `NIGHT2-STATUS.md`, `DBRACE-FIX.md`, `WS3-VISUAL-FINDINGS.md`, `TUI-UPSTREAM-DIFF.md`, `e2e/GPT55-BINARY-RESULTS.md`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
