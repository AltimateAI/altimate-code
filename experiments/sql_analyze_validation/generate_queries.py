"""Generate deterministic SQL queries for validating the StaticQueryAnalyzer.

Produces queries across 18 categories with ground-truth annotations indicating
which anti-pattern rules should and should not fire for each query.

Usage:
    python generate_queries.py --count 1000 --seed 42 --output queries.json
"""

from __future__ import annotations

import argparse
import json
import random
from typing import Any

# All 19 rule types the analyzer can produce (IMPLICIT_CARTESIAN is a variant)
ALL_RULES = [
    "SELECT_STAR",
    "FUNCTION_IN_JOIN",
    "FUNCTION_IN_FILTER",
    "MISSING_LIMIT",
    "CARTESIAN_PRODUCT",
    "ORDER_BY_WITHOUT_LIMIT",
    "UNION_INSTEAD_OF_UNION_ALL",
    "NOT_IN_WITH_SUBQUERY",
    "LIKE_LEADING_WILDCARD",
    "LARGE_IN_LIST",
    "CORRELATED_SUBQUERY",
    "UNUSED_CTE",
    "SELECT_STAR_IN_SUBQUERY",
    "OR_IN_JOIN",
    "NON_EQUI_JOIN",
    "WINDOW_WITHOUT_PARTITION",
    "GROUP_BY_PRIMARY_KEY",
    "ORDER_BY_IN_SUBQUERY",
    "IMPLICIT_CARTESIAN",
]

# Realistic table/column names for generation
TABLES = ["users", "orders", "products", "events", "sessions", "payments", "items", "categories", "reviews", "inventory"]
USER_COLS = ["id", "name", "email", "created_at", "status", "age", "country", "tier"]
ORDER_COLS = ["id", "user_id", "total", "created_at", "status", "discount", "shipping_cost"]
PRODUCT_COLS = ["id", "name", "price", "category_id", "created_at", "stock", "weight"]
EVENT_COLS = ["id", "user_id", "event_type", "created_at", "payload", "session_id"]
SESSION_COLS = ["id", "user_id", "started_at", "ended_at", "device", "ip_address"]
PAYMENT_COLS = ["id", "order_id", "amount", "method", "created_at", "status"]
ITEM_COLS = ["id", "order_id", "product_id", "quantity", "price"]
CATEGORY_COLS = ["id", "name", "parent_id", "description"]
REVIEW_COLS = ["id", "user_id", "product_id", "rating", "comment", "created_at"]
INVENTORY_COLS = ["id", "product_id", "warehouse_id", "quantity", "updated_at"]

TABLE_COLS = {
    "users": USER_COLS,
    "orders": ORDER_COLS,
    "products": PRODUCT_COLS,
    "events": EVENT_COLS,
    "sessions": SESSION_COLS,
    "payments": PAYMENT_COLS,
    "items": ITEM_COLS,
    "categories": CATEGORY_COLS,
    "reviews": REVIEW_COLS,
    "inventory": INVENTORY_COLS,
}

# Join relationships between tables
JOIN_PAIRS = [
    ("users", "orders", "users.id = orders.user_id"),
    ("users", "events", "users.id = events.user_id"),
    ("users", "sessions", "users.id = sessions.user_id"),
    ("users", "reviews", "users.id = reviews.user_id"),
    ("orders", "payments", "orders.id = payments.order_id"),
    ("orders", "items", "orders.id = items.order_id"),
    ("products", "items", "products.id = items.product_id"),
    ("products", "reviews", "products.id = reviews.product_id"),
    ("products", "inventory", "products.id = inventory.product_id"),
    ("products", "categories", "products.category_id = categories.id"),
]

# Numeric columns for range filters
NUMERIC_COLS = {
    "users": ["age"],
    "orders": ["total", "discount", "shipping_cost"],
    "products": ["price", "stock", "weight"],
    "events": [],
    "sessions": [],
    "payments": ["amount"],
    "items": ["quantity", "price"],
    "categories": [],
    "reviews": ["rating"],
    "inventory": ["quantity"],
}

# Date columns
DATE_COLS = {
    "users": ["created_at"],
    "orders": ["created_at"],
    "products": ["created_at"],
    "events": ["created_at"],
    "sessions": ["started_at", "ended_at"],
    "payments": ["created_at"],
    "items": [],
    "categories": [],
    "reviews": ["created_at"],
    "inventory": ["updated_at"],
}

# String columns for LIKE
STRING_COLS = {
    "users": ["name", "email", "country"],
    "orders": ["status"],
    "products": ["name"],
    "events": ["event_type"],
    "sessions": ["device", "ip_address"],
    "payments": ["method", "status"],
    "items": [],
    "categories": ["name", "description"],
    "reviews": ["comment"],
    "inventory": [],
}

# Aggregation functions
AGG_FUNCS = ["COUNT", "SUM", "AVG", "MIN", "MAX"]

# Window functions
WINDOW_FUNCS = ["ROW_NUMBER", "RANK", "DENSE_RANK", "LAG", "LEAD", "NTILE"]


def _pick_table(rng: random.Random) -> str:
    return rng.choice(TABLES)


def _pick_cols(rng: random.Random, table: str, n: int = 3) -> list[str]:
    cols = TABLE_COLS[table]
    n = min(n, len(cols))
    return rng.sample(cols, n)


def _pick_join_pair(rng: random.Random) -> tuple[str, str, str]:
    return rng.choice(JOIN_PAIRS)


def _pick_numeric_col(rng: random.Random, table: str) -> str | None:
    nums = NUMERIC_COLS.get(table, [])
    return rng.choice(nums) if nums else None


def _pick_date_col(rng: random.Random, table: str) -> str | None:
    dates = DATE_COLS.get(table, [])
    return rng.choice(dates) if dates else None


def _pick_string_col(rng: random.Random, table: str) -> str | None:
    strs = STRING_COLS.get(table, [])
    return rng.choice(strs) if strs else None


def _scale(base: int, count: int) -> int:
    """Scale a category count proportional to total --count."""
    return max(1, int(base * count / 1000))


# ---------------------------------------------------------------------------
# Category generators
# ---------------------------------------------------------------------------

def gen_basic_select(rng: random.Random, count: int) -> list[dict]:
    """Basic SELECT with specific columns, no anti-patterns expected (except MISSING_LIMIT)."""
    queries = []
    for _ in range(count):
        table = _pick_table(rng)
        cols = _pick_cols(rng, table, rng.randint(1, 4))
        col_str = ", ".join(cols)
        limit = rng.randint(10, 1000)
        sql = f"SELECT {col_str} FROM {table} LIMIT {limit}"
        queries.append({
            "sql": sql,
            "category": "basic_select",
            "expected_positive": [],
            "expected_negative": ALL_RULES[:],
        })
    return queries


def gen_equality_filters(rng: random.Random, count: int) -> list[dict]:
    """WHERE col = value with specific columns."""
    queries = []
    for _ in range(count):
        table = _pick_table(rng)
        cols = _pick_cols(rng, table, rng.randint(2, 4))
        col_str = ", ".join(cols)
        filter_col = rng.choice(TABLE_COLS[table])
        if filter_col in (NUMERIC_COLS.get(table, []) + ["id"]):
            val = str(rng.randint(1, 10000))
        else:
            val = f"'{rng.choice(['active', 'pending', 'completed', 'test', 'us'])}'"
        limit = rng.randint(10, 500)
        sql = f"SELECT {col_str} FROM {table} WHERE {filter_col} = {val} LIMIT {limit}"
        queries.append({
            "sql": sql,
            "category": "equality_filter",
            "expected_positive": [],
            "expected_negative": ALL_RULES[:],
        })
    return queries


def gen_range_filters(rng: random.Random, count: int) -> list[dict]:
    """WHERE col BETWEEN / > / < with specific columns."""
    queries = []
    tables_with_nums = [t for t in TABLES if NUMERIC_COLS.get(t)]
    for _ in range(count):
        table = rng.choice(tables_with_nums)
        cols = _pick_cols(rng, table, rng.randint(2, 4))
        col_str = ", ".join(cols)
        num_col = rng.choice(NUMERIC_COLS[table])
        op = rng.choice(["BETWEEN", ">", "<", ">=", "<="])
        if op == "BETWEEN":
            lo = rng.randint(1, 500)
            hi = lo + rng.randint(10, 500)
            where = f"{num_col} BETWEEN {lo} AND {hi}"
        else:
            val = rng.randint(1, 1000)
            where = f"{num_col} {op} {val}"
        limit = rng.randint(10, 500)
        sql = f"SELECT {col_str} FROM {table} WHERE {where} LIMIT {limit}"
        queries.append({
            "sql": sql,
            "category": "range_filter",
            "expected_positive": [],
            "expected_negative": ALL_RULES[:],
        })
    return queries


def gen_null_filters(rng: random.Random, count: int) -> list[dict]:
    """WHERE col IS NULL / IS NOT NULL."""
    queries = []
    for _ in range(count):
        table = _pick_table(rng)
        cols = _pick_cols(rng, table, rng.randint(2, 3))
        col_str = ", ".join(cols)
        filter_col = rng.choice(TABLE_COLS[table])
        null_type = rng.choice(["IS NULL", "IS NOT NULL"])
        limit = rng.randint(10, 500)
        sql = f"SELECT {col_str} FROM {table} WHERE {filter_col} {null_type} LIMIT {limit}"
        queries.append({
            "sql": sql,
            "category": "null_filter",
            "expected_positive": [],
            "expected_negative": ALL_RULES[:],
        })
    return queries


def gen_like_filters(rng: random.Random, count: int) -> list[dict]:
    """WHERE col LIKE '%pattern%' — some with leading wildcard, some without."""
    queries = []
    tables_with_strs = [t for t in TABLES if STRING_COLS.get(t)]
    patterns_leading = ["%test%", "%admin%", "%error%", "_prefix%", "%user%"]
    patterns_trailing = ["test%", "admin%", "completed%", "active%", "us%"]
    for _ in range(count):
        table = rng.choice(tables_with_strs)
        str_col = rng.choice(STRING_COLS[table])
        cols = _pick_cols(rng, table, rng.randint(2, 3))
        col_str = ", ".join(cols)
        use_leading = rng.random() < 0.6
        if use_leading:
            pattern = rng.choice(patterns_leading)
            expected_pos = ["LIKE_LEADING_WILDCARD"]
        else:
            pattern = rng.choice(patterns_trailing)
            expected_pos = []
        # These queries have LIMIT so no MISSING_LIMIT
        limit = rng.randint(10, 200)
        sql = f"SELECT {col_str} FROM {table} WHERE {str_col} LIKE '{pattern}' LIMIT {limit}"
        neg = [r for r in ALL_RULES if r not in expected_pos]
        queries.append({
            "sql": sql,
            "category": "like_filter",
            "expected_positive": expected_pos,
            "expected_negative": neg,
        })
    return queries


def gen_in_list(rng: random.Random, count: int) -> list[dict]:
    """WHERE col IN (...) — some large, some small."""
    queries = []
    for _ in range(count):
        table = _pick_table(rng)
        cols = _pick_cols(rng, table, rng.randint(2, 3))
        col_str = ", ".join(cols)
        filter_col = rng.choice(TABLE_COLS[table])
        # 20% chance of large IN list (>50)
        if rng.random() < 0.2:
            n_vals = rng.randint(51, 100)
            expected_pos = ["LARGE_IN_LIST"]
        else:
            n_vals = rng.randint(2, 15)
            expected_pos = []
        vals = ", ".join(str(rng.randint(1, 10000)) for _ in range(n_vals))
        limit = rng.randint(10, 500)
        sql = f"SELECT {col_str} FROM {table} WHERE {filter_col} IN ({vals}) LIMIT {limit}"
        neg = [r for r in ALL_RULES if r not in expected_pos]
        queries.append({
            "sql": sql,
            "category": "in_list",
            "expected_positive": expected_pos,
            "expected_negative": neg,
        })
    return queries


def gen_joins_2table(rng: random.Random, count: int) -> list[dict]:
    """Simple 2-table JOINs with equality conditions."""
    queries = []
    for _ in range(count):
        t1, t2, cond = _pick_join_pair(rng)
        cols1 = _pick_cols(rng, t1, rng.randint(1, 3))
        cols2 = _pick_cols(rng, t2, rng.randint(1, 2))
        col_str = ", ".join(f"{t1}.{c}" for c in cols1) + ", " + ", ".join(f"{t2}.{c}" for c in cols2)
        limit = rng.randint(10, 500)
        sql = f"SELECT {col_str} FROM {t1} JOIN {t2} ON {cond} LIMIT {limit}"
        queries.append({
            "sql": sql,
            "category": "join_2table",
            "expected_positive": [],
            "expected_negative": ALL_RULES[:],
        })
    return queries


def gen_joins_3plus(rng: random.Random, count: int) -> list[dict]:
    """Multi-table JOINs (3+ tables)."""
    queries = []
    # Pre-defined 3-table join chains
    chains = [
        [("users", "orders", "users.id = orders.user_id"),
         ("orders", "items", "orders.id = items.order_id")],
        [("users", "orders", "users.id = orders.user_id"),
         ("orders", "payments", "orders.id = payments.order_id")],
        [("products", "items", "products.id = items.product_id"),
         ("items", "orders", "items.order_id = orders.id")],
        [("users", "reviews", "users.id = reviews.user_id"),
         ("reviews", "products", "reviews.product_id = products.id")],
        [("products", "inventory", "products.id = inventory.product_id"),
         ("products", "categories", "products.category_id = categories.id")],
    ]
    for _ in range(count):
        chain = rng.choice(chains)
        t1 = chain[0][0]
        cols = [f"{t1}.id", f"{t1}.{rng.choice(TABLE_COLS[t1][1:])}"]
        join_clauses = []
        for _, t2, cond in chain:
            join_clauses.append(f"JOIN {t2} ON {cond}")
            cols.append(f"{t2}.{rng.choice(TABLE_COLS[t2][1:])}")
        col_str = ", ".join(cols)
        joins = " ".join(join_clauses)
        limit = rng.randint(10, 500)
        sql = f"SELECT {col_str} FROM {t1} {joins} LIMIT {limit}"
        queries.append({
            "sql": sql,
            "category": "join_3plus",
            "expected_positive": [],
            "expected_negative": ALL_RULES[:],
        })
    return queries


def gen_aggregations(rng: random.Random, count: int) -> list[dict]:
    """GROUP BY queries with aggregation functions."""
    queries = []
    for _ in range(count):
        table = _pick_table(rng)
        group_col = rng.choice([c for c in TABLE_COLS[table] if c != "id"])
        agg_func = rng.choice(AGG_FUNCS)
        agg_col = rng.choice(TABLE_COLS[table])
        if agg_func in ("SUM", "AVG"):
            nums = NUMERIC_COLS.get(table, [])
            if nums:
                agg_col = rng.choice(nums)
            else:
                agg_func = "COUNT"

        expected_pos = []
        # GROUP_BY_PRIMARY_KEY fires when grouping by 'id' or '*_id' columns
        if group_col == "id" or group_col.endswith("_id"):
            expected_pos.append("GROUP_BY_PRIMARY_KEY")

        sql = f"SELECT {group_col}, {agg_func}({agg_col}) AS agg_val FROM {table} GROUP BY {group_col}"
        neg = [r for r in ALL_RULES if r not in expected_pos]
        queries.append({
            "sql": sql,
            "category": "aggregation",
            "expected_positive": expected_pos,
            "expected_negative": neg,
        })
    return queries


def gen_window_functions(rng: random.Random, count: int) -> list[dict]:
    """Window function queries — some with PARTITION BY, some without."""
    queries = []
    for _ in range(count):
        table = _pick_table(rng)
        cols = _pick_cols(rng, table, rng.randint(2, 3))
        col_str = ", ".join(cols)
        win_func = rng.choice(WINDOW_FUNCS)
        order_col = rng.choice(TABLE_COLS[table])
        use_partition = rng.random() < 0.5
        expected_pos = []

        if win_func in ("LAG", "LEAD"):
            func_expr = f"{win_func}({rng.choice(cols)})"
        elif win_func == "NTILE":
            func_expr = f"NTILE({rng.randint(2, 10)})"
        else:
            func_expr = f"{win_func}()"

        if use_partition:
            part_col = rng.choice([c for c in TABLE_COLS[table] if c != order_col])
            window_clause = f"OVER (PARTITION BY {part_col} ORDER BY {order_col})"
        else:
            window_clause = f"OVER (ORDER BY {order_col})"
            expected_pos.append("WINDOW_WITHOUT_PARTITION")

        limit = rng.randint(10, 500)
        sql = f"SELECT {col_str}, {func_expr} {window_clause} AS win_val FROM {table} LIMIT {limit}"
        neg = [r for r in ALL_RULES if r not in expected_pos]
        queries.append({
            "sql": sql,
            "category": "window_function",
            "expected_positive": expected_pos,
            "expected_negative": neg,
        })
    return queries


def gen_subqueries(rng: random.Random, count: int) -> list[dict]:
    """Subqueries — correlated and uncorrelated, with and without SELECT *."""
    queries = []
    for _ in range(count):
        variant = rng.choice(["uncorrelated", "correlated", "in_subquery", "exists_subquery"])
        expected_pos = []

        if variant == "uncorrelated":
            t1 = "orders"
            t2 = "users"
            cols = _pick_cols(rng, t1, 2)
            col_str = ", ".join(cols)
            inner_col = "id"
            # Use specific column in subquery (no SELECT *)
            sql = f"SELECT {col_str} FROM {t1} WHERE user_id IN (SELECT {inner_col} FROM {t2} WHERE status = 'active') LIMIT 100"

        elif variant == "correlated":
            t1 = "orders"
            t2 = "users"
            cols = _pick_cols(rng, t1, 2)
            col_str = ", ".join(f"{t1}.{c}" for c in cols)
            sql = (
                f"SELECT {col_str} FROM {t1} "
                f"WHERE EXISTS (SELECT 1 FROM {t2} WHERE {t2}.id = {t1}.user_id AND {t2}.status = 'active') "
                f"LIMIT 100"
            )
            expected_pos.append("CORRELATED_SUBQUERY")

        elif variant == "in_subquery":
            t1 = "products"
            t2 = "items"
            cols = _pick_cols(rng, t1, 2)
            col_str = ", ".join(cols)
            # Use SELECT * in subquery to trigger SELECT_STAR_IN_SUBQUERY
            use_star = rng.random() < 0.5
            if use_star:
                inner_select = "*"
                expected_pos.append("SELECT_STAR_IN_SUBQUERY")
                # SELECT * in the subquery also fires SELECT_STAR
                expected_pos.append("SELECT_STAR")
            else:
                inner_select = "product_id"
            sql = f"SELECT {col_str} FROM {t1} WHERE id IN (SELECT {inner_select} FROM {t2} WHERE quantity > 5) LIMIT 100"

        else:  # exists_subquery
            t1 = "users"
            t2 = "orders"
            cols = _pick_cols(rng, t1, 2)
            col_str = ", ".join(f"{t1}.{c}" for c in cols)
            sql = (
                f"SELECT {col_str} FROM {t1} "
                f"WHERE EXISTS (SELECT 1 FROM {t2} WHERE {t2}.user_id = {t1}.id AND {t2}.total > 100) "
                f"LIMIT 100"
            )
            expected_pos.append("CORRELATED_SUBQUERY")

        neg = [r for r in ALL_RULES if r not in expected_pos]
        queries.append({
            "sql": sql,
            "category": "subquery",
            "expected_positive": expected_pos,
            "expected_negative": neg,
        })
    return queries


def gen_ctes(rng: random.Random, count: int) -> list[dict]:
    """CTE queries — some with unused CTEs."""
    queries = []
    for _ in range(count):
        use_unused = rng.random() < 0.3
        expected_pos = []

        if use_unused:
            # Define two CTEs but only reference one
            sql = (
                "WITH active_users AS (SELECT id, name FROM users WHERE status = 'active'), "
                "recent_orders AS (SELECT id, user_id, total FROM orders WHERE created_at > '2024-01-01') "
                "SELECT id, name FROM active_users LIMIT 100"
            )
            expected_pos.append("UNUSED_CTE")
        else:
            # All CTEs referenced
            variant = rng.choice(["single", "chained"])
            if variant == "single":
                table = _pick_table(rng)
                cols = _pick_cols(rng, table, rng.randint(2, 3))
                col_str = ", ".join(cols)
                cte_cols = ", ".join(cols)
                sql = (
                    f"WITH filtered AS (SELECT {cte_cols} FROM {table} WHERE {TABLE_COLS[table][0]} IS NOT NULL) "
                    f"SELECT {col_str} FROM filtered LIMIT 100"
                )
            else:
                sql = (
                    "WITH user_orders AS ("
                    "SELECT users.id AS uid, users.name, orders.total "
                    "FROM users JOIN orders ON users.id = orders.user_id"
                    "), "
                    "high_value AS ("
                    "SELECT uid, name, total FROM user_orders WHERE total > 1000"
                    ") "
                    "SELECT name, total FROM high_value LIMIT 50"
                )

        neg = [r for r in ALL_RULES if r not in expected_pos]
        queries.append({
            "sql": sql,
            "category": "cte",
            "expected_positive": expected_pos,
            "expected_negative": neg,
        })
    return queries


def gen_set_operations(rng: random.Random, count: int) -> list[dict]:
    """UNION, UNION ALL, INTERSECT, EXCEPT queries."""
    queries = []
    for _ in range(count):
        op = rng.choice(["UNION", "UNION ALL", "INTERSECT", "EXCEPT"])
        table1 = "users"
        table2 = "users"
        cols = ["id", "name", "email"]
        col_str = ", ".join(cols)
        expected_pos = []

        # UNION (not ALL) triggers UNION_INSTEAD_OF_UNION_ALL
        if op == "UNION":
            expected_pos.append("UNION_INSTEAD_OF_UNION_ALL")

        sql = f"SELECT {col_str} FROM {table1} WHERE status = 'active' {op} SELECT {col_str} FROM {table2} WHERE status = 'pending'"
        neg = [r for r in ALL_RULES if r not in expected_pos]
        queries.append({
            "sql": sql,
            "category": "set_operation",
            "expected_positive": expected_pos,
            "expected_negative": neg,
        })
    return queries


def gen_complex(rng: random.Random, count: int) -> list[dict]:
    """Complex queries combining multiple patterns."""
    queries = []
    for _ in range(count):
        variant = rng.choice([
            "select_star_no_limit",
            "order_by_no_limit",
            "select_star_order_no_limit",
            "join_with_function",
            "not_in_subquery",
            "or_in_join",
            "non_equi_join",
            "order_by_in_subquery",
            "correlated_with_star",
            "cte_with_window",
        ])
        expected_pos = []

        if variant == "select_star_no_limit":
            table = _pick_table(rng)
            sql = f"SELECT * FROM {table}"
            expected_pos = ["SELECT_STAR", "MISSING_LIMIT"]

        elif variant == "order_by_no_limit":
            table = _pick_table(rng)
            cols = _pick_cols(rng, table, 3)
            col_str = ", ".join(cols)
            order_col = rng.choice(cols)
            sql = f"SELECT {col_str} FROM {table} ORDER BY {order_col}"
            expected_pos = ["ORDER_BY_WITHOUT_LIMIT", "MISSING_LIMIT"]

        elif variant == "select_star_order_no_limit":
            table = _pick_table(rng)
            order_col = rng.choice(TABLE_COLS[table])
            sql = f"SELECT * FROM {table} ORDER BY {order_col}"
            expected_pos = ["SELECT_STAR", "ORDER_BY_WITHOUT_LIMIT", "MISSING_LIMIT"]

        elif variant == "join_with_function":
            t1, t2, _ = _pick_join_pair(rng)
            cols1 = _pick_cols(rng, t1, 2)
            col_str = ", ".join(f"{t1}.{c}" for c in cols1)
            # Use UPPER() on a column in join condition
            join_col_t1 = rng.choice([c for c in TABLE_COLS[t1] if c != "id"])
            join_col_t2 = rng.choice([c for c in TABLE_COLS[t2] if c != "id"])
            sql = f"SELECT {col_str} FROM {t1} JOIN {t2} ON UPPER({t1}.{join_col_t1}) = UPPER({t2}.{join_col_t2}) LIMIT 100"
            expected_pos = ["FUNCTION_IN_JOIN"]

        elif variant == "not_in_subquery":
            sql = (
                "SELECT id, name FROM users "
                "WHERE id NOT IN (SELECT user_id FROM orders WHERE status = 'completed') "
                "LIMIT 100"
            )
            expected_pos = ["NOT_IN_WITH_SUBQUERY"]

        elif variant == "or_in_join":
            sql = (
                "SELECT users.id, users.name, orders.total "
                "FROM users "
                "JOIN orders ON users.id = orders.user_id OR users.email = orders.status "
                "LIMIT 100"
            )
            expected_pos = ["OR_IN_JOIN"]

        elif variant == "non_equi_join":
            sql = (
                "SELECT e.id, e.event_type, s.device "
                "FROM events e "
                "JOIN sessions s ON e.created_at > s.started_at AND e.created_at < s.ended_at "
                "LIMIT 100"
            )
            expected_pos = ["NON_EQUI_JOIN"]

        elif variant == "order_by_in_subquery":
            sql = (
                "SELECT id, name FROM users "
                "WHERE id IN (SELECT user_id FROM orders ORDER BY total DESC) "
                "LIMIT 100"
            )
            # The subquery is inside an IN, which wraps it in a Subquery node
            # ORDER BY in subquery without LIMIT fires the rule
            expected_pos = ["ORDER_BY_IN_SUBQUERY"]

        elif variant == "correlated_with_star":
            sql = (
                "SELECT * FROM users u "
                "WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id) "
                "LIMIT 100"
            )
            expected_pos = ["SELECT_STAR", "CORRELATED_SUBQUERY"]

        elif variant == "cte_with_window":
            sql = (
                "WITH ranked AS ("
                "SELECT id, name, ROW_NUMBER() OVER (ORDER BY created_at DESC) AS rn "
                "FROM users"
                ") "
                "SELECT id, name FROM ranked WHERE rn <= 10"
            )
            expected_pos = ["WINDOW_WITHOUT_PARTITION"]
            # The CTE inner select has no LIMIT but has ROW_NUMBER (not aggregation),
            # however it's inside a CTE so MISSING_LIMIT applies to the outer query
            # The outer has a WHERE but no LIMIT, no agg, no group_by -> MISSING_LIMIT
            expected_pos.append("MISSING_LIMIT")

        neg = [r for r in ALL_RULES if r not in expected_pos]
        queries.append({
            "sql": sql,
            "category": "complex",
            "expected_positive": expected_pos,
            "expected_negative": neg,
        })
    return queries


def gen_partition_pruning(rng: random.Random, count: int) -> list[dict]:
    """Queries that test function-in-filter detection for partition pruning."""
    queries = []
    tables_with_dates = [t for t in TABLES if DATE_COLS.get(t)]
    for _ in range(count):
        use_function = rng.random() < 0.6
        table = rng.choice(tables_with_dates)
        date_col = rng.choice(DATE_COLS[table])
        cols = _pick_cols(rng, table, rng.randint(2, 3))
        col_str = ", ".join(cols)
        expected_pos = []
        limit = rng.randint(10, 500)

        if use_function:
            # Apply function on column in WHERE — should trigger FUNCTION_IN_FILTER
            func = rng.choice(["DATE_TRUNC('month', {col})", "YEAR({col})", "MONTH({col})", "TO_CHAR({col}, 'YYYY-MM')"])
            func_expr = func.format(col=date_col)
            if "DATE_TRUNC" in func:
                compare_val = "'2024-01-01'"
            elif "YEAR" in func:
                compare_val = "2024"
            elif "MONTH" in func:
                compare_val = "1"
            else:
                compare_val = "'2024-01'"
            sql = f"SELECT {col_str} FROM {table} WHERE {func_expr} = {compare_val} LIMIT {limit}"
            expected_pos.append("FUNCTION_IN_FILTER")
        else:
            # Direct comparison — no function on column
            sql = f"SELECT {col_str} FROM {table} WHERE {date_col} >= '2024-01-01' AND {date_col} < '2024-02-01' LIMIT {limit}"

        neg = [r for r in ALL_RULES if r not in expected_pos]
        queries.append({
            "sql": sql,
            "category": "partition_pruning",
            "expected_positive": expected_pos,
            "expected_negative": neg,
        })
    return queries


def gen_column_pruning(rng: random.Random, count: int) -> list[dict]:
    """SELECT * vs specific columns to test SELECT_STAR detection."""
    queries = []
    for _ in range(count):
        table = _pick_table(rng)
        use_star = rng.random() < 0.5
        expected_pos = []
        limit = rng.randint(10, 500)

        if use_star:
            sql = f"SELECT * FROM {table} LIMIT {limit}"
            expected_pos.append("SELECT_STAR")
        else:
            cols = _pick_cols(rng, table, rng.randint(2, 4))
            col_str = ", ".join(cols)
            sql = f"SELECT {col_str} FROM {table} LIMIT {limit}"

        neg = [r for r in ALL_RULES if r not in expected_pos]
        queries.append({
            "sql": sql,
            "category": "column_pruning",
            "expected_positive": expected_pos,
            "expected_negative": neg,
        })
    return queries


def gen_metadata_aggs(rng: random.Random, count: int) -> list[dict]:
    """Queries on information_schema — typically small tables."""
    queries = []
    info_views = ["information_schema.tables", "information_schema.columns", "information_schema.schemata"]
    for _ in range(count):
        view = rng.choice(info_views)
        if "tables" in view:
            sql = f"SELECT table_schema, table_name, table_type FROM {view} WHERE table_schema = 'public'"
        elif "columns" in view:
            sql = f"SELECT table_name, column_name, data_type FROM {view} WHERE table_name = 'users'"
        else:
            sql = f"SELECT schema_name FROM {view}"
        # These all have no LIMIT, no agg, no group by -> MISSING_LIMIT
        expected_pos = ["MISSING_LIMIT"]
        neg = [r for r in ALL_RULES if r not in expected_pos]
        queries.append({
            "sql": sql,
            "category": "metadata_agg",
            "expected_positive": expected_pos,
            "expected_negative": neg,
        })
    return queries


def gen_cross_joins(rng: random.Random, count: int) -> list[dict]:
    """Explicit CROSS JOIN and implicit cartesian product queries."""
    queries = []
    for _ in range(count):
        variant = rng.choice(["explicit_cross", "implicit_cartesian"])
        expected_pos = []

        if variant == "explicit_cross":
            t1 = rng.choice(["users", "products"])
            t2 = rng.choice(["categories", "inventory"])
            cols = [f"{t1}.id", f"{t2}.id"]
            col_str = ", ".join(cols)
            sql = f"SELECT {col_str} FROM {t1} CROSS JOIN {t2} LIMIT 100"
            expected_pos.append("CARTESIAN_PRODUCT")
        else:
            t1 = "users"
            t2 = "products"
            sql = f"SELECT {t1}.id, {t2}.id FROM {t1}, {t2} LIMIT 100"
            # Multiple tables in FROM without JOIN and without WHERE -> IMPLICIT_CARTESIAN
            # Note: the analyzer checks len(tables_in_from) > 1 and len(joins) == 0 and no WHERE
            # But sqlglot may parse "FROM t1, t2" differently. The comma-join in sqlglot
            # typically parses as Join nodes, so IMPLICIT_CARTESIAN may not fire.
            # We still annotate it, and the benchmark will reveal the actual behavior.
            expected_pos.append("IMPLICIT_CARTESIAN")

        # Both variants have LIMIT so no MISSING_LIMIT
        neg = [r for r in ALL_RULES if r not in expected_pos]
        queries.append({
            "sql": sql,
            "category": "cross_join",
            "expected_positive": expected_pos,
            "expected_negative": neg,
        })
    return queries


# ---------------------------------------------------------------------------
# Main generation pipeline
# ---------------------------------------------------------------------------

CATEGORY_CONFIG = [
    ("basic_select", gen_basic_select, 50),
    ("equality_filter", gen_equality_filters, 150),
    ("range_filter", gen_range_filters, 100),
    ("null_filter", gen_null_filters, 30),
    ("like_filter", gen_like_filters, 40),
    ("in_list", gen_in_list, 50),
    ("join_2table", gen_joins_2table, 80),
    ("join_3plus", gen_joins_3plus, 40),
    ("aggregation", gen_aggregations, 80),
    ("window_function", gen_window_functions, 60),
    ("subquery", gen_subqueries, 50),
    ("cte", gen_ctes, 40),
    ("set_operation", gen_set_operations, 40),
    ("complex", gen_complex, 80),
    ("partition_pruning", gen_partition_pruning, 50),
    ("column_pruning", gen_column_pruning, 50),
    ("metadata_agg", gen_metadata_aggs, 20),
    ("cross_join", gen_cross_joins, 30),
]


def generate_all(count: int, seed: int) -> list[dict[str, Any]]:
    """Generate all queries across all categories.

    Args:
        count: Target total query count (categories scale proportionally).
        seed: Random seed for reproducibility.

    Returns:
        List of query dicts with sql, category, expected_positive, expected_negative.
    """
    rng = random.Random(seed)
    all_queries = []

    for name, gen_func, base_count in CATEGORY_CONFIG:
        scaled = _scale(base_count, count)
        queries = gen_func(rng, scaled)
        all_queries.extend(queries)

    # Add a sequential ID to each query
    for i, q in enumerate(all_queries):
        q["id"] = i

    return all_queries


def main():
    parser = argparse.ArgumentParser(description="Generate SQL queries for analyzer validation")
    parser.add_argument("--count", type=int, default=1000, help="Target total query count (default: 1000)")
    parser.add_argument("--seed", type=int, default=42, help="Random seed (default: 42)")
    parser.add_argument("--output", type=str, default="queries.json", help="Output file path (default: queries.json)")
    args = parser.parse_args()

    queries = generate_all(args.count, args.seed)

    with open(args.output, "w") as f:
        json.dump(queries, f, indent=2)

    # Print summary
    from collections import Counter
    cats = Counter(q["category"] for q in queries)
    print(f"Generated {len(queries)} queries to {args.output}")
    print(f"Seed: {args.seed}")
    print(f"\nCategory breakdown:")
    for cat, cnt in sorted(cats.items()):
        print(f"  {cat}: {cnt}")

    # Count expected positives
    pos_counts = Counter()
    for q in queries:
        for rule in q["expected_positive"]:
            pos_counts[rule] += 1
    if pos_counts:
        print(f"\nExpected positive annotations:")
        for rule, cnt in sorted(pos_counts.items()):
            print(f"  {rule}: {cnt}")


if __name__ == "__main__":
    main()
