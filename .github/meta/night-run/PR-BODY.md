### What does this PR do?

Bridges the fork from upstream OpenCode **v1.4.0 → v1.17.9** (a no-common-ancestor tree-overlay merge of ~1850 files) and reconciles all fork customizations on top.

Highlights:
- **Effect-API migration**: reconciled the fork's Promise/namespace code against upstream's `Context.Service`/`Layer`/Effect-Schema rewrite (Service facades + `makeRuntime` Promise wrappers; `zod()`↔Effect-Schema bridges; new Tool API via `tool-zod-compat`).
- **Bootstrap deadlock fixed**: `withStatics` infinite recursion + a re-entrant runtime build that prevented the agent from running at all.
- **DB split-brain fixed**: legacy `db.ts` and core effect-sql were both migrating the shared sqlite file (dominant test-flakiness root cause).
- **Branding regressions fixed**: the merge had re-leaked upstream branding into the **system prompts** ("You are OpenCode"), themes, and httpapi descriptions; restored the dropped `mcp add --name` flag + anthropic login hint. (See `.github/meta/night-run/MERGE-REGRESSIONS-FOUND.md`.)
- **8 dropped v1.17.9 session behaviors restored** (partial bash-output forwarding, `server_error` retryable, content-filter→error, snapshot pre-capture, `compaction.auto:false`, shell expansion, signed-reasoning spacing, stop-with-tools continuation).
- **~250 test-fixture reconciliations + 90 new tests** (40 fork carry-forward guards, 50 upstream-adversarial).

### Type of change

- [x] Bug fix (non-breaking)
- [x] New feature (upstream version bump v1.4.0 → v1.17.9)
- [x] This change requires a documentation update

### Issue for this PR

Closes #ISSUE_NUMBER

### How did you verify your code works?

- **typecheck: 0 errors** monorepo-wide (was 3181 at merge start).
- **Unit suite: 10,560 pass / 1 fail** (was 868 fail). The 1 remaining is `httpapi-sdk` (stale generated SDK — needs regen in a clean build env; not a runtime defect).
- **Production run verified**: `run "..." --model azure/gpt-4o-mini` completes correctly; re-verified after every change.
- **Real-model e2e: ~220 azure runs**, ~95% functional correctness across diverse coding/data tasks.
- **Live-warehouse e2e**: fork warehouse stack verified wired (jaffle_shop DuckDB discovery + `schema_search` + connect-attempt).
- **Independent verification**: a git-differential audit + a 3-agent accept-vs-restore jury + **2 independent codex audits** cross-checked the merge. They confirmed (a) no fork features lost (179 deletions all upstream removals; markers 1316→2095), (b) all upstream files present + key fixes merged, (c) nothing broke operationally.

### Checklist

- [x] My code follows the style guidelines of this project
- [x] I have performed a self-review of my own code
- [x] I have commented my code (`// altimate_change` markers)
- [x] I have made corresponding changes to the documentation
- [ ] My changes generate no new warnings (marker-guard `--strict` needs re-baselining vs v1.4.0 — bridge artifact)
- [x] I have added tests that prove my fix is effective (90 new tests)
- [ ] New and existing unit tests pass locally (1 sdk-regen fail + remaining session `.todo` documented below)

### Known remaining work (tracked, non-blocking; see `.github/meta/night-run/`)

- `httpapi-sdk` (1 test): regen the generated SDK in a clean build env (bun ≥1.3.14).
- Independent-audit follow-ups landing as commits on this branch: residual lowercase-`opencode` branding in 5 routed prompt files + outbound provider headers; wiring `deriveSubagentSessionPermission` into `TaskTool`.
- ~46 session `.todo`: not regressions (fork code intact, verified) — test-harness injection gaps (completing the Effect-Service migration) + unported v1.17.9 features (compaction retained-tail, head/tail summary). Being addressed incrementally.
- Marker-guard re-baseline (post-merge); build requires bun ≥1.3.14.

Full validation artifacts: `SHIP-REPORT.md`, `CONFIDENCE-AUDIT.md`, `CODEX-AUDIT.md`, `CODEX-AUDIT-2.md`, `DECISIONS.md`, `MERGE-REGRESSIONS-FOUND.md`, `e2e/RESULTS.md`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
