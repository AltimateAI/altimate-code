# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.8] - 2026-03-23

### Fixed

- **dbt commands crash with `SyntaxError: Cannot use import statement`** — bundled `dbt-tools/` was missing `package.json` with `"type": "module"`, causing Node to default to CJS and reject ESM imports. Broken since v0.5.3. (#407)
- **Publish script idempotency** — re-running `publish.ts` without cleaning `dist/` would crash because the synthesized `dbt-tools/package.json` (no `name`/`version`) polluted the binary glob scan (#407)
- **Skill builder `ctrl+i` keybind** — ESC navigation and dialog lifecycle fixes in TUI skill management (#386)
- **Upgrade notification silently skipped** — multiple scenarios where the upgrade check was bypassed (#389)
- **Phantom `sql_validate` tool** — removed non-existent tool reference from analyst agent permissions, replaced with `altimate_core_validate` (#352)
- **CI test suite stability** — eliminated 29 pre-existing test failures: added `duckdb` devDependency, fixed native binding contention with retry logic and `beforeAll` connections, increased timeouts for slow bootstrap operations, added `--timeout 30000` to CI workflow (#411)

### Added

- **Recap (renamed from Tracer)** — session recap with loop detection and enhanced viewer (#381)
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
