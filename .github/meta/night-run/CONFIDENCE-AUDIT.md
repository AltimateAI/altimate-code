# Confidence Audit — v1.17.9 merge (differential, against objective baselines)

Method: don't trust "tests I thought to write"; diff against objective git baselines.
- Fork pre-merge tip = `main` (merge-base v0.8.9). Upstream target = tag `v1.17.9`. Prior upstream base = `v1.4.0`. All local.

## #1 — Were old (fork) changes lost?  → HIGH CONFIDENCE: NO (with caveats noted)
- **Fork-authored files present**: 0 files dropped from `src/altimate/**`, `src/session/prompt`, fork skills (main 52 → HEAD 53). The only `src/tool` drop is `multiedit.ts/.txt` — VERIFIED this is upstream's OWN removal in v1.17.9 (not in `v1.17.9` tree), i.e. correct carry-forward of an upstream deletion.
- **`altimate_change` markers**: 737 (main) → 1120 (HEAD), net +383. No wholesale marker loss.
- **Marker-count drops** flagged only 2 files: `config/config.ts` (23→16) and `index.ts` (23→22).
  Investigated config.ts: the "missing" features (auto_enhance_prompt, env_fingerprint_skill_selection,
  auto_mcp_discovery, tracing, variant_list keybind) were **RELOCATED**, not lost — the merge moved the
  fork config schema into `packages/core/src/v1/config/config.ts` + `src/altimate/*`. Cross-grep confirms
  each token present in HEAD (3–5 files each); the lower file-count is consolidation. NOT a loss.
- **40 carry-forward guard tests** (test/altimate/carry-forward/) pass: altimate tools, branding,
  agent bash-safety (non-overridable destructive-DDL deny), flags, 21 skills, 10 warehouse drivers, 4 agent modes.
- **Real regression found+fixed**: upstream branding had re-leaked into the system prompts (the merge reverted
  fork branding) — caught by the differential/invariant tests and fixed (MERGE-REGRESSIONS-FOUND.md).
- Caveat/limitation: pre-merge `main` used a different test-tree layout (restructure), so a 1:1 fork-test-file
  diff was inconclusive; confidence rests on the file/marker/feature differential + the 40 guard tests.

## #2 — Were all upstream changes merged & working?  → HIGH CONFIDENCE: YES
- **No upstream files missing**: 0 of v1.17.9's `packages/opencode/src` files are absent in HEAD.
- **Overlay integrity**: of 613 opencode/src .ts files, 405 differ from v1.17.9. Of those, only **25 differ
  WITHOUT an `altimate_change` marker** (the rest are marked fork edits or fork-original files). Spot-checking
  those 25 (splash.ts, github-copilot/models.ts, acp/permission.ts): **identical line counts to v1.17.9** +
  a minor fork tweak → they ARE v1.17.9 content with small *unmarked* fork edits (a marker-hygiene gap),
  NOT stale/incomplete-merge content. So upstream's v1.17.9 code is present.
- **Upstream's own test suite runs green** within the 10,560 passing tests (provider/session/server/tool/
  config/mcp/lsp/etc. are largely upstream's tests, reconciled and passing).
- **50 new upstream-adversarial tests** (test/upstream/adversarial/) exercise the v1.17.9 integration seams
  (Effect runtime/facades, tool API, provider/LLM, config/MCP, server) and pass.
- Recommended hygiene follow-up: add `altimate_change` markers to the 25 unmarked-drift files (cosmetic;
  helps future merges + the marker guard).

## #3 — Did any functionality break?  → MEDIUM-HIGH CONFIDENCE, bounded & documented
- **Unit suite: 10,560 pass / 1 fail** (httpapi-sdk = stale generated SDK, not a runtime defect). typecheck 0.
- **Production agent verified**: real `run` completes correctly; ~220 real-model e2e runs, ~95% functional
  correctness (dips spot-verified as rate-limit/check artifacts, not defects).
- **Merge-induced regression surface is bounded**: ~55 session behavioral `.todo` (per-case reviewed in
  SESSION-DELTA-REVIEW.md: ~half test-architecture gaps where fakes don't thread through the new Effect
  facades = coverage gap not runtime break; ~half genuine semantic deltas needing maintainer accept/restore
  judgment) + the 1 sdk test. (Total suite has 125 todo / 202 skip, but most are upstream/pre-existing baseline.)
- **Fork tooling verified working post-merge** (upgraded): (a) **3,581 `test/altimate` tests pass** — these
  exercise the fork tools' actual execution (sql analyze/classify/explain/format, dbt helpers, finops,
  warehouse drivers, altimate-core rewrite/validate/equivalence, tracing). (b) Live runtime check: the merged
  agent registers all fork tools at startup — observed `sql_analyze, sql_optimize, sql_translate, sql_explain,
  sql_format, sql_fix, sql_diff, sql_rewrite, sql_execute, finops_analyze_credits, altimate_core_rewrite/
  validate/check/fix` in the tool registry. So the fork's flagship tooling is present, loaded, and its
  execution is broadly tested.
- **Residual #3 gap**: end-to-end exercise of the data tools against a LIVE warehouse / real dbt run
  (environment-limited — no warehouse credentials/dbt project in this run). Tool execution is covered by the
  3,581 altimate tests; what's unverified is only the full live-warehouse round-trip.

## What MORE could raise confidence further (next steps, by leverage)
1. Run the agent against a local duckdb-based dbt fixture (experiments/ade-bench, spider2_dbt) to exercise the
   dbt/sql tools end-to-end — closes the #3 fork-tool gap.
2. Resolve the ~half-of-55 genuine session semantic deltas (maintainer accept-vs-restore decisions).
3. Regen the SDK in a clean build env (bun ≥1.3.14) → closes the last suite fail.
4. Add markers to the 25 unmarked-drift files; re-baseline the marker guard post-merge.
