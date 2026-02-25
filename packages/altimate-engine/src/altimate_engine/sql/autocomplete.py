"""SQL auto-complete — schema-aware table/column suggestions from cache."""

from __future__ import annotations

from altimate_engine.schema.cache import SchemaCache


def autocomplete_sql(
    prefix: str,
    position: str = "column",
    warehouse: str | None = None,
    table_context: list[str] | None = None,
    limit: int = 20,
    cache: SchemaCache | None = None,
) -> dict:
    """Provide schema-aware auto-complete suggestions.

    Args:
        prefix: Partial text typed by the user (e.g., "cust", "order_d")
        position: Context hint — "table", "column", "schema", or "any"
        warehouse: Limit suggestions to a specific warehouse
        table_context: Tables currently in the query (for column suggestions)
        limit: Max suggestions to return
        cache: SchemaCache instance (uses default if not provided)

    Returns:
        Dict with suggestions list and metadata.
    """
    if cache is None:
        cache = SchemaCache()

    prefix_lower = prefix.lower().strip()
    if not prefix_lower:
        return {
            "suggestions": [],
            "prefix": prefix,
            "position": position,
            "suggestion_count": 0,
        }

    suggestions: list[dict] = []

    if position in ("table", "any"):
        table_suggestions = _suggest_tables(cache, prefix_lower, warehouse, limit)
        suggestions.extend(table_suggestions)

    if position in ("column", "any"):
        col_suggestions = _suggest_columns(
            cache, prefix_lower, warehouse, table_context, limit
        )
        suggestions.extend(col_suggestions)

    if position in ("schema", "any"):
        schema_suggestions = _suggest_schemas(cache, prefix_lower, warehouse, limit)
        suggestions.extend(schema_suggestions)

    # Sort by relevance: exact prefix match first, then alphabetical
    suggestions.sort(key=lambda s: (
        0 if s["name"].lower().startswith(prefix_lower) else 1,
        s["name"].lower(),
    ))

    suggestions = suggestions[:limit]

    return {
        "suggestions": suggestions,
        "prefix": prefix,
        "position": position,
        "suggestion_count": len(suggestions),
    }


def _suggest_tables(
    cache: SchemaCache, prefix: str, warehouse: str | None, limit: int
) -> list[dict]:
    """Suggest table names matching the prefix."""
    result = cache.search(prefix, warehouse=warehouse, limit=limit)
    suggestions = []
    for t in result.get("tables", []):
        name = t["name"]
        if name.lower().startswith(prefix) or prefix in name.lower():
            suggestions.append({
                "name": name,
                "type": "table",
                "detail": t.get("type", "TABLE"),
                "fqn": t["fqn"],
                "warehouse": t["warehouse"],
            })
    return suggestions


def _suggest_columns(
    cache: SchemaCache,
    prefix: str,
    warehouse: str | None,
    table_context: list[str] | None,
    limit: int,
) -> list[dict]:
    """Suggest column names matching the prefix.

    If table_context is provided, prioritize columns from those tables.
    """
    result = cache.search(prefix, warehouse=warehouse, limit=limit * 2)
    suggestions = []
    context_tables = set(t.lower() for t in (table_context or []))

    for c in result.get("columns", []):
        name = c["name"]
        if name.lower().startswith(prefix) or prefix in name.lower():
            # Boost relevance if column is in a context table
            in_context = c.get("table", "").lower() in context_tables if context_tables else False
            suggestions.append({
                "name": name,
                "type": "column",
                "detail": c.get("data_type", ""),
                "table": c.get("table", ""),
                "fqn": c["fqn"],
                "warehouse": c["warehouse"],
                "in_context": in_context,
            })

    # Sort: context columns first
    suggestions.sort(key=lambda s: (0 if s.get("in_context") else 1, s["name"].lower()))
    return suggestions[:limit]


def _suggest_schemas(
    cache: SchemaCache, prefix: str, warehouse: str | None, limit: int
) -> list[dict]:
    """Suggest schema names matching the prefix."""
    # Use the cache's internal DB to query distinct schemas
    conn = cache._conn
    params = [f"%{prefix}%"]
    wh_filter = ""
    if warehouse:
        wh_filter = " AND warehouse = ?"
        params.append(warehouse)

    rows = conn.execute(
        f"SELECT DISTINCT warehouse, schema_name FROM tables_cache WHERE LOWER(schema_name) LIKE ? {wh_filter} ORDER BY schema_name LIMIT ?",
        params + [limit],
    ).fetchall()

    return [
        {
            "name": row["schema_name"],
            "type": "schema",
            "detail": "SCHEMA",
            "warehouse": row["warehouse"],
        }
        for row in rows
    ]
