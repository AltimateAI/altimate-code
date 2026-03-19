# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
