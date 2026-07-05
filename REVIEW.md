# REVIEW.md — altimate-code

TypeScript/Bun monorepo (Effect-based) — an `opencode` fork shipping the `altimate` CLI/TUI: deterministic SQL/dbt/lineage/FinOps tooling embeddable under any LLM agent, plus a GitHub Action for automated dbt PR review.

## Goal: catch what CI cannot

CI here enforces type-safety and marker presence, not runtime correctness of async/Effect flows, cross-platform behavior, or security-sensitive edges (permission checks, auth, path/HTML escaping). Focus review effort there.

## Don't duplicate CI — never flag

- **`bun turbo typecheck` / `tsc`** — pure type errors, unused type imports. If it compiles, don't relitigate types.
- **Marker Guard** — presence/format of `altimate_change` marker comments is enforced by a dedicated CI job (`marker-guard` in `ci.yml`, see #872, #904), not at compile time. Don't flag a *missing* marker as a guess; CI will fail the PR. Do still flag *misuse* (see Focus Areas below) since Marker Guard checks presence, not correctness.
- **`anti-slop.yml`** — advisory only (made non-blocking after #741 auto-closed legitimate PRs); don't treat its output as a merge gate.
- **PR title/standards (`pr-standards.yml`)** — conventional-commit-style title checks are automated; don't nitpick title format.
- Pre-existing issues in code the diff doesn't touch.
- If a PR only touches `.claude/` skills, docs, or trivial config, skip deep review — see Comment style.

## Evidence standard — no speculation

Before flagging: trace the actual caller and the actual shipped surface. This repo carries a **parallel, unshipped "V2" runtime** (`packages/server` HttpApi, V2 projectors) alongside the shipped one (`packages/opencode/src/server`). Reviewers repeatedly had to correct findings that assumed V2 code was live. Always confirm which surface a change lands on before asserting impact.

## Severity calibration

- **Critical**: permission/auth bypass, unawaited Effect discarding a check, path/HTML injection, data loss on the shipped session/trace path, race conditions in shared session/worker state.
- **Warning**: env/config resolution edge cases, cache invalidation gaps, retry/timeout values not justified by evidence, cross-platform assumptions (macOS-only paths, bash `set -u` crashes), test isolation leaks.
- **Nit**: naming, comment clarity, minor duplication, non-shipped-surface cosmetics.

## Focus areas — bug classes this repo actually ships

1. **Effect values awaited without running them** (Critical). `ctx.ask(...)`-style helpers return an `Effect`, not a Promise; `await effectValue` awaits the *object*, never executes it — this shipped a real permission-check bypass (fixed via `await AppRuntime.runPromise(ctx.ask(...))`). **Flag when** an `Effect.promise`/`Effect.gen`-returning function is passed directly to `await`. **Verify** the function's return type first — Effect wrapping is easy to miss because it still type-checks.

2. **Race conditions in session/worker/tool lifecycle** (Critical, ~12 fix commits). Concurrent access to shared state (session cancel/idle flags, worker/server stop, file writes, dispatcher registries) without ordering guarantees: `cancel()` race + idle state on normal loop exit (#845), worker/server `stop()` moved into `finally` so an invalid `--session` no longer leaks them, stale-file race + error misclassification (#611), DuckDB concurrent-access retry. **Flag when** new code mutates session/worker/cache state from more than one async path without a lock or `finally`-guaranteed cleanup. **Verify** cleanup runs on both success and error/cancel paths.

3. **Env-var / config resolution correctness** (Warning→Critical, 8 fix commits). MCP config `${VAR}` interpolation needs full/recursive resolution, not single-pass; config-key normalization (`mcpServers`→`mcp`) and installer env injection have shipped broken more than once. **Flag when** a diff touches config loading or `${VAR}` interpolation. **Verify** resolution is applied everywhere the config is consumed, not just at one call site.

4. **Fork-merge hygiene: `altimate_change` marker misuse** (Warning). Every line diverging from upstream `opencode` must sit inside an `altimate_change start/end` marker (100% coverage is the current bar — 98 files/407 blocks). Marker Guard checks *presence*, not *correctness*. **Flag**: (a) redundant new markers nested inside an already-marked block (previously false-positived, #904); (b) upstream-only APIs (`LanguageModelV3*`, `specificationVersion: "v3"`) leaking into code that intentionally stays on `@ai-sdk/provider@2.0.1`/`LanguageModelV2*` — should be reverted/bridged, not silently upgraded.

5. **Auth/permission surface confusion (V2 vs shipped)** (Critical to flag correctly, Nit to over-flag). The shipped permission/OAuth routes live under `packages/opencode/src/server`; a structurally similar but **unshipped** V2 HttpApi exists under `packages/server`. **Flag when** a change weakens the shipped surface's check. **Verify first** which surface a route lives under — past "bugs" here were false positives against the dead V2 path.

6. **Telemetry/trace data loss across turns** (Warning). Trace waterfall, summary prompt, and chat tab have each independently lost data after an agent turn (trace corruption #865/#867, diff totals not persisted to session summary). **Flag when** new trace/telemetry-read state isn't confirmed to be re-published after summarize/snapshot/restart.

7. **dbt/warehouse connector correctness** (Warning, dbt=15 + snowflake/databricks/clickhouse — largest keyword cluster). dbt YAML file-kind classification, surfacing real dbt errors instead of generic "Could not parse", and warehouse-specific SQL (BigQuery `INFORMATION_SCHEMA`, Snowflake Cortex gating) have each shipped wrong. **Flag when** a diff edits a dbt file-kind regex or warehouse-specific SQL template. **Verify** file-kind matching handles `.py`/`.md` (not just `.sql`/`.yml`) and matches the most specific path segment, not the first match from root.

8. **SQL/HTML injection in generated strings** (Critical, rare but severe). Hand-built SQL/HTML instead of parameterized binds/escaping: parameterized binds replaced `escapeSqlString` in finops/schema (#277); XSS fixed in `oauth-callback.ts`/`plugin/codex.ts` via `escapeHtml()`; symlink escape in `plugin/shared.ts` fixed via `Filesystem.containsReal` (resolves symlinks) instead of `.contains`. **Flag** any new SQL/HTML string interpolation of external input, or path-containment checks that don't resolve symlinks first.

9. **Schema/config cache invalidation** (Warning). `Config.update()`/`updateGlobal()` needed to explicitly invalidate the per-directory `ScopedCache` (disposal alone didn't clear it); webfetch 404s were cached too long. **Flag** new cached derived values from config/fetch without an explicit invalidation path.

10. **Cross-platform shell/path assumptions** (Nit→Warning, dense in `.claude/skills/*` review comments). Scripts hardcode macOS paths (Homebrew, Chrome.app, `java_home`), assume Bash ≥4.4 array expansion under `set -u`, or skip forcing UTF-8 locale. **Flag** `.sh` edits using `set -u` with array expansions, single-OS hardcoded paths with no fallback, or legacy `java -version` parsing.

11. **Test isolation leaks under parallel CI** (Warning). `mock.module`/dispatcher `reset()` leaked state across test files (52 CI failures fixed via #460). **Flag** new tests using global mocks/dispatchers without confirmed teardown under parallel `bun test`.

## Repo invariants & landmines

- Effect (`effect` v4 beta) is used pervasively; `Effect.promise`/`Effect.sync`-returning functions look like normal async functions but must be run via `AppRuntime.runPromise` (or equivalent) — a bare `await` silently no-ops the effect.
- Ships two SDK generations: `LanguageModelV2*` (`@ai-sdk/provider@2.0.1`, current) vs `V3` (upstream-only) — V3 types/fields must not appear in code on the shipped path.
- `packages/opencode/src/server` is the shipped server; `packages/server` is a not-yet-shipped V2 HttpApi — don't assume the latter affects users.
- The binary ships as `altimate` (npm exposes both `altimate` and `altimate-code` on PATH); dbt/dbt-tools and skills are bundled into the published binary, so unbundled-dependency regressions (e.g. `.node` binaries, `@altimateai/altimate-core`) break the *published* artifact even when `bun run` in dev works fine.
- SQLite is the storage engine (`bun:sqlite`, migrated off `better-sqlite3`); schema is core-owned — a fresh DB may lack columns the fork's queries assume (`permission.data` was one such case).

## Known-intentional — don't flag

- `@ts-expect-error`/documented `as any` casts left in provider/TUI bridge code for known upstream SDK-shape mismatches during a bridge-merge PR (e.g. opentui `traits`, markdown `fg` prop) — these are intentionally temporary and explained inline.
- Tying cleanup lifecycles to `server.instance.disposed` instead of an `Effect` scope — reviewers explicitly declined this refactor as changing instance-bootstrap semantics for no correctness gain.

## High-blast-radius — never auto-edit

`packages/opencode/src/server/**` core routing, `db.ts`/storage migration code, `install`/`install.ps1`, `.github/workflows/*.yml`, `patches/`, `bun.lock`, `packages/*/package.json` version pins, anything under `test/upstream/` (bridge-merge regression suite).

## Comment style

Exact-line comments, one finding each, most-severe first. Prefer a `suggestion` block over prose when the fix is a small diff. Skip deep review of doc-only, `.claude/` skill, and CHANGELOG-only diffs — a clean diff gets `lgtm`.
