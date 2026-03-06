# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
