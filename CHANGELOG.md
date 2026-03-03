# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
