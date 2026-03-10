"""Persistent cache for concepts, patterns, and table schemas.

Cache files are stored at ~/.astro/ai/cache/:
- concepts.json: concept → table mapping (e.g., "customers" → "HQ.MODEL.ORGS")
- patterns.json: question type → query strategy
- tables.json: table schema cache (columns, types, row counts)
"""

import json
from datetime import datetime, timedelta
from pathlib import Path

CACHE_DIR = Path.home() / ".astro" / "ai" / "cache"

# Default TTL for cache entries
DEFAULT_TTL_DAYS = 90


def _ensure_cache_dir():
    CACHE_DIR.mkdir(parents=True, exist_ok=True)


def _load_json(filename: str) -> dict:
    path = CACHE_DIR / filename
    if path.exists():
        return json.loads(path.read_text())
    return {}


def _save_json(filename: str, data: dict):
    _ensure_cache_dir()
    path = CACHE_DIR / filename
    path.write_text(json.dumps(data, indent=2, default=str))


# --- Concept Cache ---


def lookup_concept(concept: str) -> dict | None:
    """Look up a concept (e.g., 'customers') to find its table."""
    concepts = _load_json("concepts.json")
    return concepts.get(concept.lower().strip())


def learn_concept(
    concept: str,
    table: str,
    key_column: str | None = None,
    date_column: str | None = None,
):
    """Store a concept -> table mapping for future use."""
    concepts = _load_json("concepts.json")
    concepts[concept.lower().strip()] = {
        "table": table,
        "key_column": key_column,
        "date_column": date_column,
        "learned_at": datetime.now().isoformat(),
    }
    _save_json("concepts.json", concepts)
    return concepts[concept.lower().strip()]


def list_concepts() -> dict:
    """List all learned concepts."""
    return _load_json("concepts.json")


# --- Pattern Cache ---


def lookup_pattern(question: str) -> list[dict]:
    """Find patterns that match a question. Returns list of matching patterns."""
    patterns = _load_json("patterns.json")
    question_lower = question.lower()
    matches = []
    for name, pattern in patterns.items():
        for qtype in pattern.get("question_types", []):
            keywords = qtype.lower().replace("x", "").split()
            if all(kw in question_lower for kw in keywords if len(kw) > 2):
                matches.append({"name": name, **pattern})
                break
    return sorted(matches, key=lambda p: p.get("success_count", 0), reverse=True)


def learn_pattern(
    name: str,
    question_types: list[str],
    strategy: list[str],
    tables_used: list[str],
    gotchas: list[str],
    example_query: str | None = None,
):
    """Store a query pattern/strategy for a type of question."""
    patterns = _load_json("patterns.json")
    patterns[name.lower().strip()] = {
        "question_types": question_types,
        "strategy": strategy,
        "tables_used": tables_used,
        "gotchas": gotchas,
        "example_query": example_query,
        "created_at": datetime.now().isoformat(),
        "success_count": 1,
        "failure_count": 0,
    }
    _save_json("patterns.json", patterns)
    return patterns[name.lower().strip()]


def record_pattern_outcome(name: str, success: bool):
    """Record whether a pattern helped or failed."""
    patterns = _load_json("patterns.json")
    key = name.lower().strip()
    if key in patterns:
        if success:
            patterns[key]["success_count"] = patterns[key].get("success_count", 0) + 1
        else:
            patterns[key]["failure_count"] = patterns[key].get("failure_count", 0) + 1
        _save_json("patterns.json", patterns)
        return patterns[key]
    return None


def list_patterns() -> dict:
    """List all learned patterns."""
    return _load_json("patterns.json")


def delete_pattern(name: str) -> bool:
    """Delete a pattern by name. Returns True if it existed."""
    patterns = _load_json("patterns.json")
    key = name.lower().strip()
    if key in patterns:
        del patterns[key]
        _save_json("patterns.json", patterns)
        return True
    return False


# --- Cache Management ---


def _is_stale(learned_at: str, ttl_days: int = DEFAULT_TTL_DAYS) -> bool:
    """Check if an entry is older than TTL."""
    try:
        learned = datetime.fromisoformat(learned_at)
        return datetime.now() - learned > timedelta(days=ttl_days)
    except (ValueError, TypeError):
        return False


def cache_stats() -> dict:
    """Get cache statistics."""
    concepts = _load_json("concepts.json")
    patterns = _load_json("patterns.json")

    stale_concepts = sum(
        1 for c in concepts.values() if _is_stale(c.get("learned_at", ""))
    )
    stale_patterns = sum(
        1 for p in patterns.values() if _is_stale(p.get("created_at", ""))
    )

    return {
        "concepts_count": len(concepts),
        "patterns_count": len(patterns),
        "stale_concepts": stale_concepts,
        "stale_patterns": stale_patterns,
        "cache_dir": str(CACHE_DIR),
        "ttl_days": DEFAULT_TTL_DAYS,
    }


def clear_cache(cache_type: str = "all", purge_stale_only: bool = False) -> dict:
    """Clear cache entries.

    Args:
        cache_type: "all", "concepts", or "patterns"
        purge_stale_only: If True, only remove entries older than TTL

    Returns:
        Summary of what was cleared
    """
    result = {"concepts_cleared": 0, "patterns_cleared": 0}

    if cache_type in ("all", "concepts"):
        concepts = _load_json("concepts.json")
        if purge_stale_only:
            original = len(concepts)
            concepts = {
                k: v
                for k, v in concepts.items()
                if not _is_stale(v.get("learned_at", ""))
            }
            result["concepts_cleared"] = original - len(concepts)
            _save_json("concepts.json", concepts)
        else:
            result["concepts_cleared"] = len(concepts)
            _save_json("concepts.json", {})

    if cache_type in ("all", "patterns"):
        patterns = _load_json("patterns.json")
        if purge_stale_only:
            original = len(patterns)
            patterns = {
                k: v
                for k, v in patterns.items()
                if not _is_stale(v.get("created_at", ""))
            }
            result["patterns_cleared"] = original - len(patterns)
            _save_json("patterns.json", patterns)
        else:
            result["patterns_cleared"] = len(patterns)
            _save_json("patterns.json", {})

    return result


# --- Table Schema Cache ---


def get_table(full_name: str) -> dict | None:
    """Get cached table schema by full name (DATABASE.SCHEMA.TABLE)."""
    tables = _load_json("tables.json")
    return tables.get(full_name.upper())


def set_table(
    full_name: str,
    columns: list[dict],
    row_count: int | None = None,
    comment: str | None = None,
) -> dict:
    """Cache a table's schema.

    Args:
        full_name: Full table name (DATABASE.SCHEMA.TABLE)
        columns: List of column dicts [{name, type, nullable, comment}, ...]
        row_count: Optional row count
        comment: Optional table description

    Returns:
        The cached table entry
    """
    tables = _load_json("tables.json")
    entry = {
        "full_name": full_name.upper(),
        "columns": columns,
        "row_count": row_count,
        "comment": comment,
        "cached_at": datetime.now().isoformat(),
    }
    tables[full_name.upper()] = entry
    _save_json("tables.json", tables)
    return entry


def list_tables() -> dict:
    """List all cached table schemas."""
    return _load_json("tables.json")


def delete_table(full_name: str) -> bool:
    """Remove a table from cache. Returns True if it existed."""
    tables = _load_json("tables.json")
    key = full_name.upper()
    if key in tables:
        del tables[key]
        _save_json("tables.json", tables)
        return True
    return False


# --- Bulk Import ---


def load_concepts_from_warehouse_md(path: Path | None = None) -> int:
    """Parse warehouse.md and populate cache with Quick Reference entries.

    Looks for a markdown table with columns: Concept | Table | Key Column | Date Column

    Args:
        path: Path to warehouse.md. If None, searches common locations.

    Returns:
        Number of concepts loaded into cache.
    """
    import re

    # Find warehouse.md if not provided
    if path is None:
        locations = [
            Path(".astro/warehouse.md"),
            Path.home() / ".astro" / "agents" / "warehouse.md",
            Path("warehouse.md"),
        ]
        for loc in locations:
            if loc.exists():
                path = loc
                break

    if path is None or not path.exists():
        return 0

    content = path.read_text(encoding="utf-8")
    concepts_loaded = 0

    # Find markdown table rows: | concept | table | key_col | date_col |
    # Skip header rows (contain "Concept" or "---")
    table_pattern = re.compile(
        r"^\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|(?:\s*([^|]*)\s*\|)?(?:\s*([^|]*)\s*\|)?",
        re.MULTILINE,
    )

    for match in table_pattern.finditer(content):
        concept = match.group(1).strip()
        table = match.group(2).strip()
        key_col = match.group(3).strip() if match.group(3) else None
        date_col = match.group(4).strip() if match.group(4) else None

        # Skip header/separator rows
        if not concept or concept.lower() == "concept" or "---" in concept:
            continue
        if not table or table.lower() == "table" or "---" in table:
            continue
        # Skip if table doesn't look valid (should have dots for fully qualified name)
        if "." not in table:
            continue

        # Normalize empty values
        if key_col in ("-", "", None):
            key_col = None
        if date_col in ("-", "", None):
            date_col = None

        learn_concept(concept, table, key_col, date_col)
        concepts_loaded += 1

    return concepts_loaded
