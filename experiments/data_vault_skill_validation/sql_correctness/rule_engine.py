"""Data Vault 2.0 pattern-checking rule engine.

Not a full SQL parser — pattern-based checks over normalized SQL text.
Every check corresponds to a rule from the data-vault skill that, if
violated, produces a silently-wrong DV model.

Rules are grouped by target structure:

    Hub rules:
        hub_uses_merge_strategy       (should be append, not merge)
        hub_missing_incremental       (should be incremental)
        hub_no_null_bk_filter         (must filter NULL business keys)
        hub_no_dedup                  (must dedupe on hash key)
        hub_inline_md5                (must use shared macro dv_hash_bk)
        hub_current_timestamp_inline  (must use run_started_at, not CURRENT_TIMESTAMP per-row)
        hub_source_updated_at_as_ldts (must not use source updated_at as load_dts)

    Link rules:
        link_uses_merge_strategy
        link_missing_incremental
        link_payload_column           (payload belongs in satellite for standard links)
        link_inline_md5

    Satellite rules:
        sat_uses_merge_strategy       (breaks history)
        sat_missing_hashdiff          (no change detection)
        sat_hashdiff_not_alphabetized (unstable hashdiff)
        sat_hashdiff_includes_metadata (must exclude load_dts/record_source)
        sat_unique_key_wrong_grain    (must be (parent_hk, load_dts))
        sat_inline_md5

    Cross-cutting:
        raw_vault_uses_soft_rule       (WHERE is_test = FALSE etc.)
        no_record_source              (must emit record_source)
        no_load_dts                   (must emit load_dts)

Usage:
    from rule_engine import evaluate
    violations = evaluate(sql, structure="hub")
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable


@dataclass
class Rule:
    id: str
    description: str
    applies_to: set[str]  # {"hub", "link", "sat", "any"}
    check: Callable[[str], bool]  # returns True if violation


def _normalize(sql: str) -> str:
    """Lowercase; collapse whitespace; strip Jinja comments."""
    # Remove Jinja comments
    sql = re.sub(r"\{#.*?#\}", "", sql, flags=re.DOTALL)
    # Remove SQL comments
    sql = re.sub(r"--.*$", "", sql, flags=re.MULTILINE)
    sql = re.sub(r"/\*.*?\*/", "", sql, flags=re.DOTALL)
    # Lowercase and collapse whitespace
    return re.sub(r"\s+", " ", sql.lower()).strip()


# ─── Hub rules ──────────────────────────────────────────────────────────

def _check_hub_uses_merge(sql: str) -> bool:
    n = _normalize(sql)
    # Any explicit merge strategy in the config is a violation for a hub
    return "incremental_strategy='merge'" in n or 'incremental_strategy="merge"' in n


def _check_hub_missing_incremental(sql: str) -> bool:
    n = _normalize(sql)
    return "materialized='incremental'" not in n and 'materialized="incremental"' not in n


def _check_hub_no_null_bk_filter(sql: str) -> bool:
    n = _normalize(sql)
    # The load must include WHERE ... is not null on the business key column.
    # Weak but useful heuristic: presence of "is not null" in the SQL.
    return "is not null" not in n


def _check_hub_no_dedup(sql: str) -> bool:
    n = _normalize(sql)
    # Should use QUALIFY ROW_NUMBER = 1 or DISTINCT or GROUP BY on hash key
    return not any(kw in n for kw in ("qualify row_number", "select distinct", "row_number()"))


def _check_hub_inline_md5(sql: str) -> bool:
    """Hub must not use inline MD5 / HASHBYTES / md5_binary — use the shared macro."""
    n = _normalize(sql)
    uses_macro = "dv_hash_bk" in n or "automate_dv.stage" in n or "automate_dv.hub" in n
    inline = re.search(r"\b(md5|md5_binary|hashbytes|sha1|sha2)\s*\(", n) is not None
    return inline and not uses_macro


def _check_hub_current_timestamp_inline(sql: str) -> bool:
    """CURRENT_TIMESTAMP() per row violates atomic load_dts."""
    n = _normalize(sql)
    # OK if used inside run_started_at context; not OK if used directly as load_dts
    if "run_started_at" in n or "invocation_id" in n:
        return False
    return "current_timestamp()" in n and "as load_dts" in n


def _check_source_updated_at_as_ldts(sql: str) -> bool:
    """Using source's updated_at column as load_dts."""
    n = _normalize(sql)
    return bool(re.search(r"\bupdated_at\s+as\s+load_dts\b", n))


# ─── Link rules ─────────────────────────────────────────────────────────

def _check_link_uses_merge(sql: str) -> bool:
    return _check_hub_uses_merge(sql)


def _check_link_missing_incremental(sql: str) -> bool:
    return _check_hub_missing_incremental(sql)


def _check_link_inline_md5(sql: str) -> bool:
    n = _normalize(sql)
    uses_macro = "dv_hash_bk" in n or "automate_dv.stage" in n or "automate_dv.link" in n or "automate_dv.t_link" in n
    inline = re.search(r"\b(md5|md5_binary|hashbytes|sha1|sha2)\s*\(", n) is not None
    return inline and not uses_macro


def _check_link_payload_column(sql: str) -> bool:
    """Standard link should carry only hash keys and load metadata.

    Heuristic: if there's an obvious 'payload'-shaped column
    (amount, quantity, price, description, name, status, currency,
    method) selected — not just as intermediate — it's a violation.
    Exception: transactional links (tagged `t_link` or in comment) allow payload.
    """
    n = _normalize(sql)
    if "t_link" in n or "transactional" in n or "automate_dv.t_link" in n:
        return False
    payload_kws = (
        r"\bas\s+amount\b", r"\bas\s+quantity\b", r"\bas\s+price\b",
        r"\bas\s+description\b", r"\bas\s+status\b", r"\bas\s+method\b",
        r"\bas\s+unit_price\b", r"\bas\s+total_\w+\b",
    )
    return any(re.search(p, n) for p in payload_kws)


# ─── Satellite rules ────────────────────────────────────────────────────

def _check_sat_uses_merge(sql: str) -> bool:
    return _check_hub_uses_merge(sql)


def _check_sat_missing_hashdiff(sql: str) -> bool:
    n = _normalize(sql)
    return "hashdiff" not in n and "dv_hashdiff" not in n


def _check_sat_hashdiff_not_alphabetized(sql: str) -> bool:
    """When dv_hashdiff([...]) is used, its column list should be sorted.

    Extract the argument list and check it's alphabetical. Skip if
    dv_hashdiff isn't used (means hashdiff is computed inline; a
    weaker violation to catch elsewhere).
    """
    # Match `dv_hashdiff([...])` with a bracketed list of quoted strings
    m = re.search(
        r"dv_hashdiff\s*\(\s*\[\s*([^\]]+)\]\s*\)",
        sql,
        re.IGNORECASE | re.DOTALL,
    )
    if not m:
        return False
    items = re.findall(r"['\"]([^'\"]+)['\"]", m.group(1))
    return items != sorted(items)


def _check_sat_hashdiff_includes_metadata(sql: str) -> bool:
    """dv_hashdiff must not include load_dts, record_source, load_batch_id, hashdiff."""
    m = re.search(
        r"dv_hashdiff\s*\(\s*\[\s*([^\]]+)\]\s*\)",
        sql,
        re.IGNORECASE | re.DOTALL,
    )
    if not m:
        return False
    items = re.findall(r"['\"]([^'\"]+)['\"]", m.group(1))
    forbidden = {"load_dts", "record_source", "load_batch_id", "hashdiff"}
    return any(item.lower() in forbidden for item in items)


def _check_sat_unique_key_wrong_grain(sql: str) -> bool:
    """Satellite unique_key must be a list containing both parent_hk and load_dts."""
    n = _normalize(sql)
    # Look for unique_key= configurations
    m = re.search(r"unique_key\s*=\s*(\[[^\]]+\]|['\"]([^'\"]+)['\"])", n)
    if not m:
        return False
    key = m.group(1)
    # If it's a single-string key, that's a violation
    if key.startswith("'") or key.startswith('"'):
        return True
    # It's a list — must contain load_dts
    return "load_dts" not in key


def _check_sat_inline_md5(sql: str) -> bool:
    n = _normalize(sql)
    uses_macro = "dv_hash_bk" in n or "dv_hashdiff" in n or "automate_dv.sat" in n or "automate_dv.ma_sat" in n or "automate_dv.eff_sat" in n
    inline = re.search(r"\b(md5|md5_binary|hashbytes|sha1|sha2)\s*\(", n) is not None
    return inline and not uses_macro


# ─── Cross-cutting rules ────────────────────────────────────────────────

def _check_raw_vault_soft_rule(sql: str) -> bool:
    """Raw-vault load must not filter on business criteria (soft rule).

    Detects common WHERE-clauses that are soft rules: is_test = FALSE,
    is_active = TRUE, status <> 'DELETED', etc.
    Ignores NULL filters (which are hard rules) and load-context filters
    like `WHERE customer_hk NOT IN (SELECT ...)`.
    """
    n = _normalize(sql)
    soft_patterns = [
        r"\bwhere\b.*\bis_test\s*=\s*(true|false)\b",
        r"\bwhere\b.*\bis_active\s*=\s*(true|false)\b",
        r"\bwhere\b.*\bstatus\s*<>\s*['\"]\w+['\"]",
        r"\bwhere\b.*\bstatus\s*=\s*['\"](?!'^\^$)\w+['\"]",
        r"\bwhere\b.*\bregion\s*=\s*['\"]\w+['\"]",
    ]
    return any(re.search(p, n) for p in soft_patterns)


def _check_no_record_source(sql: str) -> bool:
    stripped = re.sub(r"\{\{\s*config\s*\([^)]*\)\s*\}\}", "", sql, flags=re.DOTALL)
    n = _normalize(stripped)
    patterns = [
        r"\bas\s+record_source\b",
        r"\brecord_source\s*,",
    ]
    return not any(re.search(p, n) for p in patterns)


def _check_no_load_dts(sql: str) -> bool:
    """Look for load_dts *being emitted* (as a column alias) rather than merely appearing
    as a string inside a config() block or unique_key list."""
    # Strip out the config(...) block so unique_key=['customer_hk', 'load_dts']
    # doesn't count as an emission.
    stripped = re.sub(r"\{\{\s*config\s*\([^)]*\)\s*\}\}", "", sql, flags=re.DOTALL)
    n = _normalize(stripped)
    # Look for common emission shapes
    patterns = [
        r"\bas\s+load_dts\b",
        r"\bas\s+ldts\b",
        r"\bload_dts\s*,",       # bare column reference in SELECT
        r"\bldts\s*,",
    ]
    return not any(re.search(p, n) for p in patterns)


# ─── Rule registry ──────────────────────────────────────────────────────

RULES: list[Rule] = [
    # Hub rules
    Rule("hub_uses_merge_strategy",
         "Hub must use incremental_strategy='append', not 'merge'",
         {"hub"}, _check_hub_uses_merge),
    Rule("hub_missing_incremental",
         "Hub must be materialized='incremental'",
         {"hub"}, _check_hub_missing_incremental),
    Rule("hub_no_null_bk_filter",
         "Hub must filter NULL business keys (`WHERE bk_col IS NOT NULL`)",
         {"hub"}, _check_hub_no_null_bk_filter),
    Rule("hub_no_dedup",
         "Hub must deduplicate on hash key (DISTINCT / QUALIFY ROW_NUMBER)",
         {"hub"}, _check_hub_no_dedup),
    Rule("hub_inline_md5",
         "Hub must use the shared hash macro (dv_hash_bk), not inline MD5",
         {"hub"}, _check_hub_inline_md5),
    Rule("hub_current_timestamp_inline",
         "Hub must use run_started_at for load_dts, not per-row CURRENT_TIMESTAMP()",
         {"hub"}, _check_hub_current_timestamp_inline),

    # Link rules
    Rule("link_uses_merge_strategy",
         "Link must use incremental_strategy='append', not 'merge'",
         {"link"}, _check_link_uses_merge),
    Rule("link_missing_incremental",
         "Link must be materialized='incremental'",
         {"link"}, _check_link_missing_incremental),
    Rule("link_inline_md5",
         "Link must use the shared hash macro, not inline MD5",
         {"link"}, _check_link_inline_md5),
    Rule("link_payload_column",
         "Standard link must not carry payload columns (belongs in satellite)",
         {"link"}, _check_link_payload_column),

    # Satellite rules
    Rule("sat_uses_merge_strategy",
         "Satellite must use incremental_strategy='append', not 'merge'",
         {"sat"}, _check_sat_uses_merge),
    Rule("sat_missing_hashdiff",
         "Satellite must compute a hashdiff column",
         {"sat"}, _check_sat_missing_hashdiff),
    Rule("sat_hashdiff_not_alphabetized",
         "Satellite dv_hashdiff() column list must be alphabetized",
         {"sat"}, _check_sat_hashdiff_not_alphabetized),
    Rule("sat_hashdiff_includes_metadata",
         "Satellite dv_hashdiff() must not include load metadata columns",
         {"sat"}, _check_sat_hashdiff_includes_metadata),
    Rule("sat_unique_key_wrong_grain",
         "Satellite unique_key must be [parent_hk, load_dts], not just parent_hk",
         {"sat"}, _check_sat_unique_key_wrong_grain),
    Rule("sat_inline_md5",
         "Satellite must use the shared hash macro, not inline MD5",
         {"sat"}, _check_sat_inline_md5),

    # Cross-cutting rules
    Rule("raw_vault_soft_rule",
         "Raw-vault load must not contain soft-rule filters (is_test, is_active, status='X')",
         {"hub", "link", "sat", "any"}, _check_raw_vault_soft_rule),
    Rule("source_updated_at_as_load_dts",
         "Must not use source's updated_at column as load_dts",
         {"hub", "link", "sat", "any"}, _check_source_updated_at_as_ldts),
    Rule("no_record_source",
         "Every vault row must have a record_source column",
         {"hub", "link", "sat", "any"}, _check_no_record_source),
    Rule("no_load_dts",
         "Every vault row must have a load_dts column",
         {"hub", "link", "sat", "any"}, _check_no_load_dts),
]


def evaluate(sql: str, structure: str) -> list[str]:
    """Return a list of rule IDs violated by this SQL for the given structure."""
    if structure not in {"hub", "link", "sat"}:
        raise ValueError(f"Unknown structure: {structure!r}")
    violations: list[str] = []
    for rule in RULES:
        if structure in rule.applies_to or "any" in rule.applies_to:
            try:
                if rule.check(sql):
                    violations.append(rule.id)
            except Exception:
                # A check that raises is a harness bug, not a violation
                pass
    return violations


def all_rule_ids() -> list[str]:
    return [r.id for r in RULES]
