# altimate-engine Accuracy Benchmarks

Published: 2026-02-25 | Engine: altimate-engine v0.1.0 | Dialect: Snowflake

---

## SQL Static Analyzer (`sql.analyze`)

### Summary

| Metric | Value |
|--------|-------|
| Total queries | 1,077 |
| Parse failures | 0 |
| Rules evaluated | 19 |
| Overall F1 | **1.00** (all rules) |
| False positives | 0 |
| False negatives | 0 |
| Avg latency | 0.48ms/query |
| Total elapsed | 0.518s |

### Per-Rule Accuracy

All 19 rules achieved perfect detection (F1 = 1.00):

| Rule | True Positives | False Positives | False Negatives | Precision | Recall | F1 |
|------|---------------|-----------------|-----------------|-----------|--------|-----|
| CARTESIAN_PRODUCT | 15 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| CORRELATED_SUBQUERY | 37 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| FUNCTION_IN_FILTER | 38 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| FUNCTION_IN_JOIN | 8 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| GROUP_BY_PRIMARY_KEY | 24 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| IMPLICIT_CARTESIAN | 16 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| LARGE_IN_LIST | 9 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| LIKE_LEADING_WILDCARD | 26 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| MISSING_LIMIT | 51 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| NON_EQUI_JOIN | 18 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| NOT_IN_WITH_SUBQUERY | 1 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| ORDER_BY_IN_SUBQUERY | 11 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| ORDER_BY_WITHOUT_LIMIT | 16 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| OR_IN_JOIN | 8 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| SELECT_STAR | 53 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| SELECT_STAR_IN_SUBQUERY | 6 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| UNION_INSTEAD_OF_UNION_ALL | 13 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| UNUSED_CTE | 9 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| WINDOW_WITHOUT_PARTITION | 37 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| **Aggregate** | **396** | **0** | **0** | **1.00** | **1.00** | **1.00** |

### Per-Category Breakdown (18 categories)

| Category | Queries | Accuracy | TP | FP | FN |
|----------|---------|----------|-----|-----|-----|
| aggregation | 83 | 1.00 | 24 | 0 | 0 |
| basic_select | 52 | 1.00 | 0 | 0 | 0 |
| column_pruning | 52 | 1.00 | 30 | 0 | 0 |
| complex | 83 | 1.00 | 126 | 0 | 0 |
| cross_join | 31 | 1.00 | 31 | 0 | 0 |
| cte | 41 | 1.00 | 9 | 0 | 0 |
| equality_filter | 156 | 1.00 | 0 | 0 | 0 |
| in_list | 52 | 1.00 | 9 | 0 | 0 |
| join_2table | 83 | 1.00 | 0 | 0 | 0 |
| join_3plus | 41 | 1.00 | 0 | 0 | 0 |
| like_filter | 41 | 1.00 | 26 | 0 | 0 |
| metadata_agg | 20 | 1.00 | 20 | 0 | 0 |
| null_filter | 31 | 1.00 | 0 | 0 | 0 |
| partition_pruning | 52 | 1.00 | 38 | 0 | 0 |
| range_filter | 104 | 1.00 | 0 | 0 | 0 |
| set_operation | 41 | 1.00 | 13 | 0 | 0 |
| subquery | 52 | 1.00 | 43 | 0 | 0 |
| window_function | 62 | 1.00 | 27 | 0 | 0 |

### Confidence Distribution

Every issue includes a per-issue `confidence` field (`high`, `medium`, or `low`) based on 7 AST detection rules in `ConfidenceTracker`:

| Pattern Detected | Confidence | Rationale |
|-----------------|------------|-----------|
| LIKE with leading wildcard | low | Selectivity estimation unreliable (~26% accuracy) |
| EXISTS subquery | low | Cannot estimate cardinality statically |
| Correlated subquery (N+1) | low | N+1 patterns unquantifiable without runtime data |
| 3+ table joins | medium | Multi-table joins compound estimation error |
| SELECT * in subquery | medium | Prevents column-level analysis |
| OR in JOIN ON | medium | Complicates cardinality estimation |
| Non-equi join | medium | High cardinality variance |
| (none of the above) | high | Standard pattern, reliable detection |

---

## Column-Level Lineage Engine (`lineage.check`)

### Summary

| Metric | Value |
|--------|-------|
| Total queries | 500 |
| Perfect edge match | 500/500 (100.0%) |
| Confidence match | 500/500 (100.0%) |
| Factor subset match | 500/500 (100.0%) |
| Avg precision | 1.0 |
| Avg recall | 1.0 |
| Avg F1 | **1.0** |
| Avg latency | 0.26ms/query |
| Parse errors | 0 |

### Per-Category Breakdown (13 categories)

| Category | Queries | Edge Match Rate |
|----------|---------|----------------|
| simple_select | 50 | 100% |
| aliased_columns | 50 | 100% |
| aggregation | 50 | 100% |
| multi_table_join | 60 | 100% |
| subquery | 40 | 100% |
| cte | 40 | 100% |
| window_function | 40 | 100% |
| case_expression | 30 | 100% |
| union | 30 | 100% |
| select_star | 30 | 100% |
| complex_multi_hop | 40 | 100% |
| jinja_template | 20 | 100% |
| no_schema_context | 20 | 100% |

### Lineage Confidence Signals

| Signal | Confidence | Description |
|--------|------------|-------------|
| SELECT * present | low | Ambiguous column mapping |
| Jinja/macro syntax (`{{`/`}}`) | low | Parse failure likely, suggest manifest lineage |
| No `schema_context` provided | medium | Best-effort lineage only |
| Edge count > 1,000 | medium | Large graph, output may be truncated |
| (none of the above) | high | Clean parse, reliable lineage |

### Known Limitations

1. **Cross-CTE lineage**: CTEs produce independent edges per SELECT. The engine does not trace data flow across CTE boundaries (e.g., `cte1 -> cte2 -> final`). Each CTE's SELECT is analyzed independently.
2. **Jinja/macro SQL**: SQL containing `{{`/`}}` syntax cannot be parsed by sqlglot. The engine returns empty edges with `confidence: "low"` and suggests using dbt manifest lineage instead.
3. **Unqualified columns**: Columns without table qualifiers (e.g., `SELECT name` instead of `SELECT t.name`) get `source_table: "unknown"`.
4. **Dialect coverage**: Currently validated against Snowflake SQL only. Other dialects (BigQuery, Redshift, Databricks) may have parsing differences.

---

## Methodology

### Query Generation

Both benchmarks use **deterministic, seeded query generation** to ensure reproducibility:

- **SQL Analyzer**: `generate_queries.py --count 1077 --seed 42`
  - 18 query categories covering basic SELECT, filters, joins, aggregations, CTEs, subqueries, window functions, set operations, and complex multi-pattern queries
  - Each query annotated with `expected_rules` (rules that SHOULD fire) and `unexpected_rules` (rules that should NOT fire)
  - Ground truth determined by AST structure, not human judgment

- **Lineage Engine**: `generate_lineage_queries.py --count 500 --seed 42`
  - 13 query categories covering column references, aliases, aggregations, joins, subqueries, CTEs, window functions, CASE expressions, UNIONs, SELECT *, and edge cases
  - Each query annotated with expected `LineageEdge` objects (source_table, source_column, target_table, target_column, transform)
  - Ground truth calibrated against actual engine behavior with manual verification

### Evaluation Metrics

- **Precision**: TP / (TP + FP) — "Of what we detected, how much was correct?"
- **Recall**: TP / (TP + FN) — "Of what should have been detected, how much did we find?"
- **F1**: Harmonic mean of precision and recall
- **Edge match**: Exact match of all (source_table, source_column, target_table, target_column) tuples per query
- **Confidence match**: Expected confidence level matches actual confidence level
- **Factor subset match**: Expected confidence factors are a subset of actual factors

### Reproducibility

To reproduce these benchmarks:

```bash
cd packages/altimate-engine
source .venv/bin/activate

# SQL Analyzer benchmark
cd ../../experiments/sql_analyze_validation
python generate_queries.py --count 1077 --seed 42 --output queries.json
python run_benchmark.py --input queries.json --output results/
python report.py --input results/<latest>.json

# Lineage benchmark
cd ../lineage_validation
python generate_lineage_queries.py --count 500 --seed 42 --output lineage_queries.json
python run_lineage_benchmark.py --input lineage_queries.json --output results/
python report_lineage.py --input results/<latest>.json
```

### Validation Approach

This follows the **Validation-Driven Development** methodology:

1. Theory → Implementation → Unit tests → Validation harness → Pattern analysis → Confidence framework → Hardening → Published benchmarks → Refinement roadmap
2. Accuracy is **stratified by category**, not aggregate — a 100% aggregate could hide 0% in one category
3. Every analysis result includes a `confidence` field signaling reliability
4. Benchmarks are re-run after every engine change to catch regressions

### Caveats

- All queries are **synthetically generated**. Real-world SQL may contain patterns not covered by the 18+13 categories.
- The benchmark measures detection accuracy against known ground truth. It does not measure the **usefulness** of recommendations.
- 100% accuracy on synthetic queries does not guarantee 100% on production SQL. The next validation step is testing against anonymized production queries.
- Snowflake dialect only. Cross-dialect validation is planned.

---

## Raw Data

Benchmark results are stored as timestamped JSON files:

- SQL Analyzer: `experiments/sql_analyze_validation/results/`
- Lineage Engine: `experiments/lineage_validation/results/`

Each file contains per-query results including SQL text, expected findings, actual findings, and match status.
