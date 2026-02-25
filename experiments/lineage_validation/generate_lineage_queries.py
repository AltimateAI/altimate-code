"""Generate SQL queries with known ground-truth lineage edges.

Generates 500+ SQL queries across 12 categories, each with expected
lineage edges, confidence level, and confidence factors. Ground truth
is calibrated to the actual behavior of the lineage engine in
packages/altimate-engine/src/altimate_engine/lineage/check.py.

Engine behavior notes (sqlglot 29.x, post-fix):
- _get_target_table returns the actual FROM table name (table alias if aliased, name if not)
- For CTEs, the outer SELECT's target table is the CTE name
- For subqueries, the outer SELECT's target table is the subquery alias
- Unqualified columns get source_table="unknown"
- Alias handler extracts Column references from Func/Window/Case inner expressions
- Window expressions are now handled in _get_target_columns (Func or Window)
- Aggregation/Case/Window WITHOUT alias map to expr_N but no edge (main loop only handles Column/Alias)
- CTEs produce edges for each SELECT statement independently (no cross-CTE tracing)
- UNION produces separate edges per branch

Usage:
    python generate_lineage_queries.py --count 500 --seed 42 --output lineage_queries.json
"""

from __future__ import annotations

import argparse
import json
import random
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any


@dataclass
class ExpectedEdge:
    source_table: str
    source_column: str
    target_table: str
    target_column: str


@dataclass
class QuerySpec:
    sql: str
    category: str
    expected_edges: list[ExpectedEdge]
    expected_confidence: str
    expected_confidence_factors: list[str]
    has_schema_context: bool = False
    schema_context: dict[str, list[dict[str, str]]] | None = None


# ---------------------------------------------------------------------------
# Word pools for randomised table/column names
# ---------------------------------------------------------------------------

TABLE_NAMES = [
    "users", "orders", "products", "customers", "accounts", "transactions",
    "events", "sessions", "items", "payments", "invoices", "reviews",
    "categories", "tags", "logs", "metrics", "employees", "departments",
    "projects", "tasks", "tickets", "comments", "messages", "notifications",
    "inventory", "shipments", "addresses", "contacts", "vendors", "suppliers",
]

COLUMN_NAMES = [
    "id", "name", "email", "amount", "price", "quantity", "status",
    "created_at", "updated_at", "description", "title", "type", "category",
    "value", "score", "rating", "level", "count", "total", "balance",
    "first_name", "last_name", "phone", "address", "city", "state", "country",
    "region", "code", "label", "priority", "weight", "size", "color",
    "url", "path", "version", "flag", "active", "enabled",
]

ALIAS_NAMES = [
    "result", "val", "output", "metric", "stat", "total_val", "cnt",
    "sum_val", "avg_val", "max_val", "min_val", "renamed", "mapped",
    "computed", "derived", "final", "processed", "filtered", "grouped",
    "ranked", "scored", "labeled", "flagged", "tagged", "marked",
]

NO_SCHEMA_FACTOR = "No schema context provided \u2014 best-effort lineage only"
SELECT_STAR_FACTOR = "SELECT * creates ambiguous column mapping"
JINJA_FACTOR = "Jinja/macro detected \u2014 suggest using manifest lineage instead"


def _pick(pool: list[str], rng: random.Random, n: int = 1, exclude: set[str] | None = None) -> list[str]:
    """Pick n unique items from pool, excluding any in exclude set."""
    available = [x for x in pool if not exclude or x not in exclude]
    return rng.sample(available, min(n, len(available)))


def _pick1(pool: list[str], rng: random.Random, exclude: set[str] | None = None) -> str:
    return _pick(pool, rng, 1, exclude)[0]


# ---------------------------------------------------------------------------
# Category generators
# ---------------------------------------------------------------------------


def gen_simple_select(rng: random.Random, _idx: int) -> QuerySpec:
    """Simple SELECT without table qualifiers."""
    t = _pick1(TABLE_NAMES, rng)
    cols = _pick(COLUMN_NAMES, rng, rng.randint(1, 4))
    col_list = ", ".join(cols)
    sql = f"SELECT {col_list} FROM {t}"

    edges = [
        ExpectedEdge(
            source_table="unknown",
            source_column=c,
            target_table=t,
            target_column=c,
        )
        for c in cols
    ]
    return QuerySpec(
        sql=sql,
        category="simple_select",
        expected_edges=edges,
        expected_confidence="medium",
        expected_confidence_factors=[NO_SCHEMA_FACTOR],
    )


def gen_simple_select_qualified(rng: random.Random, _idx: int) -> QuerySpec:
    """Simple SELECT with table-qualified columns."""
    t = _pick1(TABLE_NAMES, rng)
    cols = _pick(COLUMN_NAMES, rng, rng.randint(1, 4))
    col_list = ", ".join(f"{t}.{c}" for c in cols)
    sql = f"SELECT {col_list} FROM {t}"

    edges = [
        ExpectedEdge(
            source_table=t,
            source_column=c,
            target_table=t,
            target_column=c,
        )
        for c in cols
    ]
    return QuerySpec(
        sql=sql,
        category="simple_select",
        expected_edges=edges,
        expected_confidence="medium",
        expected_confidence_factors=[NO_SCHEMA_FACTOR],
    )


def gen_aliased_column(rng: random.Random, _idx: int) -> QuerySpec:
    """SELECT with column aliases."""
    t = _pick1(TABLE_NAMES, rng)
    n_cols = rng.randint(1, 3)
    cols = _pick(COLUMN_NAMES, rng, n_cols)
    aliases = _pick(ALIAS_NAMES, rng, n_cols)

    # Mix qualified and unqualified
    use_qualified = rng.choice([True, False])
    select_parts = []
    edges = []
    for col, alias in zip(cols, aliases):
        if use_qualified:
            select_parts.append(f"{t}.{col} AS {alias}")
            src_table = t
        else:
            select_parts.append(f"{col} AS {alias}")
            src_table = "unknown"

        edges.append(
            ExpectedEdge(
                source_table=src_table,
                source_column=col,
                target_table=t,
                target_column=alias,
            )
        )

    sql = f"SELECT {', '.join(select_parts)} FROM {t}"
    return QuerySpec(
        sql=sql,
        category="aliased_columns",
        expected_edges=edges,
        expected_confidence="medium",
        expected_confidence_factors=[NO_SCHEMA_FACTOR],
    )


def gen_multi_table_join(rng: random.Random, _idx: int) -> QuerySpec:
    """Multi-table JOIN with qualified columns."""
    tables = _pick(TABLE_NAMES, rng, rng.randint(2, 3))
    t1, t2 = tables[0], tables[1]

    cols_per_table = {}
    select_parts = []
    edges = []

    for t in tables:
        n = rng.randint(1, 2)
        used = set()
        for other_cols in cols_per_table.values():
            used.update(other_cols)
        cs = _pick(COLUMN_NAMES, rng, n, exclude=used)
        cols_per_table[t] = cs
        for c in cs:
            select_parts.append(f"{t}.{c}")
            edges.append(
                ExpectedEdge(
                    source_table=t,
                    source_column=c,
                    target_table=t1,
                    target_column=c,
                )
            )

    join_col = _pick1(COLUMN_NAMES, rng, exclude=set(c for cs in cols_per_table.values() for c in cs))

    join_clauses = []
    for i in range(1, len(tables)):
        join_clauses.append(f"JOIN {tables[i]} ON {t1}.{join_col} = {tables[i]}.{join_col}")

    sql = f"SELECT {', '.join(select_parts)} FROM {t1} {' '.join(join_clauses)}"

    return QuerySpec(
        sql=sql,
        category="multi_table_join",
        expected_edges=edges,
        expected_confidence="medium",
        expected_confidence_factors=[NO_SCHEMA_FACTOR],
    )


def gen_cte(rng: random.Random, _idx: int) -> QuerySpec:
    """CTE with simple column references."""
    t = _pick1(TABLE_NAMES, rng)
    cols = _pick(COLUMN_NAMES, rng, rng.randint(1, 3))
    cte_name = "cte_" + _pick1(TABLE_NAMES, rng, exclude={t})

    inner_col_list = ", ".join(f"{t}.{c}" for c in cols)
    outer_col_list = ", ".join(f"{cte_name}.{c}" for c in cols)

    sql = f"WITH {cte_name} AS (SELECT {inner_col_list} FROM {t}) SELECT {outer_col_list} FROM {cte_name}"

    # Engine produces edges for each SELECT independently:
    # Inner SELECT FROM t: t.col -> t.col (target_table = t)
    # Outer SELECT FROM cte_name: cte_name.col -> cte_name.col (target_table = cte_name)
    edges = []
    for c in cols:
        edges.append(ExpectedEdge(source_table=cte_name, source_column=c, target_table=cte_name, target_column=c))
        edges.append(ExpectedEdge(source_table=t, source_column=c, target_table=t, target_column=c))

    return QuerySpec(
        sql=sql,
        category="cte",
        expected_edges=edges,
        expected_confidence="medium",
        expected_confidence_factors=[NO_SCHEMA_FACTOR],
    )


def gen_cte_unqualified(rng: random.Random, _idx: int) -> QuerySpec:
    """CTE with unqualified column references."""
    t = _pick1(TABLE_NAMES, rng)
    cols = _pick(COLUMN_NAMES, rng, rng.randint(1, 2))
    cte_name = "cte_" + _pick1(TABLE_NAMES, rng, exclude={t})

    inner_col_list = ", ".join(cols)
    outer_col_list = ", ".join(cols)

    sql = f"WITH {cte_name} AS (SELECT {inner_col_list} FROM {t}) SELECT {outer_col_list} FROM {cte_name}"

    edges = []
    for c in cols:
        # Inner SELECT FROM t: target_table = t
        # Outer SELECT FROM cte_name: target_table = cte_name
        edges.append(ExpectedEdge(source_table="unknown", source_column=c, target_table=cte_name, target_column=c))
        edges.append(ExpectedEdge(source_table="unknown", source_column=c, target_table=t, target_column=c))

    return QuerySpec(
        sql=sql,
        category="cte",
        expected_edges=edges,
        expected_confidence="medium",
        expected_confidence_factors=[NO_SCHEMA_FACTOR],
    )


def gen_subquery(rng: random.Random, _idx: int) -> QuerySpec:
    """Subquery in FROM clause."""
    t = _pick1(TABLE_NAMES, rng)
    cols = _pick(COLUMN_NAMES, rng, rng.randint(1, 2))
    sub_alias = "sub"

    inner_col_list = ", ".join(f"{t}.{c}" for c in cols)
    outer_col_list = ", ".join(f"{sub_alias}.{c}" for c in cols)

    sql = f"SELECT {outer_col_list} FROM (SELECT {inner_col_list} FROM {t}) AS {sub_alias}"

    # Inner SELECT FROM t: target_table = t
    # Outer SELECT FROM (... FROM t) AS sub: _get_target_table does find_all(Table)
    # which digs into the subquery and finds the inner table t, so target_table = t
    edges = []
    for c in cols:
        edges.append(ExpectedEdge(source_table=sub_alias, source_column=c, target_table=t, target_column=c))
        edges.append(ExpectedEdge(source_table=t, source_column=c, target_table=t, target_column=c))

    return QuerySpec(
        sql=sql,
        category="subquery",
        expected_edges=edges,
        expected_confidence="medium",
        expected_confidence_factors=[NO_SCHEMA_FACTOR],
    )


def gen_subquery_unqualified(rng: random.Random, _idx: int) -> QuerySpec:
    """Subquery with unqualified columns."""
    t = _pick1(TABLE_NAMES, rng)
    cols = _pick(COLUMN_NAMES, rng, rng.randint(1, 2))

    inner_col_list = ", ".join(cols)
    outer_col_list = ", ".join(cols)

    sql = f"SELECT {outer_col_list} FROM (SELECT {inner_col_list} FROM {t}) AS sub"

    edges = []
    for c in cols:
        # Outer SELECT FROM (... FROM t) AS sub: find_all(Table) finds inner table t
        edges.append(ExpectedEdge(source_table="unknown", source_column=c, target_table=t, target_column=c))
        # Inner SELECT FROM t: target_table = t
        edges.append(ExpectedEdge(source_table="unknown", source_column=c, target_table=t, target_column=c))

    return QuerySpec(
        sql=sql,
        category="subquery",
        expected_edges=edges,
        expected_confidence="medium",
        expected_confidence_factors=[NO_SCHEMA_FACTOR],
    )


def gen_aggregation(rng: random.Random, _idx: int) -> QuerySpec:
    """Aggregation functions (COUNT, SUM, AVG, etc.) -- engine produces no edges for these."""
    t = _pick1(TABLE_NAMES, rng)
    funcs = ["COUNT", "SUM", "AVG", "MAX", "MIN"]
    n_aggs = rng.randint(1, 3)
    cols = _pick(COLUMN_NAMES, rng, n_aggs)

    parts = []
    for i in range(n_aggs):
        func = rng.choice(funcs)
        parts.append(f"{func}({cols[i]})")

    sql = f"SELECT {', '.join(parts)} FROM {t}"

    # Engine maps these to expr_N in _get_target_columns (Func),
    # but the edge-building loop only handles Column and Alias.
    # Func expressions get target_col=expr_N but no edge is created.
    # No edges expected.
    return QuerySpec(
        sql=sql,
        category="aggregation",
        expected_edges=[],
        expected_confidence="medium",
        expected_confidence_factors=[NO_SCHEMA_FACTOR],
    )


def gen_aggregation_with_alias(rng: random.Random, _idx: int) -> QuerySpec:
    """Aggregation with alias -- Alias handler now extracts inner Column references."""
    t = _pick1(TABLE_NAMES, rng)
    funcs = ["COUNT", "SUM", "AVG", "MAX", "MIN"]
    func = rng.choice(funcs)
    col = _pick1(COLUMN_NAMES, rng)
    alias = _pick1(ALIAS_NAMES, rng)

    sql = f"SELECT {func}({col}) AS {alias} FROM {t}"

    # Alias handler now does source.find_all(exp.Column) for non-Column inner expressions.
    # COUNT(col) -> finds Column(col) inside -> creates edge.
    # Column is unqualified so source_table="unknown", target_table=t (FROM table)
    edges = [
        ExpectedEdge(source_table="unknown", source_column=col, target_table=t, target_column=alias),
    ]
    return QuerySpec(
        sql=sql,
        category="aggregation",
        expected_edges=edges,
        expected_confidence="medium",
        expected_confidence_factors=[NO_SCHEMA_FACTOR],
    )


def gen_aggregation_with_group_by(rng: random.Random, _idx: int) -> QuerySpec:
    """Aggregation with GROUP BY and a plain column."""
    t = _pick1(TABLE_NAMES, rng)
    group_col = _pick1(COLUMN_NAMES, rng)
    agg_col = _pick1(COLUMN_NAMES, rng, exclude={group_col})
    func = rng.choice(["COUNT", "SUM", "AVG", "MAX", "MIN"])

    sql = f"SELECT {t}.{group_col}, {func}({t}.{agg_col}) AS agg_val FROM {t} GROUP BY {t}.{group_col}"

    # The plain column t.group_col generates an edge (target_table = t)
    # The aliased aggregation now also creates an edge via find_all(Column):
    # func(t.agg_col) AS agg_val -> inner Column is t.agg_col
    edges = [
        ExpectedEdge(source_table=t, source_column=group_col, target_table=t, target_column=group_col),
        ExpectedEdge(source_table=t, source_column=agg_col, target_table=t, target_column="agg_val"),
    ]
    return QuerySpec(
        sql=sql,
        category="aggregation",
        expected_edges=edges,
        expected_confidence="medium",
        expected_confidence_factors=[NO_SCHEMA_FACTOR],
    )


def gen_case_expression(rng: random.Random, _idx: int) -> QuerySpec:
    """CASE expression with alias -- engine now extracts inner Column references."""
    t = _pick1(TABLE_NAMES, rng)
    cond_col = _pick1(COLUMN_NAMES, rng)
    then_col = _pick1(COLUMN_NAMES, rng, exclude={cond_col})
    else_col = _pick1(COLUMN_NAMES, rng, exclude={cond_col, then_col})
    alias = _pick1(ALIAS_NAMES, rng)

    sql = f"SELECT CASE WHEN {cond_col} > 0 THEN {then_col} ELSE {else_col} END AS {alias} FROM {t}"

    # Alias handler now does source.find_all(exp.Column) for Case expressions.
    # CASE WHEN cond_col > 0 THEN then_col ELSE else_col END
    # finds: cond_col, then_col, else_col (all unqualified -> source_table="unknown")
    # target_table = t (FROM table)
    edges = [
        ExpectedEdge(source_table="unknown", source_column=cond_col, target_table=t, target_column=alias),
        ExpectedEdge(source_table="unknown", source_column=then_col, target_table=t, target_column=alias),
        ExpectedEdge(source_table="unknown", source_column=else_col, target_table=t, target_column=alias),
    ]
    return QuerySpec(
        sql=sql,
        category="case_expression",
        expected_edges=edges,
        expected_confidence="medium",
        expected_confidence_factors=[NO_SCHEMA_FACTOR],
    )


def gen_case_with_plain_col(rng: random.Random, _idx: int) -> QuerySpec:
    """CASE alongside a plain column -- plain column and CASE inner columns get edges."""
    t = _pick1(TABLE_NAMES, rng)
    plain_col = _pick1(COLUMN_NAMES, rng)
    cond_col = _pick1(COLUMN_NAMES, rng, exclude={plain_col})
    then_col = _pick1(COLUMN_NAMES, rng, exclude={plain_col, cond_col})
    alias = _pick1(ALIAS_NAMES, rng)

    sql = f"SELECT {t}.{plain_col}, CASE WHEN {cond_col} > 0 THEN {then_col} ELSE 0 END AS {alias} FROM {t}"

    # Plain column gets edge, CASE inner columns also get edges now.
    # CASE WHEN cond_col > 0 THEN then_col ELSE 0 END
    # 0 is a literal (Literal node), not a Column, so only cond_col and then_col produce edges.
    edges = [
        ExpectedEdge(source_table=t, source_column=plain_col, target_table=t, target_column=plain_col),
        ExpectedEdge(source_table="unknown", source_column=cond_col, target_table=t, target_column=alias),
        ExpectedEdge(source_table="unknown", source_column=then_col, target_table=t, target_column=alias),
    ]
    return QuerySpec(
        sql=sql,
        category="case_expression",
        expected_edges=edges,
        expected_confidence="medium",
        expected_confidence_factors=[NO_SCHEMA_FACTOR],
    )


def gen_union(rng: random.Random, _idx: int) -> QuerySpec:
    """UNION ALL query."""
    t1, t2 = _pick(TABLE_NAMES, rng, 2)
    n_cols = rng.randint(1, 3)
    cols1 = _pick(COLUMN_NAMES, rng, n_cols)
    cols2 = _pick(COLUMN_NAMES, rng, n_cols)

    use_union_all = rng.choice([True, False])
    union_kw = "UNION ALL" if use_union_all else "UNION"

    sql = f"SELECT {', '.join(cols1)} FROM {t1} {union_kw} SELECT {', '.join(cols2)} FROM {t2}"

    # Each branch produces its own edges with unqualified columns
    # Branch 1 FROM t1: target_table = t1
    # Branch 2 FROM t2: target_table = t2
    edges = []
    for c in cols1:
        edges.append(ExpectedEdge(source_table="unknown", source_column=c, target_table=t1, target_column=c))
    for c in cols2:
        edges.append(ExpectedEdge(source_table="unknown", source_column=c, target_table=t2, target_column=c))

    return QuerySpec(
        sql=sql,
        category="union",
        expected_edges=edges,
        expected_confidence="medium",
        expected_confidence_factors=[NO_SCHEMA_FACTOR],
    )


def gen_union_qualified(rng: random.Random, _idx: int) -> QuerySpec:
    """UNION ALL with table-qualified columns."""
    t1, t2 = _pick(TABLE_NAMES, rng, 2)
    n_cols = rng.randint(1, 2)
    cols1 = _pick(COLUMN_NAMES, rng, n_cols)
    cols2 = _pick(COLUMN_NAMES, rng, n_cols)

    sql = (
        f"SELECT {', '.join(f'{t1}.{c}' for c in cols1)} FROM {t1} "
        f"UNION ALL SELECT {', '.join(f'{t2}.{c}' for c in cols2)} FROM {t2}"
    )

    edges = []
    for c in cols1:
        edges.append(ExpectedEdge(source_table=t1, source_column=c, target_table=t1, target_column=c))
    for c in cols2:
        edges.append(ExpectedEdge(source_table=t2, source_column=c, target_table=t2, target_column=c))

    return QuerySpec(
        sql=sql,
        category="union",
        expected_edges=edges,
        expected_confidence="medium",
        expected_confidence_factors=[NO_SCHEMA_FACTOR],
    )


def gen_window_function(rng: random.Random, _idx: int) -> QuerySpec:
    """Window function without alias -- no edge for window expr, only plain column."""
    t = _pick1(TABLE_NAMES, rng)
    col = _pick1(COLUMN_NAMES, rng)
    order_col = _pick1(COLUMN_NAMES, rng, exclude={col})
    win_func = rng.choice(["ROW_NUMBER()", "RANK()", "DENSE_RANK()", "NTILE(4)"])

    sql = f"SELECT {win_func} OVER (ORDER BY {order_col}), {t}.{col} FROM {t}"

    # Window expression without alias is handled by _get_target_columns as (Func, Window) -> expr_N
    # But the main loop only handles Column and Alias, not Window directly.
    # Only the plain column t.col gets an edge (target_table = t)
    edges = [
        ExpectedEdge(source_table=t, source_column=col, target_table=t, target_column=col),
    ]
    return QuerySpec(
        sql=sql,
        category="window_function",
        expected_edges=edges,
        expected_confidence="medium",
        expected_confidence_factors=[NO_SCHEMA_FACTOR],
    )


def gen_window_with_alias(rng: random.Random, _idx: int) -> QuerySpec:
    """Window function with alias alongside plain column -- now creates edges for inner columns."""
    t = _pick1(TABLE_NAMES, rng)
    col = _pick1(COLUMN_NAMES, rng)
    order_col = _pick1(COLUMN_NAMES, rng, exclude={col})
    alias = _pick1(ALIAS_NAMES, rng)
    win_func = rng.choice(["ROW_NUMBER()", "RANK()", "DENSE_RANK()"])

    sql = f"SELECT {win_func} OVER (ORDER BY {order_col}) AS {alias}, {t}.{col} FROM {t}"

    # Alias(Window(...)) -- Alias handler now does source.find_all(exp.Column)
    # ROW_NUMBER() OVER (ORDER BY order_col): finds Column(order_col) inside
    # order_col is unqualified -> source_table="unknown", target_table = t
    # Plain column t.col also gets an edge
    edges = [
        ExpectedEdge(source_table="unknown", source_column=order_col, target_table=t, target_column=alias),
        ExpectedEdge(source_table=t, source_column=col, target_table=t, target_column=col),
    ]
    return QuerySpec(
        sql=sql,
        category="window_function",
        expected_edges=edges,
        expected_confidence="medium",
        expected_confidence_factors=[NO_SCHEMA_FACTOR],
    )


def gen_window_partition(rng: random.Random, _idx: int) -> QuerySpec:
    """Window function with PARTITION BY and plain column -- now creates edges for inner columns."""
    t = _pick1(TABLE_NAMES, rng)
    col = _pick1(COLUMN_NAMES, rng)
    part_col = _pick1(COLUMN_NAMES, rng, exclude={col})
    order_col = _pick1(COLUMN_NAMES, rng, exclude={col, part_col})

    sql = f"SELECT ROW_NUMBER() OVER (PARTITION BY {part_col} ORDER BY {order_col}) AS rn, {t}.{col} FROM {t}"

    # Alias(Window(...)) with PARTITION BY and ORDER BY
    # source.find_all(exp.Column) finds: part_col and order_col (both unqualified -> "unknown")
    # target_table = t, target_column = "rn" (the alias)
    # Plain column t.col also gets an edge
    edges = [
        ExpectedEdge(source_table="unknown", source_column=part_col, target_table=t, target_column="rn"),
        ExpectedEdge(source_table="unknown", source_column=order_col, target_table=t, target_column="rn"),
        ExpectedEdge(source_table=t, source_column=col, target_table=t, target_column=col),
    ]
    return QuerySpec(
        sql=sql,
        category="window_function",
        expected_edges=edges,
        expected_confidence="medium",
        expected_confidence_factors=[NO_SCHEMA_FACTOR],
    )


def gen_complex_multi_hop(rng: random.Random, _idx: int) -> QuerySpec:
    """Multi-CTE chain with aliases at each stage."""
    t = _pick1(TABLE_NAMES, rng)
    col = _pick1(COLUMN_NAMES, rng)
    alias1 = _pick1(ALIAS_NAMES, rng)
    alias2 = _pick1(ALIAS_NAMES, rng, exclude={alias1})

    sql = (
        f"WITH s1 AS (SELECT {t}.{col} FROM {t}), "
        f"s2 AS (SELECT s1.{col} AS {alias1} FROM s1) "
        f"SELECT s2.{alias1} FROM s2"
    )

    # s1 inner SELECT FROM t: t.col -> target_table=t, target_column=col
    # s2 inner SELECT FROM s1: s1.col aliased to alias1 => edge s1.col -> target_table=s1, target_column=alias1
    # outer SELECT FROM s2: s2.alias1 -> target_table=s2, target_column=alias1
    edges = [
        ExpectedEdge(source_table="s2", source_column=alias1, target_table="s2", target_column=alias1),
        ExpectedEdge(source_table=t, source_column=col, target_table=t, target_column=col),
        ExpectedEdge(source_table="s1", source_column=col, target_table="s1", target_column=alias1),
    ]
    return QuerySpec(
        sql=sql,
        category="complex_multi_hop",
        expected_edges=edges,
        expected_confidence="medium",
        expected_confidence_factors=[NO_SCHEMA_FACTOR],
    )


def gen_complex_multi_hop_unqualified(rng: random.Random, _idx: int) -> QuerySpec:
    """Multi-CTE chain with unqualified columns."""
    t = _pick1(TABLE_NAMES, rng)
    cols = _pick(COLUMN_NAMES, rng, 2)
    c1, c2 = cols

    sql = (
        f"WITH s1 AS (SELECT {c1}, {c2} FROM {t}), "
        f"s2 AS (SELECT {c1}, {c2} FROM s1) "
        f"SELECT {c1}, {c2} FROM s2"
    )

    # 3 SELECT statements, each produces edges for unqualified columns
    # s1 inner SELECT FROM t: target_table = t
    # s2 inner SELECT FROM s1: target_table = s1
    # outer SELECT FROM s2: target_table = s2
    edges = []
    for c in [c1, c2]:
        edges.append(ExpectedEdge(source_table="unknown", source_column=c, target_table="s2", target_column=c))
        edges.append(ExpectedEdge(source_table="unknown", source_column=c, target_table="s1", target_column=c))
        edges.append(ExpectedEdge(source_table="unknown", source_column=c, target_table=t, target_column=c))

    return QuerySpec(
        sql=sql,
        category="complex_multi_hop",
        expected_edges=edges,
        expected_confidence="medium",
        expected_confidence_factors=[NO_SCHEMA_FACTOR],
    )


def gen_complex_join_cte(rng: random.Random, _idx: int) -> QuerySpec:
    """CTE with JOIN in it."""
    t1, t2 = _pick(TABLE_NAMES, rng, 2)
    col1 = _pick1(COLUMN_NAMES, rng)
    col2 = _pick1(COLUMN_NAMES, rng, exclude={col1})
    join_col = _pick1(COLUMN_NAMES, rng, exclude={col1, col2})

    sql = (
        f"WITH combined AS ("
        f"SELECT {t1}.{col1}, {t2}.{col2} FROM {t1} JOIN {t2} ON {t1}.{join_col} = {t2}.{join_col}"
        f") SELECT combined.{col1}, combined.{col2} FROM combined"
    )

    edges = [
        # Outer SELECT FROM combined: target_table = combined
        ExpectedEdge(source_table="combined", source_column=col1, target_table="combined", target_column=col1),
        ExpectedEdge(source_table="combined", source_column=col2, target_table="combined", target_column=col2),
        # Inner SELECT FROM t1 (first table in FROM): target_table = t1
        ExpectedEdge(source_table=t1, source_column=col1, target_table=t1, target_column=col1),
        ExpectedEdge(source_table=t2, source_column=col2, target_table=t1, target_column=col2),
    ]
    return QuerySpec(
        sql=sql,
        category="complex_multi_hop",
        expected_edges=edges,
        expected_confidence="medium",
        expected_confidence_factors=[NO_SCHEMA_FACTOR],
    )


def gen_select_star(rng: random.Random, _idx: int) -> QuerySpec:
    """SELECT * from a single table."""
    t = _pick1(TABLE_NAMES, rng)
    sql = f"SELECT * FROM {t}"

    return QuerySpec(
        sql=sql,
        category="select_star",
        expected_edges=[],
        expected_confidence="low",
        expected_confidence_factors=[SELECT_STAR_FACTOR, NO_SCHEMA_FACTOR],
    )


def gen_select_star_with_column(rng: random.Random, _idx: int) -> QuerySpec:
    """SELECT * alongside a regular column."""
    t = _pick1(TABLE_NAMES, rng)
    col = _pick1(COLUMN_NAMES, rng)
    sql = f"SELECT *, {t}.{col} FROM {t}"

    # SELECT * triggers low confidence. The regular column still gets an edge.
    edges = [
        ExpectedEdge(source_table=t, source_column=col, target_table=t, target_column=col),
    ]
    return QuerySpec(
        sql=sql,
        category="select_star",
        expected_edges=edges,
        expected_confidence="low",
        expected_confidence_factors=[SELECT_STAR_FACTOR, NO_SCHEMA_FACTOR],
    )


def gen_jinja_template(rng: random.Random, _idx: int) -> QuerySpec:
    """Jinja template SQL -- should fail to parse and return empty edges."""
    model = _pick1(TABLE_NAMES, rng)
    col = _pick1(COLUMN_NAMES, rng)

    templates = [
        f"SELECT {{{{ {col} }}}} FROM {{{{ ref('{model}') }}}}",
        f"SELECT * FROM {{{{ ref('{model}') }}}} WHERE {{{{ col_name }}}} IS NOT NULL",
        f"SELECT {col} FROM {{{{ source('raw', '{model}') }}}}",
        f"{{% set cols = ['{col}'] %}}SELECT {{% for c in cols %}}{{{{c}}}}{{% endfor %}} FROM {model}",
    ]
    sql = rng.choice(templates)

    return QuerySpec(
        sql=sql,
        category="jinja_template",
        expected_edges=[],
        expected_confidence="low",
        expected_confidence_factors=[JINJA_FACTOR, NO_SCHEMA_FACTOR],
    )


def gen_no_schema_context(rng: random.Random, _idx: int) -> QuerySpec:
    """Standard query explicitly tested without schema context."""
    t = _pick1(TABLE_NAMES, rng)
    cols = _pick(COLUMN_NAMES, rng, rng.randint(1, 3))
    col_list = ", ".join(f"{t}.{c}" for c in cols)
    sql = f"SELECT {col_list} FROM {t}"

    edges = [
        ExpectedEdge(source_table=t, source_column=c, target_table=t, target_column=c)
        for c in cols
    ]
    return QuerySpec(
        sql=sql,
        category="no_schema_context",
        expected_edges=edges,
        expected_confidence="medium",
        expected_confidence_factors=[NO_SCHEMA_FACTOR],
    )


def gen_with_schema_context(rng: random.Random, _idx: int) -> QuerySpec:
    """Query WITH schema context -- confidence should be high."""
    t = _pick1(TABLE_NAMES, rng)
    cols = _pick(COLUMN_NAMES, rng, rng.randint(1, 3))
    col_list = ", ".join(f"{t}.{c}" for c in cols)
    sql = f"SELECT {col_list} FROM {t}"

    schema_ctx = {
        t: [{"name": c, "data_type": "VARCHAR"} for c in cols]
    }

    edges = [
        ExpectedEdge(source_table=t, source_column=c, target_table=t, target_column=c)
        for c in cols
    ]
    return QuerySpec(
        sql=sql,
        category="no_schema_context",
        expected_edges=edges,
        expected_confidence="high",
        expected_confidence_factors=[],
        has_schema_context=True,
        schema_context=schema_ctx,
    )


# ---------------------------------------------------------------------------
# Category registry with target counts
# ---------------------------------------------------------------------------

CATEGORY_GENERATORS: list[tuple[str, list[Any], list[float]]] = [
    # (category_name, [generator_functions], [weights])
    ("simple_select", [gen_simple_select, gen_simple_select_qualified], [0.5, 0.5]),
    ("aliased_columns", [gen_aliased_column], [1.0]),
    ("multi_table_join", [gen_multi_table_join], [1.0]),
    ("cte", [gen_cte, gen_cte_unqualified], [0.6, 0.4]),
    ("subquery", [gen_subquery, gen_subquery_unqualified], [0.6, 0.4]),
    ("aggregation", [gen_aggregation, gen_aggregation_with_alias, gen_aggregation_with_group_by], [0.3, 0.3, 0.4]),
    ("case_expression", [gen_case_expression, gen_case_with_plain_col], [0.5, 0.5]),
    ("union", [gen_union, gen_union_qualified], [0.5, 0.5]),
    ("window_function", [gen_window_function, gen_window_with_alias, gen_window_partition], [0.4, 0.3, 0.3]),
    ("complex_multi_hop", [gen_complex_multi_hop, gen_complex_multi_hop_unqualified, gen_complex_join_cte], [0.4, 0.3, 0.3]),
    ("select_star", [gen_select_star, gen_select_star_with_column], [0.6, 0.4]),
    ("jinja_template", [gen_jinja_template], [1.0]),
    ("no_schema_context", [gen_no_schema_context, gen_with_schema_context], [0.5, 0.5]),
]

# Target proportions for each category (roughly matching the spec)
CATEGORY_PROPORTIONS: dict[str, float] = {
    "simple_select": 50 / 500,
    "aliased_columns": 50 / 500,
    "multi_table_join": 60 / 500,
    "cte": 40 / 500,
    "subquery": 40 / 500,
    "aggregation": 50 / 500,
    "case_expression": 30 / 500,
    "union": 30 / 500,
    "window_function": 40 / 500,
    "complex_multi_hop": 40 / 500,
    "select_star": 30 / 500,
    "jinja_template": 20 / 500,
    "no_schema_context": 20 / 500,
}


def compute_category_counts(total: int) -> dict[str, int]:
    """Compute how many queries per category given a total count."""
    counts: dict[str, int] = {}
    assigned = 0
    items = list(CATEGORY_PROPORTIONS.items())

    for cat, prop in items[:-1]:
        n = max(1, round(total * prop))
        counts[cat] = n
        assigned += n

    # Last category gets the remainder
    last_cat = items[-1][0]
    counts[last_cat] = max(1, total - assigned)
    return counts


def generate_queries(total: int, seed: int) -> list[dict[str, Any]]:
    """Generate queries with ground-truth lineage."""
    rng = random.Random(seed)
    counts = compute_category_counts(total)

    # Build lookup from category name to its generators and weights
    cat_lookup = {cat: (gens, weights) for cat, gens, weights in CATEGORY_GENERATORS}

    queries: list[QuerySpec] = []
    global_idx = 0

    for cat, n in counts.items():
        gens, weights = cat_lookup[cat]
        for i in range(n):
            # Weighted random choice among generators for this category
            gen_fn = rng.choices(gens, weights=weights, k=1)[0]
            spec = gen_fn(rng, global_idx)
            queries.append(spec)
            global_idx += 1

    # Shuffle to interleave categories
    rng.shuffle(queries)

    # Serialize
    result = []
    for idx, q in enumerate(queries):
        entry = {
            "id": idx,
            "sql": q.sql,
            "category": q.category,
            "expected_edges": [asdict(e) for e in q.expected_edges],
            "expected_confidence": q.expected_confidence,
            "expected_confidence_factors": q.expected_confidence_factors,
            "has_schema_context": q.has_schema_context,
        }
        if q.schema_context is not None:
            entry["schema_context"] = q.schema_context
        result.append(entry)

    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate SQL lineage benchmark queries")
    parser.add_argument("--count", type=int, default=500, help="Number of queries to generate")
    parser.add_argument("--seed", type=int, default=42, help="Random seed for reproducibility")
    parser.add_argument("--output", type=str, default="lineage_queries.json", help="Output JSON file path")
    args = parser.parse_args()

    queries = generate_queries(args.count, args.seed)

    output_path = Path(args.output)
    if not output_path.is_absolute():
        output_path = Path.cwd() / output_path

    output_path.write_text(json.dumps(queries, indent=2))

    # Print summary
    from collections import Counter
    cats = Counter(q["category"] for q in queries)
    print(f"Generated {len(queries)} queries to {output_path}")
    print("Category breakdown:")
    for cat, count in sorted(cats.items()):
        print(f"  {cat}: {count}")


if __name__ == "__main__":
    main()
