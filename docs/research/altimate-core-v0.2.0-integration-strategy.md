# Altimate-Core v0.2.0 Integration Strategy for Altimate Code

**Date:** 2026-03-11
**Status:** Research Complete — Ready for Implementation Planning

---

## Executive Summary

altimate-core v0.2.0 introduces three headline capabilities: **lineage depth tiering**, **diff-aware lineage**, and **compact CLI output**. Combined with unreleased features on `main` (`analyze_tags()`, `reladiff` data validation), these changes unlock significant competitive advantages for Altimate Code as a data engineering agent.

This document maps every new capability to specific integration points in Altimate Code, identifies gaps in altimate-core-internal we should fill, and positions the work against the competitive landscape (Databao, dbt Copilot, SQLMesh, Paradime).

**Key finding:** The single biggest market opportunity is **free column-level lineage with diff-awareness** — dbt charges $500/user/month for CLL that runs on open-source SQLGlot. We can offer better CLL (Rust-powered, 34 dialects, diff-aware) at zero cost.

---

## Part 1: What Changed in altimate-core v0.2.0

### 1.1 Lineage Depth Tiering (NEW)

Three tiers for `column_lineage()`:

| Tier | What's Included | Token Cost | Use Case |
|------|----------------|-----------|----------|
| `basic` | `column_dict` + `source_tables` only | ~50 tokens | Agent tool calls, quick checks |
| `deep` | + `column_lineage` edges with lens metadata (`lens_type`, `lens_code`) | ~200 tokens | Impact analysis, transformation chain |
| `full` | + indirect edges, errors, full diagnostic | ~500+ tokens | Deep debugging, compliance audits |

**Python API:** `altimate_core.column_lineage(sql, depth="basic"|"deep"|"full")`

**Why this matters for Altimate Code:** Our agents burn context on lineage results. `basic` tier reduces lineage output by ~10x, critical for long sessions with many SQL queries. The `deep` tier's `lens_type`/`lens_code` tells the agent exactly how each column is transformed (direct copy, aggregation, expression, conditional, etc.) — enabling intelligent impact analysis.

### 1.2 Diff-Aware Lineage (NEW)

New `diff_lineage()` function comparing before/after SQL:

```python
result = altimate_core.diff_lineage(
    before_sql, after_sql,
    dialect="snowflake",
    schema=schema,
    depth="full"
)
```

Returns: `added_columns`, `removed_columns`, `modified_columns`, `affected_downstream`, `before`, `after`.

**Why this matters:** This is the foundation for **impact analysis** — the #1 requested feature across data engineering teams. When a user modifies a dbt model's SQL, we can instantly show what columns changed, what downstream models are affected, and what the transformation chain looks like — all without hitting the database.

### 1.3 Compact CLI Output (Breaking Change)

New default output format for CLI. Previous verbose text replaced with compact format. `--human-mode` flag for old behavior.

**Impact on Altimate Code:** Minimal — we use the Python bindings, not the CLI. But if any tools shell out to `altimate-core` CLI, they need `--human-mode` or `--format json`.

### 1.4 Bug Fixes

- **`source_tables` was always empty** — now correctly populated from `column_dict` source refs
- **`diff_lineage` false positives** — WHERE-only or JOIN-type changes no longer falsely report column modifications
- **Malformed schema handling** — garbage files now error instead of silently parsing as YAML string
- **CLL no longer requires `init()`** — works purely locally without API keys. `init()` only adds telemetry.

### 1.5 Unreleased on `main` (Not Yet Tagged)

- **`analyze_tags()`** — SQL anti-pattern tagging: `select_star`, `filter_has_func`, `join_has_func`, `agg_before_join`, `select_without_limit`, `create_or_replace_table`
- **`reladiff` module** — Deterministic table-to-table data validation via cooperative state machines. Algorithms: JoinDiff (same DB), HashDiff (cross-DB), Profile (column stats), Cascade (progressive). Database-agnostic: Rust engine emits SQL, never connects.
- **15,445+ test cases** across 34 dialects (up from ~986)

---

## Part 2: Integration Map — How Each Feature Improves Altimate Code

### 2.1 Lineage Depth Tiering → Smarter Agent Context Management

**Current state:** `lineage.check` and `altimate_core.column_lineage` always return full lineage. On complex queries, this can be 500+ tokens of lineage data per tool call.

**Integration plan:**

| Layer | File | Change |
|-------|------|--------|
| Python wrapper | `guard.py` | Add `depth` parameter to `guard_column_lineage()` |
| RPC dispatch | `server.py` | Pass `depth` to `altimate_core.column_lineage()` |
| Pydantic models | `models.py` | Add `depth: Literal["basic", "deep", "full"]` to params |
| TS protocol | `protocol.ts` | Add `depth` field to `AltimateCoreColumnLineageParams` |
| TS tools | `column-lineage.ts` | Default to `basic` for inline checks, `deep` for explicit requests |
| Agent prompts | `builder.txt`, `analyst.txt` | Instruct agents to use `basic` for exploration, `deep` for impact analysis |

**Impact by agent:**
- **Builder:** Uses `basic` during model development (just needs column mapping). Switches to `deep` when self-reviewing changes.
- **Analyst:** Uses `deep` by default (needs transformation chains for explaining data flow).
- **Validator:** Uses `full` for compliance audits and debugging.
- **Migrator:** Uses `deep` to verify column mapping is preserved across dialect translation.

**Context savings:** ~70% reduction in lineage token usage during typical sessions.

### 2.2 Diff-Aware Lineage → Impact Analysis Skill

**Current state:** No impact analysis capability. Users manually compare SQL versions.

**Integration plan:**

| Layer | File | Change |
|-------|------|--------|
| Python wrapper | `guard.py` | New `guard_diff_lineage()` function |
| RPC dispatch | `server.py` | New `altimate_core.diff_lineage` method |
| Pydantic models | `models.py` | New `AltimateCoreLinageDiffParams` / `Result` |
| TS protocol | `protocol.ts` | New RPC method + types |
| TS tool | `tools/diff-lineage.ts` | New tool: `sql_diff_lineage` |
| Skill | `skills/impact-analysis.ts` | **New skill**: chains git diff → diff_lineage → downstream lookup |

**The Impact Analysis Skill workflow:**
1. User modifies a dbt model SQL file
2. Skill reads git diff to get before/after SQL
3. Calls `diff_lineage(before, after)` to get column-level changes
4. Uses dbt manifest to find downstream models
5. For each downstream model, checks if affected columns are referenced
6. Reports: "Changing `revenue` calculation in `stg_orders` affects 3 downstream models: `mart_revenue`, `mart_kpis`, `report_monthly`"

**This is the #1 feature gap in the market.** dbt Enterprise charges $500/user for CLL. No tool offers free diff-aware CLL with downstream impact analysis.

### 2.3 `analyze_tags()` → SQL Quality Gates

**Current state:** SQL anti-pattern detection happens via LLM analysis (expensive, slow, inconsistent).

**Integration plan:**

| Layer | File | Change |
|-------|------|--------|
| Python wrapper | `guard.py` | New `guard_analyze_tags()` function |
| RPC dispatch | `server.py` | New `altimate_core.analyze_tags` method |
| TS tool | `tools/analyze-tags.ts` | New tool: `sql_analyze_tags` |
| Agent prompts | `builder.txt` | Use as pre-flight check before `dbt run` |

**Tags detected (Rust-native, ~1ms per query):**
- `select_star` — SELECT * in production models
- `filter_has_func` — Functions in WHERE clauses preventing index usage
- `join_has_func` — Functions in JOIN conditions
- `agg_before_join` — Aggregation before join (potential performance issue)
- `select_without_limit` — Unbounded SELECT on large tables
- `create_or_replace_table` — Destructive DDL

**Value:** Instant, deterministic quality gates. No LLM needed. Sub-millisecond. Can run on every SQL file in a dbt project in <1 second total.

### 2.4 `reladiff` → Data Validation Skill

**Current state:** No cross-database or same-database data comparison capability.

**Integration plan:** This is significant enough to warrant a new skill.

**The Data Validation Skill workflow:**
1. User asks "compare staging vs production" or "validate this migration"
2. Skill generates comparison SQL using reladiff algorithms
3. Executes SQL against warehouse(s)
4. Reports differences: row counts, column mismatches, value diffs
5. For cross-DB: uses HashDiff algorithm (hash rows locally, compare)

**Algorithms available:**
- **JoinDiff**: Same database, full row-level comparison via SQL JOIN
- **HashDiff**: Cross-database, hash-based comparison (works across Snowflake → BigQuery, etc.)
- **Profile**: Column-level statistics comparison (min/max/avg/null count/distinct count)
- **Cascade**: Progressive — starts with Profile, escalates to JoinDiff only for suspicious columns

**Use cases across warehouses:**

| Scenario | Algorithm | Warehouses |
|----------|-----------|-----------|
| dbt model refactor validation | JoinDiff | Any single warehouse |
| Cloud migration (Redshift → Snowflake) | HashDiff | Cross-warehouse |
| Schema evolution safety check | Profile | Any |
| Production vs staging comparison | JoinDiff or Profile | Any |
| ETL pipeline validation | Cascade | Any |

### 2.5 `source_tables` Fix → Better Explore-First Workflow

**Current state:** `source_tables` was always empty, so lineage results couldn't tell the agent which tables a query touches without parsing the full edge list.

**With fix:** `source_tables` is now populated. This means:
- Builder agent can quickly check "does this query reference tables I expect?"
- Analyst agent can list all tables involved in a query without full lineage traversal
- Context pruning can use `source_tables` to fetch only relevant schema information

### 2.6 CLL Without `init()` → Zero-Config Lineage

**Current state:** `guard_column_lineage()` calls `_ensure_init()` which reads `~/.altimate/altimate.json` for API key. Fails silently if no config file.

**With fix:** CLL works purely locally without any configuration. This means:
- **Zero-friction onboarding** — new users get CLL immediately, no API key needed
- **Offline support** — CLL works without internet
- **Privacy** — no telemetry unless explicitly opted in via `init()`

**Integration change:** Remove the `_ensure_init()` guard from `guard_column_lineage()`. Update onboarding flow to not require API key for basic functionality.

---

## Part 3: Cross-Stack Impact Matrix

How these changes benefit users across different data stacks:

### 3.1 By Warehouse

| Warehouse | Depth Tiering | Diff Lineage | analyze_tags | reladiff | Notes |
|-----------|:---:|:---:|:---:|:---:|-------|
| **Snowflake** | ✅ | ✅ | ✅ | ✅ | Primary target. Semi-structured (`col:path::type`) has known CLL gaps. |
| **BigQuery** | ✅ | ✅ | ✅ | ✅ | STRUCT access and pipe syntax need attention. |
| **Databricks** | ✅ | ✅ | ✅ | ✅ | Spark SQL dialect. Unity Catalog integration opportunity. |
| **PostgreSQL** | ✅ | ✅ | ✅ | ✅ | Strong dialect support. PostGIS extensions tested. |
| **Redshift** | ✅ | ✅ | ✅ | ✅ | Good coverage. DISTKEY/SORTKEY not in CLL. |
| **DuckDB** | ✅ | ✅ | ✅ | ✅ | Struct path notation has known CLL gaps. |
| **MySQL** | ✅ | ✅ | ✅ | ✅ | Standard support. |
| **SQL Server** | ✅ | ✅ | ✅ | ✅ | T-SQL dialect. PIVOT/UNPIVOT have CLL gaps. |
| **Oracle** | ⚠️ | ⚠️ | ✅ | ✅ | Connector missing in altimate-engine. CLL has KEEP/XMLAGG gaps. |
| **Trino** | ✅ | ✅ | ✅ | ✅ | Good polyglot-sql support. |
| **ClickHouse** | ✅ | ✅ | ✅ | ⚠️ | Parser tested, but no connector in altimate-engine. |
| **SQLite** | ✅ | ✅ | ✅ | ✅ | Used for local/testing scenarios. |

### 3.2 By Data Stack Pattern

| Stack | Key Integration Point | Primary Agent | Tools Used |
|-------|----------------------|---------------|-----------|
| **dbt + Snowflake** | Diff lineage on model changes, impact analysis via manifest | Builder, Validator | `diff_lineage`, `analyze_tags`, `column_lineage(basic)` |
| **dbt + BigQuery** | Same as above, plus cost estimation integration | Builder, Analyst | Same + BigQuery cost metadata |
| **dbt + Databricks** | Unity Catalog schema discovery + CLL | Builder | `column_lineage(deep)`, schema inspect |
| **Airflow + Any Warehouse** | Pipeline-level lineage tracking across tasks | Analyst | `track_lineage`, `analyze_tags` |
| **SQLMesh + Any** | Complementary CLL (SQLMesh uses SQLGlot; we add depth tiering) | Builder | `column_lineage(deep)`, `diff_lineage` |
| **Standalone SQL** | Direct SQL optimization and validation | Analyst | All analysis tools |
| **Migration (X → Y)** | Cross-dialect transpilation + data validation | Migrator | `transpile`, `diff_lineage`, `reladiff` |

### 3.3 By Persona

| Persona | Top v0.2.0 Benefit | Secondary Benefits |
|---------|-------------------|-------------------|
| **Analytics Engineer** | Free CLL (vs $500/user dbt Enterprise) | Impact analysis, auto-docs, test gen |
| **Data Engineer** | diff-aware lineage for pipeline changes | Anti-pattern detection, data validation |
| **Data Platform Engineer** | Cross-warehouse validation via reladiff | Schema diff, migration analysis |
| **Data Analyst** | `basic` depth lineage for quick exploration | SQL optimization, transpilation |
| **Compliance/Governance** | `full` depth lineage + PII detection | Policy checking, audit trails |

---

## Part 4: Competitive Positioning

### 4.1 vs. Databao Agent (JetBrains) — Spider 2.0-DBT #1

Databao won Spider 2.0-DBT with 44.11% by:
1. **Tool discipline** — restricted tool set
2. **Clear workflow** — inspect → change → verify → declare
3. **Safety guards** — never touch tables outside project
4. **Context engine** — pre-computed semantic context

**Altimate Code advantages:**
- We already have tool discipline + validation workflow (42.65% product-only score)
- Our Rust-powered CLL is faster and supports more dialects than their SQLAlchemy-based approach
- We have diff-aware lineage — Databao doesn't
- We have 37+ guard functions — Databao has basic SQL execution only

**Gap to close:** Databao's context engine pre-computes and caches semantic context. We should leverage `optimize_context` + `schema_fingerprint` more aggressively for the same effect.

### 4.2 vs. dbt Copilot ($500/user/month)

| Capability | dbt Copilot | Altimate Code (with v0.2.0) |
|-----------|-------------|---------------------------|
| Column-level lineage | Enterprise only ($500/user) | Free, Rust-powered, 34 dialects |
| Diff-aware lineage | No | Yes |
| Impact analysis | Column-level in Explorer | Column-level + downstream tracing |
| Test generation | Yes (Enterprise) | Yes (via `generate_tests`) |
| SQL anti-pattern detection | No | Yes (via `analyze_tags`, ~1ms) |
| Multi-warehouse | Limited | 10+ warehouses |
| Data validation | No | Yes (via reladiff) |
| Local/offline | No (cloud only) | Yes |
| Price | $500/user/month | Free / open-source |

### 4.3 vs. SQLMesh

SQLMesh offers free CLL via SQLGlot. Our differentiators:
- **Depth tiering** — SQLMesh always returns full lineage
- **Diff-aware lineage** — SQLMesh doesn't have before/after comparison
- **34 dialects** vs SQLGlot's ~20
- **Rust performance** — ~2ms validation vs Python-speed SQLGlot
- **Agent integration** — SQLMesh is a framework, we're an agent

### 4.4 vs. Paradime DinoAI ($25-55/user/month)

Paradime is the budget alternative to dbt Copilot. Our advantages:
- Free, open-source, local-first
- Diff-aware lineage (Paradime doesn't have it)
- Multi-warehouse (Paradime is Snowflake-focused)
- Agent-based (autonomous workflows vs copilot-style suggestions)

---

## Part 5: Gaps in altimate-core-internal We Should Fill

Based on this analysis, here are gaps in altimate-core-internal that would make Altimate Code significantly better:

### 5.1 High Priority

| Gap | Description | Impact | Effort |
|-----|-------------|--------|--------|
| **Jinja2 preprocessing** | CLL fails on dbt Jinja templates. Need a Jinja2 → SQL preprocessor before analysis. | Critical for dbt users. Every competitor struggles with this. | Medium — Python Jinja2 rendering before passing to Rust. |
| **View definition resolution** | CLL can't trace through views without view SQL. Need API to accept view definitions alongside schema. | Fixes ~2.5% of CLL failures (wrong source tables). | Medium — schema extension. |
| **Snowflake semi-structured CLL** | `col:path::type` access not fully traced in lineage. | Affects ~1.3% of Snowflake queries. Important for JSON-heavy workloads. | Medium — polyglot-sql parser change. |
| **PIVOT/UNPIVOT CLL** | Parse errors for PIVOT/UNPIVOT syntax in lineage. | Common in reporting queries. | Medium — parser + complete.rs change. |
| **Oracle connector** | Referenced in deps but no implementation in altimate-engine. | Blocks Oracle users entirely. | Low — standard DB connector. |

### 5.2 Medium Priority

| Gap | Description | Impact | Effort |
|-----|-------------|--------|--------|
| **Batch lineage API** | `column_lineage` is per-query. Need batch API for analyzing entire dbt projects. | Performance: 100 models × 2ms = 200ms batch vs 100 × overhead of individual calls. | Low — Python wrapper change. |
| **Lineage graph output** | Returns flat edge lists. Need optional graph/DAG format (adjacency list, DOT, Mermaid). | UX: visual lineage in terminal or markdown. | Low — post-processing in Python. |
| **Schema caching** | Each lineage call recomputes schema. Need session-level schema cache with fingerprint invalidation. | Performance for multi-query sessions. | Low — Python wrapper using `schema_fingerprint`. |
| **CTE-depth lineage** | Loses resolution at CTE depth >3-4. | Affects complex dbt models with deep CTEs. | High — `complete.rs` algorithm. |
| **UNION branch supplementation** | NULL in first UNION branch loses column tracking. | ~0.5% of queries affected. | Medium — `complete.rs`. |

### 5.3 Strategic (Future)

| Gap | Description | Impact |
|-----|-------------|--------|
| **BI tool lineage** | Extend lineage to Looker LookML, Tableau calculations, Power BI DAX. | Cross-tool lineage is the holy grail. |
| **Incremental lineage** | Session-level lineage accumulation across multiple tool calls. | Agent can build up lineage graph over a conversation. |
| **Cost model integration** | Estimate query cost from lineage + table statistics. | Combine CLL with warehouse cost modeling. |
| **Semantic layer integration** | Parse dbt metrics/semantic layer definitions. | Bridge between physical and business-level lineage. |

---

## Part 6: Implementation Roadmap

### Phase 1: Core v0.2.0 Integration (1-2 weeks)

1. **Bump altimate-core to >=0.2.0** in `pyproject.toml`
2. **Add `depth` parameter** to `guard_column_lineage()` → RPC → TS protocol → tool
3. **Add `guard_diff_lineage()`** → RPC → TS protocol → new tool
4. **Remove `_ensure_init()` from CLL** path (CLL works without API key now)
5. **Fix `source_tables` usage** in agent prompts (it now works!)
6. **Update agent prompts** to use `basic` lineage by default, `deep` on demand

### Phase 2: New Skills & Tools (2-3 weeks)

7. **Impact Analysis Skill** — chains git diff → diff_lineage → dbt manifest → downstream report
8. **SQL Quality Gate** — integrate `analyze_tags()` as pre-flight check
9. **Data Validation Skill** — expose reladiff algorithms via new RPC methods
10. **Batch lineage wrapper** — Python-side batching for dbt project analysis

### Phase 3: Competitive Edge (3-4 weeks)

11. **Jinja2 preprocessing** — render Jinja2 templates before CLL analysis
12. **Lineage visualization** — Mermaid/DOT output for terminal display
13. **Schema caching** — fingerprint-based cache for multi-query sessions
14. **Oracle connector** — complete warehouse coverage

### Phase 4: Market Differentiation (Ongoing)

15. **Context engine** (à la Databao) — pre-compute and cache semantic context
16. **Cross-tool lineage** — BI tool integration
17. **Incremental lineage** — session-level graph accumulation

---

## Part 7: Market Context & Validation

### Industry Signals

- **60% of organizations** rank data analysis as their most impactful AI agent application (Anthropic 2026 State of AI Agents)
- **Data quality market** projected to hit $30.5B by 2026
- **Databricks growing 57% YoY**, Snowflake at 27% — multi-warehouse support is non-negotiable
- **80-90% of AI agent projects fail** in production (RAND 2025) — reliability and discipline matter more than feature count
- **dbt Enterprise at $500/user/month** creates massive pricing umbrella for free alternatives

### Reddit/Community Signals

- Top frustration: agents that forget everything between sessions → our continuation session feature addresses this
- Top request: free column-level lineage for dbt Core → v0.2.0 enables this
- Top complaint: AI tools fail on Jinja2 templates → identified as gap to fill
- Top desire: tools that work locally without cloud dependency → our architecture is local-first

### Databao's Playbook (What We Should Learn)

JetBrains' #1 Spider 2.0-DBT approach validates our architecture:
1. ✅ We already have tool discipline (restricted tool sets per agent)
2. ✅ We already have validation workflows (explore → build → validate)
3. ✅ We already have safety guards (read-before-write, SQL safety scanning)
4. 🔲 We need better pre-computed context (their context engine approach)
5. 🔲 We need stricter file editing constraints for benchmark scenarios

---

## Appendix A: Complete altimate-core v0.2.0 Python API

| Function | Category | New in v0.2.0 | Notes |
|----------|----------|:---:|-------|
| `column_lineage(sql, depth=...)` | Lineage | `depth` param | Three tiers: basic/deep/full |
| `diff_lineage(before, after, ...)` | Lineage | ✅ NEW | Before/after SQL comparison |
| `track_lineage(queries, ...)` | Lineage | | Multi-query lineage |
| `validate(sql, schema)` | Validation | | ~2ms validation |
| `explain(sql, schema)` | Analysis | | Query plan + lineage |
| `fix(sql, schema)` | Transform | | Auto-fix with fuzzy matching |
| `check_policy(sql, policy)` | Governance | | Policy guardrails |
| `check_semantics(sql, schema)` | Validation | | 10 semantic rules |
| `generate_tests(sql, schema)` | Testing | | Auto test generation |
| `check_equivalence(sql1, sql2)` | Analysis | | Semantic equivalence |
| `analyze_migration(old, new)` | Migration | | DDL migration safety |
| `diff_schemas(s1, s2)` | Schema | | Breaking change detection |
| `rewrite(sql, schema)` | Transform | | Query optimization |
| `correct(sql, schema)` | Transform | | Propose-verify-refine |
| `evaluate(sql, schema)` | Analysis | | A-F quality grading |
| `classify_pii(schema)` | Governance | | PII classification |
| `check_query_pii(sql, schema)` | Governance | | Query-level PII |
| `resolve_term(term, schema)` | Semantic | | Fuzzy business term |
| `format_sql(sql, dialect)` | Transform | | Rust-powered formatting |
| `extract_metadata(sql)` | Analysis | | Tables, columns, CTEs |
| `compare_queries(l, r)` | Analysis | | Structural comparison |
| `complete(sql, pos, schema)` | IDE | | Cursor-aware completion |
| `optimize_context(schema)` | Context | | 5-level progressive disclosure |
| `optimize_for_query(sql, schema)` | Context | | Query-aware schema reduction |
| `prune_schema(sql, schema)` | Context | | Referenced tables only |
| `import_ddl(ddl, dialect)` | Schema | | Parse DDL to schema |
| `export_ddl(schema)` | Schema | | Schema to CREATE TABLE |
| `schema_fingerprint(schema)` | Schema | | SHA-256 for caching |
| `introspection_sql(db, schema)` | Schema | | INFORMATION_SCHEMA queries |
| `parse_dbt_project(dir)` | dbt | | Parse dbt project |
| `is_safe(sql)` | Safety | | Quick boolean check |
| `lint(sql, schema)` | Quality | | Lint findings |
| `scan_sql(sql)` | Safety | | Security threats |
| `transpile(sql, from, to)` | Transform | | Dialect translation |
| `analyze_tags(sql)` | Quality | ✅ (unreleased) | Anti-pattern detection |
| `init(api_key)` | SDK | | Optional telemetry |

## Appendix B: Files to Modify for Integration

| File | Changes Needed |
|------|---------------|
| `packages/altimate-engine/pyproject.toml` | Bump `altimate-core>=0.2.0` |
| `packages/altimate-engine/src/altimate_engine/sql/guard.py` | Add `depth` param to `guard_column_lineage()`, new `guard_diff_lineage()`, new `guard_analyze_tags()`, remove `_ensure_init()` from CLL |
| `packages/altimate-engine/src/altimate_engine/server.py` | New RPC methods: `altimate_core.diff_lineage`, `altimate_core.analyze_tags` |
| `packages/altimate-engine/src/altimate_engine/models.py` | New Pydantic models for diff_lineage and analyze_tags params/results |
| `packages/opencode/src/altimate/bridge/protocol.ts` | New TS types + method registry entries |
| `packages/opencode/src/altimate/tools/diff-lineage.ts` | New tool |
| `packages/opencode/src/altimate/tools/analyze-tags.ts` | New tool |
| `packages/opencode/src/tool/registry.ts` | Register new tools |
| `packages/opencode/src/altimate/prompts/builder.txt` | Use `basic` lineage, `analyze_tags` pre-flight |
| `packages/opencode/src/altimate/prompts/analyst.txt` | Use `deep` lineage by default |
| `packages/opencode/src/altimate/prompts/validator.txt` | Use `full` lineage, `analyze_tags` in validation |

## Appendix C: Sources

### altimate-core-internal
- GitHub tags: v0.1.0 through v0.2.0
- PR #60: Lineage depth tiering, diff-aware lineage, compact CLI output
- PR #48: Binary consolidation (-10,094 lines)
- PR #62: `analyze_tags()` Python binding
- PR #61: reladiff module
- PRs #67-#94: 15,445+ test cases across 34 dialects

### Industry Research
- [Anthropic 2026 State of AI Agents Report](https://www.anthropic.com)
- [dbt Copilot GA Announcement](https://www.getdbt.com/blog/dbt-copilot-is-ga)
- [dbt Agent Skills](https://docs.getdbt.com/blog/dbt-agent-skills)
- [How Databao Ranked #1 Spider 2.0-DBT](https://blog.jetbrains.com/databao/2026/02/how-databao-agent-ranked-1-spider-2-0-dbt/)
- [Databao Context Engine](https://github.com/JetBrains/databao-context-engine)
- [Cloud Data Warehouse Market Share](https://www.firebolt.io/blog/cloud-data-warehouse-market-share-breakdown)
- [Gartner Data Lineage 2026](https://atlan.com/gartner-data-lineage/)
- [2026 Open-Source Data Quality Landscape](https://datakitchen.io/the-2026-open-source-data-quality-and-data-observability-landscape/)
- [SQLGlot Column Lineage](https://medium.com/@toby.mao/yes-sqlglot-supports-column-level-lineage-9d141fa8d4a1)
- [dbt Column-Level Lineage Docs](https://docs.getdbt.com/docs/explore/column-level-lineage)
- [RAND 2025 AI Agent Failure Rates](https://www.rand.org)
- Reddit r/dataengineering, r/analytics community discussions
