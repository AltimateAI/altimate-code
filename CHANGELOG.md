# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Automated dbt unit test generation** — new `dbt_unit_test_gen` tool and `/dbt-unit-tests` skill for generating dbt unit tests (v1.8+) from a compiled manifest. Parses `manifest.json` via the shared `parseManifest()` helper, uses `dbtLineage()` for column lineage, detects testable SQL constructs (CASE/WHEN, JOINs, NULLs, window functions, division, incremental), and assembles complete YAML via the `yaml` library. Includes `input: this` mock for incremental models, `format: sql` fallback for ephemeral deps (even with no known columns), cross-database support via `database` param in `schema.inspect`, deterministic test names (no `Date.now()`), and rich `UnitTestContext` (descriptions, lineage, compiled SQL) for LLM-driven test value refinement. Handles seeds and snapshots as first-class ref() deps. Warns when upstream deps cannot be resolved. (#673)
- **Manifest parse cache** — `loadRawManifest()` helper caches by path+mtime; `parseManifest()` and `dbtLineage()` both go through it, so a 128MB manifest is read and parsed once per request instead of once per call. Benefits any tool that makes multiple manifest-backed calls in sequence.
- **`description` on `DbtModelInfo`/`DbtSourceInfo`** — surfaces model and source descriptions from schema.yml in the parsed manifest result, enabling downstream tools to provide richer semantic context to the LLM.
- **`adapter_type` on `DbtManifestResult`** — exposes the dbt adapter type (snowflake, bigquery, etc.) from manifest metadata for dialect auto-detection.

## [0.5.20] - 2026-04-09

### Added

- **Altimate model auto-selection** — when Altimate credentials are configured and no model is explicitly chosen, `altimate-backend/altimate-default` is selected automatically. Respects the `provider` filter in config if set. No manual `/model` selection needed for first-time Altimate users. (#665)

### Fixed

- **Connection string passwords with special characters** — passwords containing `@`, `#`, `:`, `/`, or other URI-reserved characters are now automatically percent-encoded in `connection_string` configs. Previously these caused cryptic authentication failures because the URI parser split on the wrong delimiter. Already-encoded passwords (`%XX`) are left untouched. Affects all URI-based drivers (PostgreSQL, MongoDB, ClickHouse). (#597, closes #589)
- **`trace list` pagination** — `trace list` now supports `--offset` for navigating large trace histories, displays "Showing X-Y of N" with a next-page hint, and caps the TUI trace dialog at 500 items (up from 50) with an overflow message pointing to the CLI for the full set. (#596, closes #418)
- **ClickHouse edge-case hardening** — added tests for `LowCardinality(Nullable(...))` nullability detection, `Map`/`Tuple` wrapper handling, undefined type fallback, and SQL comment/string-escape edge cases in the LIMIT injection guard. (#599, closes #592)

### Testing

- 31 new adversarial tests covering connection string sanitization (injection, encoding edge cases, ReDoS, Unicode, null bytes), pagination boundary math (Infinity, NaN, fractional, negative inputs), and `Provider.parseModel` edge cases.

## [0.5.19] - 2026-04-04

### Added

- **`${VAR}` environment variable interpolation in configs** — use shell/dotenv-style `${DB_PASSWORD}`, `${MODE:-production}` (with defaults), or `$${VAR}` (literal escape) anywhere in `altimate.json` and MCP server configs. Values are JSON-escape-safe so passwords containing quotes or backslashes can't corrupt your config structure. The existing `{env:VAR}` syntax continues to work for raw text injection. (#655, closes #635)

### Fixed

- **Plan agent warns when the model refuses to tool-call** — if the plan agent's model returns text without invoking any tools, altimate-code now surfaces a one-shot TUI warning suggesting you switch models via `/model` instead of silently hanging. Telemetry event `plan_no_tool_generation` emitted for session-level diagnosis. (#653)
- **GitLab MR review: large-diff guard & prompt-injection hardening** — MRs exceeding 50 files or 200 KB of diff text are truncated upfront with a user-visible warning, and the review prompt explicitly frames MR content as untrusted input. (#648)
- **Atomic trace file writes** — `FileExporter` now writes to a temp file and renames, preventing partial/corrupt trace JSON on crash or SIGKILL. Stale `.tmp.*` artifacts older than 1 hour are swept during prune. (#646)
- **15s timeout on credential validation** — `AltimateApi.validateCredentials()` no longer hangs indefinitely if the auth endpoint stalls. (#648)
- **Shadow-mode SQL pre-validation telemetry** — measures catch-rate for structural errors (missing columns, tables) against cached schema before enabling user-visible blocking in a future release. Fire-and-forget, zero impact on the `sql_execute` hot path. No raw SQL, schema identifiers, or validator error text transmitted. (#643, #651)
- **GitLab docs rewrite** — replaced "work in progress" warning with a complete guide: quick-start, authentication, self-hosted instances, model selection, CI example. (#648)

### Testing

- 25 new adversarial tests covering env-var interpolation (JSON-escape safety, single-pass substitution, ReDoS, escape hatch, defaults), atomic write hygiene (race conditions, tmp sweep, sessionId sanitization), and telemetry identifier-leak guards. New ClickHouse finops/profiles/registry coverage. (#624)

## [0.5.18] - 2026-04-04

### Added

- **Native GitLab MR review** — review merge requests directly from your terminal with `altimate gitlab review <MR_URL>`. Supports self-hosted GitLab instances, nested group paths, and comment deduplication (updates existing review instead of posting duplicates). Requires `GITLAB_PERSONAL_ACCESS_TOKEN` or `GITLAB_TOKEN` env var. (#622)
- **Altimate LLM Gateway provider** — connect to Altimate's managed model gateway via the TUI provider dialog (select a provider → "Altimate"). Credentials validated before save, stored at `~/.altimate/altimate.json` with `0600` permissions. (#606)

### Fixed

- **Glob tool: timeout, home/root blocking, default exclusions** — glob searches now timeout after 30s (returning partial results) instead of hanging indefinitely. Scanning `/` or `~` is blocked with a helpful message. Common directories (`node_modules`, `.git`, `dist`, `.venv`) are excluded by default. (#637)
- **MCP config normalization** — configs using `mcpServers` (Claude Code, Cursor format) are auto-converted to `mcp` at load time. External server entries with `command` + `args` + `env` are transformed to altimate-code's native format. (#639)
- **Light theme readability** — fixed white-on-white text in light terminal themes by adding explicit foreground colors to markdown and code blocks. (#640)

## [0.5.17] - 2026-04-02

### Added

- **Custom dbt `profiles.yml` path resolution** — Altimate Code now resolves `profiles.yml` using dbt's standard priority: explicit path → `DBT_PROFILES_DIR` env var → project-local `profiles.yml` → `~/.dbt/profiles.yml`. Teams using `DBT_PROFILES_DIR` in CI get zero-friction auto-discovery. Jinja `{{ env_var('NAME') }}` patterns are resolved automatically. A warning is shown when `DBT_PROFILES_DIR` is set but the file is not found. (#605)

### Fixed

- **ClickHouse: SQL comment injection bypass** — Comments could previously mask write statements from the read-only LIMIT guard. String literals are now stripped before comment removal to prevent false matches. (#591)
- **ClickHouse: `LowCardinality(Nullable(...))` nullability** — Schema inspection previously reported these columns as non-nullable; now correctly detected as nullable. (#591)
- **ClickHouse: connection lifecycle guards** — All query methods now throw a clear error if called before `connect()`, preventing cryptic TypeErrors. (#591)
- **ClickHouse: `binds` parameter handling** — Queries with parameterized binds no longer throw a driver error; the parameter is safely ignored (ClickHouse uses `query_params` natively). (#591)
- **Stale file retry loops on WSL and network drives** — `FileTime.read()` now uses filesystem mtime instead of wall-clock, eliminating 782-iteration retry loops caused by clock skew on WSL (NTFS-over-9P), NFS, and CIFS mounts. Set `OPENCODE_DISABLE_FILETIME_CHECK=true` as escape hatch if needed. (#611)
- **Error classification: `file_stale` split and keyword fix** — `file_stale` is now a distinct error class; HTTP 4xx errors no longer misclassify as validation failures; restored `"does not exist"` keyword for SQL errors like `"column foo does not exist"`. (#611, #614)

## [0.5.16] - 2026-03-30

### Added

- **ClickHouse support** — Connect to ClickHouse Cloud, self-hosted clusters, or local Docker instances running ClickHouse 23.3+. Supports HTTP/HTTPS, TLS mutual auth, and dbt-clickhouse adapter auto-discovery. Includes MergeTree optimization guidance, materialized view design, partition pruning analysis, and query history via `system.query_log`. Requires `npm install @clickhouse/client` (#574)

### Fixed

- **Agent loop detection** — The agent now detects when a single tool is called 30+ times in a session (a pattern seen with runaway tool loops) and pauses for confirmation before continuing. Complements the existing same-input repetition detection (#587)
- **Improved error diagnostics** — Tool failures now report more specific error categories (`not_configured`, `file_not_found`, `edit_mismatch`, `resource_exhausted`) instead of generic "unknown" classification, improving support triage (#587)
- **Session environment metadata** — `session_start` telemetry now includes `os`, `arch`, and `node_version` for environment-based segmentation (#587)

## [0.5.15] - 2026-03-29

### Added

- **Plan agent two-step approach** — outline first, confirm, then expand; plan refinement loop with edit-in-place (capped at 5 revisions); approval phrase detection ("looks good", "proceed", "lgtm") (#556)
- **Feature discovery & progressive disclosure** — contextual suggestions after warehouse connection (schema, SQL, lineage, PII); dbt auto-detection recommending `/dbt-develop`, `/dbt-troubleshoot` (#556)

### Fixed

- **SQL classifier fallback security hardening** — invert fallback to whitelist reads (not blacklist writes), handle multi-statement SQL, strip line comments, fix `HARD_DENY_PATTERN` `\s` → `\b`; fix `computeSqlFingerprint` referencing undefined `core` after safe-import refactor (#582)
- **Edit tool nearest-match error messages** — `buildNotFoundMessage` with Levenshtein similarity search shows closest file content when `oldString` not found, helping LLM self-correct (#582)
- **Webfetch failure caching and actionable errors** — session-level URL failure cache (404/410/451) with 5-min TTL; status-specific error messages telling the model whether to retry; URL sanitization in errors to prevent token leakage (#582)
- **Nested `node_modules` in `NODE_PATH`** — `@altimateai/altimate-core` NAPI resolution now works for npm's hoisted and nested layouts (#576)
- **Null guards across 8 tool formatters** — prevent literal `undefined` in user-facing output for sql-analyze, schema-inspect, sql-translate, dbt-manifest, finops, and warehouse tools; DuckDB auto-retry on `database is locked` (#571)
- **Telemetry error classification** — add `http_error` class, expand connection/validation/permission patterns, redact sensitive keys in input signatures (#566)
- **Pre-release review findings** — remove dead code, fix `classifySkillTrigger()` unknown trigger handling, add null guards in lineage/translate tools (#580)
- **Binary alias hard copy** — use `cp` instead of symlink for `altimate-code` binary alias to fix cross-platform compatibility (#578)

### Testing

- Verdaccio sanity suite: 50 new tests across 3 phases, added to CI and release workflows (#560, #562)
- 12 new tests for `buildNotFoundMessage`, `computeSqlFingerprint`, and webfetch error messages (#582)

## [0.5.14] - 2026-03-28

### Added

- **MongoDB driver support** — 11th supported database with full MQL command set (find, aggregate, CRUD, indexes), BSON type serialization, schema introspection via document sampling, and cross-database queries; includes 90 E2E tests (#482)
- **Skill follow-up suggestions** — contextual "What's Next?" suggestions after skill completion to reduce first-run churn; maps 12 skills to relevant follow-ups with warehouse discovery nudge (#546)
- **`altimate-dbt build` without `--model`** — builds the entire dbt project via `unsafeBuildProjectImmediately`, replacing the separate `build-project` command (#546)
- **`upstream_fix:` marker convention** — new tag for temporary upstream bug fixes with `--audit-fixes` command to review carried fixes before upstream merges (#555)
- **Verdaccio-based sanity suite** — local npm registry test harness for real install verification, smoke tests, and upgrade scenarios (#503)

### Fixed

- **Locale duration days/hours swap** — `Locale.duration()` for values ≥24h showed wrong days/hours (total hours instead of remainder); e.g., 25h now correctly shows `1d 1h` (#529)
- **Dispatcher `reset()` not clearing lazy registration hook** — `reset()` only cleared handlers but left `_ensureRegistered` alive, causing flaky test failures (#529)
- **Impact analysis showing project-wide test count** — was using `manifest.test_count` (all tests in project) instead of counting only tests referencing the target model (#529)
- **Prototype pollution in `SkillFollowups.get()`** — `FOLLOWUPS["__proto__"]` traversed `Object.prototype`; fixed with `Object.hasOwn()` guard (#558)
- **Shallow freeze in `SkillFollowups.get()`** — `Object.freeze()` on array didn't freeze nested objects, allowing shared state mutation; fixed with deep copy (#558)
- **CI Bun segfault resilience** — Bun 1.3.x crashes during test cleanup now handled by checking actual pass/fail summary instead of exit code (#555)

### Testing

- 52 adversarial tests for v0.5.14 release: `SkillFollowups` injection/boundary/immutability, `Locale.duration` tier transitions, `Dispatcher.reset` hook cleanup (#558)
- Consolidated 39 test PRs — 1,173 new tests across session, provider, MCP, CLI stats, bus, and utility modules (#498, #514, #545)

## [0.5.13] - 2026-03-26

### Fixed

- **Pin `@altimateai/altimate-core` to exact version** — prevents npm from resolving stale cached binaries during install (#475)
- **Flaky `dbt Profiles Auto-Discovery` tests in CI** — stabilized tests that failed intermittently due to timing issues

### Changed

- **Bump `yaml` from 2.8.2 to 2.8.3** — dependency update in `packages/opencode` (#473)

## [0.5.12] - 2026-03-25

### Added

- **`altimate-dbt` auto-discover config** — `altimate-dbt` commands now auto-detect `dbt_project.yml` and Python from the current directory without requiring `altimate-dbt init` first; supports Windows paths (`Scripts/`, `.exe`, `path.delimiter`) (#464)
- **Local E2E sanity test harness** — Docker-based test suite (`test/sanity/`) for install verification, smoke tests, upgrade scenarios, and resilience checks; runnable via `bun run sanity` (#461)

### Fixed

- **`altimate-dbt` commands fail with hardcoded CI path** — published binary contained a baked-in `/home/runner/work/...` path for the Python bridge; `copy-python.ts` now patches `__dirname` to use `import.meta.dirname` at runtime (#467)

### Testing

- 42 adversarial tests for config auto-discovery and dbt resolution: `findProjectRoot` edge cases (deep nesting, symlinks, nonexistent dirs), `discoverPython` with broken symlinks and malicious env vars, `resolveDbt` with conflicting env vars and priority ordering, `validateDbt` timeout/garbage handling, Windows constant correctness, `path.delimiter` usage, `buildDbtEnv` mutation safety
- 484-line adversarial test suite for the `__dirname` patch: regex edge cases, ReDoS protection, mutation testing, idempotency, CI smoke test parity, bundle runtime structure validation

## [0.5.11] - 2026-03-25

### Fixed

- **README changelog gap** — updated README to reflect releases v0.5.1 through v0.5.11; previous README only listed up to v0.5.0
- **npm publish transient 404s** — added retry logic (3 attempts with backoff) to `publish.ts` for concurrent scoped package publishes that hit npm registry race conditions

## [0.5.10] - 2026-03-24

### Added

- **`altimate-code check` CLI command** — deterministic SQL checks (linting, formatting, style) that run without an LLM, suitable for CI pipelines and pre-commit hooks (#453)
- **Data-viz skill improvements** — lazy initialization, data-code separation, color contrast rules, icon semantics, field validation, and pre-delivery checklist (#434)

### Fixed

- **Snowflake Cortex not visible before authentication** — provider now appears in the provider list even when not yet authenticated (#447)
- **New user detection race condition** — first-run welcome flow and telemetry events could fire out of order or be skipped entirely (#445)
- **52 CI test failures from `mock.module` leaking across files** — test isolation fix for the new `check` command e2e tests (#460)
- **Missing `altimate_change` marker** — added required upstream marker on `isStatelessCommand` guard to pass Marker Guard CI (#457)

### Changed

- **Rename Recap back to Trace** — reverted the Recap branding to Trace across 29 files for better AI model comprehension of session recording concepts (#443)

### Testing

- Consolidated 12 hourly test PRs into single batch: slugify, hints sort, skill formatting, batch tools, filesystem utilities, wildcard matching — 1,680 new test lines (#439)
- `altimate-code check` unit + e2e test suites (1,687 lines) (#453)
- Snowflake Cortex provider visibility tests (#447)

## [0.5.9] - 2026-03-23

### Fixed

- **Codespaces support** — skip machine-scoped `GITHUB_TOKEN` that lacks repo access, cap provider retries to prevent infinite loops, fix phantom `/discover-and-add-mcps` command that was missing from builtin commands (#415)
- **`sql_analyze` reports "unknown error" for successful analyses** — tool returned error status even when analysis completed successfully (AI-5975) (#426)
- **Remove `semver` dependency from upgrade path** — replaced with zero-dependency version comparison to prevent users getting locked on old versions when `semver` fails to load (#421)
- **Ship `discover-and-add-mcps` as a builtin command** — moved from `.opencode/command/` config directory to embedded template so it works out of the box (#409)

### Testing

- Comprehensive upgrade decision tests covering version comparison, downgrade prevention, and edge cases (#421)
- Codespace E2E tests for `GITHUB_TOKEN` filtering, retry caps, and provider initialization (#415)

## [0.5.8] - 2026-03-23

### Fixed

- **dbt commands crash with `SyntaxError: Cannot use import statement`** — bundled `dbt-tools/` was missing `package.json` with `"type": "module"`, causing Node to default to CJS and reject ESM imports. Broken since v0.5.3. (#407)
- **Publish script idempotency** — re-running `publish.ts` without cleaning `dist/` would crash because the synthesized `dbt-tools/package.json` (no `name`/`version`) polluted the binary glob scan (#407)
- **Skill builder `ctrl+i` keybind** — ESC navigation and dialog lifecycle fixes in TUI skill management (#386)
- **Upgrade notification silently skipped** — multiple scenarios where the upgrade check was bypassed (#389)
- **Phantom `sql_validate` tool** — removed non-existent tool reference from analyst agent permissions, replaced with `altimate_core_validate` (#352)
- **CI test suite stability** — eliminated 29 pre-existing test failures: added `duckdb` devDependency, fixed native binding contention with retry logic and `beforeAll` connections, increased timeouts for slow bootstrap operations, added `--timeout 30000` to CI workflow (#411)

### Added

- **Trace (session recording)** — session trace with loop detection and enhanced viewer (#381)
- **ESM bundling regression tests** — 9 e2e tests verifying Node can load `altimate-dbt` via symlink, wrapper, and direct invocation paths

### Testing

- 133 new tests across 9 modules: finops role access, tool lookup, config path parsing, ID generation, file ignore/traversal, patch operations, session instructions/messages/summaries, shell utilities (#403)
- SQL validation adversarial + e2e test suites (#352)
- Provider error classification — overflow detection and message extraction (#375)
- Impact analysis DAG traversal and training import parsing (#384)
- RPC client protocol and `abortAfter`/`abortAfterAny` coverage (#382)
- Color, signal, and defer utility coverage (#379)
- MCP config CRUD + Locale utility coverage (#369)

## [0.5.7] - 2026-03-22

### Added

- **Impact analysis tool** — analyze downstream blast radius of dbt model/column changes across the DAG with severity classification (SAFE/LOW/MEDIUM/HIGH) and actionable recommendations (#350)
- **Training import tool** — bulk import training entries from markdown style guides, glossaries, and playbooks with dry-run preview and capacity management (#350)
- **CI check command** — `/ci-check` template for pre-merge SQL validation that analyzes changed files, checks dbt integrity, and generates CI-friendly reports (#350)
- **`--max-turns` budget limit** — CLI option to cap agent steps for CI/enterprise governance (#350)
- **LM Studio provider** — local Qwen model support via LM Studio (#340)
- **Improved onboarding** — first-time user hints on home screen, beginner-focused tips, practical quickstart examples (#350)
- **Expanded `/discover`** — detects additional cloud warehouse credentials (Snowflake, BigQuery, PostgreSQL, Databricks, Redshift) (#350)
- **Automated test discovery** — `/test-discovery` command for hourly test generation with critic validation (#364, #365, #366, #367)

### Fixed

- Yolo mode now respects explicit deny rules from session config instead of auto-approving everything (#350)
- Training limits increased from 20→50 entries per kind and 16KB→48KB budget for enterprise teams (#350)

### Testing

- E2E tests for trace viewer with adversarial cases (#353)
- Bash tool PATH injection tests (#366)
- `fn()` wrapper and `skillSource` trust classification tests (#367)
- `AsyncQueue`/`work()` utility and `State.invalidate` coverage (#364)

## [0.5.6] - 2026-03-22

### Added

- **Skill CLI command** — new top-level `altimate-code skill` with `list`, `create`, `test`, `show`, `install`, `remove` subcommands for managing AI agent skills and paired CLI tools (#342)
- **`.opencode/tools/` auto-discovery** — executables in `.opencode/tools/` (project) and `~/.config/altimate-code/tools/` (global) are automatically prepended to PATH in BashTool and PTY sessions (#342)
- **TUI skill management** — `/skills` dialog with domain-grouped skill browser, `ctrl+a` action picker (show, edit, test, remove), `ctrl+n` create, `ctrl+i` install from GitHub (#342)
- **Skill install from GitHub** — `altimate-code skill install owner/repo` clones and installs skills; supports GitHub web URLs, shorthand, local paths, and `--global` flag (#342)
- **Skill cache invalidation** — `State.invalidate()` and `Skill.invalidate()` with `GET /skill?reload=true` endpoint for cross-thread cache clearing (#342)
- **Snowflake Cortex AI provider** — use Snowflake Cortex as an AI provider for LLM completions (#349)
- **Telemetry for skill operations** — `skill_created`, `skill_installed`, `skill_removed` events (#342)
- **E2E smoke tests** — committed tests for skill lifecycle, git-tracked protection, symlink safety, GitHub URL normalization (#363)

### Fixed

- Symlink traversal protection during skill install — uses `fs.lstat` to skip symlinks and prevent file disclosure from malicious repos (#342)
- Git-tracked skills cannot be removed via `skill remove` or TUI — prevents accidental deletion of repo-managed skills (#342)
- GitHub web URLs (e.g., `https://github.com/owner/repo/tree/main/path`) correctly normalized to clonable repo URLs (#342)
- `.git` suffix stripped from install source to prevent double-append (#342)
- TUI skill operations use `sdk.directory` + `gitRoot()` instead of `Instance`/`Global` which only exist in the worker thread (#342)
- TUI install uses async `Bun.spawn` instead of blocking `Bun.spawnSync` to keep UI responsive (#342)
- Missing `altimate_change` markers in `dialog-skill.tsx` and `skill.ts` (#341, #344)

## [0.5.5] - 2026-03-20

### Added

- Auto-discover MCP servers from external AI tool configs (VS Code, Cursor, GitHub Copilot, Claude Code, Gemini CLI, Claude Desktop) — discovered project-scoped servers are disabled by default and require explicit approval; home-directory configs are auto-enabled (#311)
- Security FAQ documentation for MCP auto-discovery — covers trust model, security hardening, and how to disable (#346)

### Changed

- `auto_mcp_discovery` now defaults to `true` in config schema via `z.boolean().default(true)` — matches existing runtime behavior (#345)

### Fixed

- Add missing `altimate_change` markers for `experimental` block in `opencode.jsonc` — fixes Marker Guard CI failure on main (#344)

## [0.5.4] - 2026-03-20

### Added

- Show update-available indicator in TUI footer — when a newer version is available, the footer displays `↑ version · altimate upgrade` with responsive layout for narrow terminals (#175)
- Track per-generation token usage in telemetry — emit `generation` event with flat token fields (`tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`) for Azure App Insights compatibility (#336)

### Fixed

- Replace `better-sqlite3` with `bun:sqlite` for schema cache and SQLite driver — fixes `schema_index`, `schema_search`, `schema_cache_status`, and SQLite driver for all users on the released CLI binary (#323)
- Fix marker guard diff parser bug — context lines now correctly update `altimate_change` marker state, preventing false negatives that allowed marker leaks to pass CI (#338)
- Extend marker guard CI to run on push-to-main with zero-SHA guard — closes the gap where individual PRs pass but combined state of `main` has missing markers (#338)
- Add `import.meta.main` guard to `analyze.ts` so test imports don't trigger CLI side effects (#338)
- Add 21 unit tests for marker diff parser and run them in CI (#338)

## [0.5.3] - 2026-03-19

### Fixed

- Bundle skills, dbt-tools, and altimate-setup in shipped npm binary — skills now work in all distribution channels (npm, Homebrew, AUR, Docker) without relying on `postinstall` filesystem copies (#316)
- Exclude 220MB of unused `.node` binaries from dbt-tools bundle (#320)
- Documentation about warehouse connections updated (#318)

### Changed

- Added `altimate_change` markers to upstream-shared files and marker removal detection to CI — prevents markers from being silently stripped (#322)

## [0.5.2] - 2026-03-19

### Added

- Trace history dialog (`/trace` command) — browse, search, and open past session traces from the TUI (#297)
- Docs showcase examples with screenshots (#292)

### Fixed

- TUI trace dialog now respects custom `tracing.dir` config — previously always used default directory (#307)
- WebFetch `clearTimeout` leak — DNS failures no longer leak timer handles (#307)
- WebFetch User-Agent strategy inverted to honest-bot-first — reduces 403 blocks from TLS fingerprint mismatch (#303)
- Snowflake SDK stdout log noise suppressed in TUI via `additionalLogToConsole: false` (#305, #301)
- `cleanTitle` fallback in trace dialog no longer returns empty string (#307)
- Error logging added to `openTraceInBrowser` for debuggability (#307)
- `altimate_change` markers added to `webfetch.ts` for upstream merge compatibility (#307)

### Changed

- Snowflake SDK minimum version bumped to `^2.0.3` for log suppression support (#305)
- Removed brew from docs and README (#299)
- Fixed README typo (`altimate` → `altimate-code`) (#293)

## [0.5.1] - 2026-03-19

### Added

- Simplified agent modes: 3 primary modes (`builder`, `analyst`, `plan`) replacing 7 — cleaner UX with focused roles (#282)
- SQL write access control — `builder` prompts for approval on write queries, `analyst` blocks them entirely, destructive SQL (`DROP DATABASE`, `TRUNCATE`) hard-blocked (#282)
- `core_failure` telemetry with PII-safe input signatures — captures tool failures with masked SQL literals and redacted secrets (#245)
- `peerDependencies` for database drivers in published npm packages (#273)
- Comprehensive docs restructuring with new Changelog, Getting Started, and Tools reference pages (#284)

### Fixed

- Replace `escapeSqlString` with parameterized query binds in `finops/schema` modules (#277)
- Driver error messages now suggest `npm install` instead of `bun add` (#273)
- System prompt traced only once per session to avoid duplication (#287)

### Changed

- Bump `@altimateai/altimate-core` to 0.2.5 — adds Rust-side failure telemetry with PII masking
- Removed 5 agent prompts: `executive`, `migrator`, `researcher`, `trainer`, `validator` (#282)
- README cleanup and updated branding (#288)

## [0.5.0] - 2026-03-18

### Added

- Smooth streaming mode for TUI response rendering (#281)
- Ship builtin skills to customers via `postinstall` (#279)
- `/configure-claude` and `/configure-codex` built-in commands (#235)

### Fixed

- Brew formula stuck at v0.3.1 — version normalization in publish pipeline (#286)
- Harden auth field handling for all warehouse drivers (#271)
- Suppress console logging that corrupts TUI display (#269)

## [0.4.9] - 2026-03-18

### Added

- Script to build and run compiled binary locally (#262)

### Fixed

- Snowflake auth — support all auth methods (`password`, `keypair`, `externalbrowser`, `oauth`), fix field name mismatches (#268)
- dbt tool regression — schema format mismatch, silent failures, wrong results (#263)
- `altimate-dbt compile`, `execute`, and children commands fail with runtime errors (#255)
- `Cannot find module @altimateai/altimate-core` on `npm install` (#259)
- Dispatcher tests fail in CI due to shared module state (#257)

### Changed

- CI: parallel per-target builds — 12 jobs, ~5 min wall clock instead of ~20 min (#254)
- CI: faster release — build parallel with test, lower compression, tighter timeouts (#251)
- Docker E2E tests skip in CI unless explicitly opted in (#253)

## [0.4.1] - 2026-03-16
## [0.4.2] - 2026-03-18

### Breaking Changes

- **Python engine eliminated** — all 73 tool methods now run natively in TypeScript. No Python, pip, venv, or `altimate-engine` installation required. Fixes #210.

### Added

- `@altimateai/drivers` shared workspace package with 10 database drivers (Snowflake, BigQuery, PostgreSQL, Databricks, Redshift, MySQL, SQL Server, Oracle, DuckDB, SQLite)
- Direct `@altimateai/altimate-core` napi-rs bindings — SQL analysis calls go straight to Rust (no Python intermediary)
- dbt-first SQL execution — automatically uses `profiles.yml` connection when in a dbt project
- Warehouse telemetry (5 event types: connect, query, introspection, discovery, census)
- 340+ new tests including E2E tests against live Snowflake, BigQuery, and Databricks accounts
- Encrypted key-pair auth support for Snowflake (PKCS8 PEM with passphrase)
- Comprehensive driver documentation at `docs/docs/drivers.md`

### Fixed

- Python bridge connection failures for UV, conda, and non-standard venv setups (#210)
- SQL injection in finops/schema queries (parameterized queries + escape utility)
- Credential store no longer saves plaintext passwords
- SSH tunnel cleanup on SIGINT/SIGTERM
- Race condition in connection registry for concurrent access
- Databricks DATE_SUB syntax
- Redshift describeTable column name
- SQL Server describeTable includes views
- Dispatcher telemetry wrapped in try/catch
- Flaky test timeouts

### Removed

- `packages/altimate-engine/` — entire Python package (~17,000 lines)
- `packages/opencode/src/altimate/bridge/` — JSON-RPC bridge
- `.github/workflows/publish-engine.yml` — PyPI publish workflow

### Added

- Local-first tracing system replacing Langfuse (#183)

### Fixed

- Engine not found when user's project has `.venv` in cwd — managed venv now takes priority (#199)
- Missing `[warehouses]` pip extra causing FinOps tools to fail with "snowflake-connector-python not installed" (#199)
- Engine install trusting stale manifest when venv/Python binary was deleted (#199)
- Extras changes not detected on upgrade — manifest now tracks installed extras (#199)
- Windows path handling for dev/cwd venv resolution (#199)
- Concurrent bridge startup race condition — added `pendingStart` mutex (#199)
- Unhandled spawn `error` event crashing host process on invalid Python path (#199)
- Bridge hung permanently after ping failure — child process now cleaned up (#199)
- `restartCount` incorrectly incremented on signal kills, prematurely disabling bridge (#199)
- TUI prompt corruption from engine bootstrap messages writing to stderr (#180)
- Tracing exporter timeout leaking timers (#191)
- Feedback submission failing when repo labels don't exist (#188)
- Pre-release security and resource cleanup fixes for tracing (#197)

## [0.4.0] - 2026-03-15

### Added

- Data-viz skill for data storytelling and visualizations (#170)
- AI Teammate training system with learn-by-example patterns (#148)

### Fixed

- Sidebar shows "OpenCode" instead of "Altimate Code" after upstream merge (#168)
- Prevent upstream tags from polluting origin (#165)
- Show welcome box on first CLI run, not during postinstall (#163)

### Changed

- Engine version bumped to 0.4.0

## [0.3.1] - 2026-03-15

### Fixed

- Database migration crash when upgrading from v0.2.x — backfill NULL migration names for Drizzle beta.16 compatibility (#161)
- Install banner not visible during `npm install` — moved output from stdout to stderr (#161)
- Verbose changelog dump removed from CLI startup (#161)
- `altimate upgrade` detection broken — `method()` and `latest()` referenced upstream `opencode-ai` package names instead of `@altimateai/altimate-code` (#161)
- Brew formula detection and upgrade referencing `opencode` instead of `altimate-code` (#161)
- Homebrew tap updated to v0.3.0 (was stuck at 0.1.4 due to expired `HOMEBREW_TAP_TOKEN`) (#161)
- `.opencode/memory/` references in docs updated to `.altimate-code/memory/` (#161)
- Stale `@opencode-ai/plugin` reference in CONTRIBUTING.md (#161)

### Changed

- CI now uses path-based change detection to skip unaffected jobs (saves ~100s on non-TS changes) (#161)
- Release workflow gated on test job passing (#157)
- Upstream merge restricted to published GitHub releases only (#150)

## [0.3.0] - 2026-03-15

### Added

- AI-powered prompt enhancement (#144)
- Altimate Memory — persistent cross-session memory with TTL, namespaces, citations, and audit logging (#136)
- Upstream merge with OpenCode v1.2.26 (#142)

### Fixed

- Sentry review findings from PR #144 (#147)
- OAuth token refresh retry and error handling for idle timeout (#133)
- Welcome banner on first CLI run after install/upgrade (#132)
- `@altimateai/altimate-code` npm package name restored after upstream rebase
- Replace `mock.module()` with `spyOn()` to fix 149 test failures (#153)

### Changed

- Rebrand user-facing references to Altimate Code (#134)
- Bump `@modelcontextprotocol/sdk` dependency (#139)
- Engine version bumped to 0.3.0

## [0.2.5] - 2026-03-13

### Added

- `/feedback` command and `feedback_submit` tool for in-app user feedback (#89)
- Datamate manager — dynamic MCP server management (#99)
- Non-interactive mode for `mcp add` command with input validation
- `mcp remove` command
- Upstream merge with OpenCode v1.2.20

### Fixed

- TUI crash after upstream merge (#98)
- `GitlabAuthPlugin` type incompatibility in plugin loader (#92)
- All test failures from fork restructure (#91)
- CI/CD workflow paths updated from `altimate-code` to `opencode`
- Fallback to global config when not in a git repo
- PR standards workflow `TEAM_MEMBERS` ref corrected from `dev` to `main` (#101)

### Changed

- Removed self-hosted runners from public repo CI (#110)
- Migrated CI/release to ARC runners (#93, #94)
- Reverted Windows tests to `windows-latest` (#95)
- Engine version bumped to 0.2.5

## [0.2.4] - 2026-03-04

### Added

- E2E tests for npm install pipeline: postinstall script, bin wrapper, and publish output (#50)

## [0.2.3] - 2026-03-04

### Added

- Postinstall welcome banner and changelog display after upgrade (#48)

### Fixed

- Security: validate well-known auth command type before execution, add confirmation prompt (#45)
- CI/CD: SHA-pin all GitHub Actions, per-job least-privilege permissions (#45)
- MCP: fix copy-paste log messages, log init errors, prefix floating promises (#45)
- Session compaction: clean up compactionAttempts on abort to prevent memory leak (#45)
- Telemetry: retry failed flush events once with buffer-size cap (#45, #46)
- Telemetry: flush events before process exit (#46)
- TUI: resolve worker startup crash from circular dependency (#47)
- CLI: define ALTIMATE_CLI build-time constants for correct version reporting (#41)
- Address 4 issues found in post-v0.2.2 commits (#49)
- Address remaining code review issues from PR #39 (#43)

### Changed

- CI/CD: optimize pipeline with caching and parallel builds (#42)

### Docs

- Add security FAQ (#44)

## [0.2.2] - 2026-03-05

### Fixed

- Telemetry init: `Config.get()` failure outside Instance context no longer silently disables telemetry
- Telemetry init: called early in CLI middleware and worker thread so MCP/engine/auth events are captured
- Telemetry init: promise deduplication prevents concurrent init race conditions
- Telemetry: pre-init events are now buffered and flushed (previously silently dropped)
- Telemetry: user email is SHA-256 hashed before sending (privacy)
- Telemetry: error message truncation standardized to 500 chars across all event types
- Telemetry: `ALTIMATE_TELEMETRY_DISABLED` env var now actually checked in init
- Telemetry: MCP disconnect reports correct transport type instead of hardcoded `stdio`
- Telemetry: `agent_outcome` now correctly reports `"error"` outcome for failed sessions

### Changed

- Auth telemetry events use session context when available instead of hardcoded `"cli"`

## [0.2.1] - 2026-03-05

### Added

- Comprehensive telemetry instrumentation: 25 event types across auth, MCP servers, Python engine, provider errors, permissions, upgrades, context utilization, agent outcomes, workflow sequencing, and environment census
- Telemetry docs page with event table, privacy policy, opt-out instructions, and contributor guide
- AppInsights endpoint added to network firewall documentation
- `categorizeToolName()` helper for tool classification (sql, schema, dbt, finops, warehouse, lineage, file, mcp)
- `bucketCount()` helper for privacy-safe count bucketing

### Fixed

- Command loading made resilient to MCP/Skill initialization failures

### Changed

- CLI binary renamed from `altimate-code` to `altimate`

## [0.2.0] - 2026-03-04

### Added

- Context management: auto-compaction with overflow recovery, observation masking, and loop protection
- Context management: data-engineering-aware compaction template preserving warehouse, schema, dbt, and lineage context
- Context management: content-aware token estimation (code, JSON, SQL, text heuristics)
- Context management: observation masking replaces pruned tool outputs with fingerprinted summaries
- Context management: provider overflow detection for Azure OpenAI patterns
- CLI observability: telemetry module with session, generation, tool call, and error tracking
- `/discover` command for data stack setup with project_scan tool
- User documentation for context management configuration

### Fixed

- ContextOverflowError now triggers automatic compaction instead of a dead-end error
- `isOverflow()` correctly reserves headroom for models with separate input/output limits
- `NamedError.isInstance()` no longer crashes on null input
- Text part duration tracking now preserves original start timestamp
- Compaction loop protection: max 3 consecutive attempts per turn, counter resets between turns
- Negative usable context guard for models where headroom exceeds base capacity

### Changed

- Removed cost estimation and complexity scoring bindings
- Docs: redesigned homepage with hero, feature cards, and pill layouts
- Docs: reorganized sidebar navigation for better discoverability

## [0.1.10] - 2026-03-03

### Fixed

- Build: resolve @opentui/core parser.worker.js via import.meta.resolve for monorepo hoisting
- Build: output binary as `altimate-code` instead of `opencode`
- Publish: update Docker/AUR/Homebrew references from anomalyco/opencode to AltimateAI/altimate-code
- Publish: make Docker/AUR/Homebrew steps non-fatal
- Bin wrapper: look for `@altimateai/altimate-code-*` scoped platform packages
- Postinstall: resolve `@altimateai` scoped platform packages
- Dockerfile: update binary paths and names

## [0.1.9] - 2026-03-02

### Fixed

- Build: fix solid-plugin import to use bare specifier for monorepo hoisting
- CI: install warehouse extras for Python tests (duckdb, boto3, etc.)
- CI: restrict pytest collection to tests/ directory
- CI: fix all ruff lint errors in Python engine
- CI: fix remaining TypeScript test failures (agent rename, config URLs, Pydantic model)
- Update theme schema URLs and documentation references to altimate-code.dev

## [0.1.8] - 2026-03-02

### Changed

- Rename npm scope from `@altimate` to `@altimateai` for all packages
- Wrapper package is now `@altimateai/altimate-code` (no `-ai` suffix)

### Fixed

- CI: test fixture writes config to correct filename (`altimate-code.json`)
- CI: add `dev` optional dependency group to Python engine for pytest/ruff

## [0.1.7] - 2026-03-02

### Changed

- Improve TUI logo readability: redesign M, E, T, I letter shapes
- Add two-tone logo color: ALTIMATE in peach, CODE in purple

### Fixed

- Release: npm publish glob now finds scoped package directories
- Release: PyPI publish skips existing versions instead of failing

## [0.1.5] - 2026-03-02

### Added

- Anthropic OAuth plugin ported in-tree
- Docs site switched from Jekyll to Material for MkDocs

### Fixed

- Build script: restore `.trim()` on models API JSON to prevent syntax error in generated `models-snapshot.ts`
- Build script: fix archive path for scoped package names in release tarball/zip creation

## [0.1.0] - 2025-06-01

### Added

- Initial open-source release
- SQL analysis and formatting via Python engine
- Column-level lineage tracking
- dbt integration (profiles, lineage, `+` operator)
- Warehouse connectivity (Snowflake, BigQuery, Databricks, Postgres, DuckDB, MySQL)
- AI-powered SQL code review
- TUI interface with Solid.js
- MCP (Model Context Protocol) server support
- Auto-bootstrapping Python engine via uv
