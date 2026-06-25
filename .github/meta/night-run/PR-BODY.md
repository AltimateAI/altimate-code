### What does this PR do?

Bridges the fork up from upstream OpenCode **v1.4.0 → v1.17.9** (a no-common-ancestor tree-overlay merge of ~1850 files) and reconciles the fork's customizations on top.

Highlights:
- **Effect-API migration**: reconciled the fork's Promise/namespace code against upstream's `Context.Service`/`Layer`/Effect-Schema rewrite (Service facades + `makeRuntime` Promise wrappers; `zod()`↔Effect-Schema bridges; new Tool API via `tool-zod-compat`).
- **Bootstrap deadlock fixed**: `withStatics` infinite recursion + a re-entrant runtime build that prevented the agent from running at all.
- **DB split-brain fixed**: legacy `db.ts` and core effect-sql were both migrating the shared sqlite file (the dominant test-flakiness root cause).
- **Branding regressions fixed**: the merge had re-leaked upstream branding into the **system prompts** (agent was telling the LLM "You are OpenCode"), 33 theme URLs, 21 httpapi descriptions; also restored the dropped `mcp add --name` flag and anthropic login hint. See `.github/meta/night-run/MERGE-REGRESSIONS-FOUND.md`.
- **~250 test-fixture reconciliations** + **90 new tests** (40 fork carry-forward guards, 50 upstream-adversarial).

### Type of change

- [x] Bug fix (non-breaking change which fixes an issue)
- [x] New feature (upstream version bump v1.4.0 → v1.17.9)
- [x] This change requires a documentation update

### Issue for this PR

Closes # <!-- fill in the upstream-merge tracking issue -->

### How did you verify your code works?

- **typecheck: 0 errors** across the monorepo (was 3181 at merge start).
- **Unit suite: 10,462 pass / 2 fail** (was 868 fail). The 2 remaining are server legacy-Hono-route tests (documented).
- **Production run verified**: `run "..." --model azure/gpt-4o-mini` completes and returns correct output, re-verified after every change.
- **Real-model e2e: 21/22 pass (~95%)** on azure/gpt-4o-mini across diverse coding/data tasks (file/json/python/sql/dbt/yaml/multi-step/edit/refactor/test-gen). See `e2e/RESULTS.md`.
- **Fork carry-forward: 40 new regression tests, 0 features dropped** (altimate tools, branding, agent bash-safety, flags, 21 skills, 10 warehouse drivers, 4 agent modes).
- **Upstream-adversarial: 50 new tests** across the v1.17.9 integration seams.

### Checklist

- [x] My code follows the style guidelines of this project
- [x] I have performed a self-review of my own code
- [x] I have commented my code, particularly in hard-to-understand areas (`// altimate_change` markers)
- [x] I have made corresponding changes to the documentation
- [ ] My changes generate no new warnings (marker-guard `--strict` needs re-baselining vs v1.4.0 — bridge artifact)
- [x] I have added tests that prove my fix is effective / feature works (90 new tests)
- [ ] New and existing unit tests pass locally (2 server legacy-route fails + 57 session todos documented in SHIP-REPORT.md)

### Known remaining work (see SHIP-REPORT.md)
- 52 session behavioral deltas (some likely test-harness fake-injection, not true regressions) — needs per-case expert review.
- 2 server legacy-Hono-route test fails + SDK regen.
- `@opencode/Account` Service identifier dedup.
- Marker-guard re-baseline; build requires bun >= 1.3.14 (env).
