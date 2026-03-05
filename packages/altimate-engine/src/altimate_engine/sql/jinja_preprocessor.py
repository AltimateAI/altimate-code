"""Jinja/dbt template preprocessor for SQL analysis tools.

Strips or stubs common dbt Jinja macros from SQL so downstream tools
(lint, format, optimize, transpile) can parse the resulting plain SQL.

The preprocessor handles:
  - {{ ref('model') }}            → model
  - {{ source('src', 'table') }}  → src__table
  - {{ config(...) }}             → (removed)
  - {{ var('name') }}             → '__var_name__'
  - {{ var('name', default) }}    → '__var_name__'
  - {{ this }}                    → __this__
  - {{ this.identifier }}         → __this__
  - {# comments #}               → (removed)
  - {% set x = ... %}             → (removed)
  - {% if ... %}...{% endif %}    → keeps inner content
  - {% for ... %}...{% endfor %}  → keeps inner content
  - {% macro ... %}...{% endmacro %} → (removed entirely)
  - {{ adapter.dispatch(...) }}   → (removed)
  - {{ return(...) }}             → (removed)
  - {{ log(...) }}                → (removed)
  - {{ exceptions.raise_...() }} → (removed)

Inspired by SQLFluff's Jinja templater approach of stubbing dbt builtins.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------

# Patterns that signal Jinja presence — quick check before expensive regex
_JINJA_MARKERS = ("{{", "{%", "{#")


def contains_jinja(sql: str) -> bool:
    """Return True if *sql* contains any Jinja template syntax."""
    return any(marker in sql for marker in _JINJA_MARKERS)


# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------


@dataclass
class JinjaPreprocessResult:
    """Result of preprocessing Jinja-templated SQL."""

    preprocessed_sql: str
    original_sql: str
    was_preprocessed: bool
    refs_found: list[str] = field(default_factory=list)
    sources_found: list[str] = field(default_factory=list)
    variables_found: list[str] = field(default_factory=list)
    macros_removed: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "preprocessed_sql": self.preprocessed_sql,
            "original_sql": self.original_sql,
            "was_preprocessed": self.was_preprocessed,
            "refs_found": self.refs_found,
            "sources_found": self.sources_found,
            "variables_found": self.variables_found,
            "macros_removed": self.macros_removed,
            "warnings": self.warnings,
        }


# ---------------------------------------------------------------------------
# Core preprocessor
# ---------------------------------------------------------------------------

# Order matters — more specific patterns before general ones.

# 1. Jinja comments: {# ... #}  (can be multiline)
_RE_COMMENT = re.compile(r"\{#.*?#\}", re.DOTALL)

# 2. {% macro ... %} ... {% endmacro %}  (remove entire block)
_RE_MACRO_BLOCK = re.compile(
    r"\{%-?\s*macro\b.*?%\}.*?\{%-?\s*endmacro\s*-?%\}", re.DOTALL
)

# 3. {% set ... %} (single-line assignment, or block form {% set x %}...{% endset %})
_RE_SET_BLOCK = re.compile(
    r"\{%-?\s*set\b[^%]*?%\}.*?\{%-?\s*endset\s*-?%\}", re.DOTALL
)
_RE_SET_LINE = re.compile(r"\{%-?\s*set\b[^%]*?-?%\}")

# 4. {% if ... %}...{% endif %}  — keep inner content
_RE_IF_OPEN = re.compile(r"\{%-?\s*if\b[^%]*?-?%\}")
_RE_ELIF = re.compile(r"\{%-?\s*elif\b[^%]*?-?%\}")
_RE_ELSE = re.compile(r"\{%-?\s*else\s*-?%\}")
_RE_ENDIF = re.compile(r"\{%-?\s*endif\s*-?%\}")

# 5. {% for ... %}...{% endfor %}  — keep inner content
_RE_FOR_OPEN = re.compile(r"\{%-?\s*for\b[^%]*?-?%\}")
_RE_ENDFOR = re.compile(r"\{%-?\s*endfor\s*-?%\}")

# 6. {{ config(...) }}  — remove entirely
_RE_CONFIG = re.compile(r"\{\{-?\s*config\s*\(.*?\)\s*-?\}\}", re.DOTALL)

# 7. {{ ref('model') }} or {{ ref('model', v=N) }}
_RE_REF = re.compile(
    r"\{\{-?\s*ref\s*\(\s*['\"]([^'\"]+)['\"]\s*(?:,[^)]*?)?\)\s*-?\}\}"
)

# 8. {{ source('source_name', 'table_name') }}
_RE_SOURCE = re.compile(
    r"\{\{-?\s*source\s*\(\s*['\"]([^'\"]+)['\"]\s*,\s*['\"]([^'\"]+)['\"]\s*\)\s*-?\}\}"
)

# 9. {{ var('name') }} or {{ var('name', 'default') }}
_RE_VAR = re.compile(
    r"\{\{-?\s*var\s*\(\s*['\"]([^'\"]+)['\"]\s*(?:,[^)]*?)?\)\s*-?\}\}"
)

# 10. {{ this }} or {{ this.identifier }} or {{ this.schema }} etc.
_RE_THIS = re.compile(r"\{\{-?\s*this(?:\.\w+)?\s*-?\}\}")

# 11. {{ adapter.dispatch('macro_name')(...) }}
_RE_ADAPTER_DISPATCH = re.compile(
    r"\{\{-?\s*adapter\.\w+\s*\(.*?\)(?:\s*\(.*?\))?\s*-?\}\}", re.DOTALL
)

# 12. {{ return(...) }}, {{ log(...) }}, {{ exceptions.raise_...() }}
_RE_UTILITY_CALLS = re.compile(
    r"\{\{-?\s*(?:return|log|exceptions\.\w+)\s*\(.*?\)\s*-?\}\}", re.DOTALL
)

# 13. Remaining {% ... %} tags (catch-all for unknown block tags)
_RE_REMAINING_TAG = re.compile(r"\{%-?[^%]*?-?%\}")

# 14. Remaining {{ ... }} expressions (catch-all)
_RE_REMAINING_EXPR = re.compile(r"\{\{-?.*?-?\}\}", re.DOTALL)


def preprocess_jinja(sql: str) -> JinjaPreprocessResult:
    """Strip/stub Jinja templates from *sql* to produce parseable SQL.

    If the input contains no Jinja syntax, returns it unchanged.
    """
    if not contains_jinja(sql):
        return JinjaPreprocessResult(
            preprocessed_sql=sql,
            original_sql=sql,
            was_preprocessed=False,
        )

    result = JinjaPreprocessResult(
        preprocessed_sql="",
        original_sql=sql,
        was_preprocessed=True,
    )

    out = sql

    # --- Pass 1: Remove comments ---
    out = _RE_COMMENT.sub("", out)

    # --- Pass 2: Remove macro blocks ---
    macro_matches = _RE_MACRO_BLOCK.findall(out)
    if macro_matches:
        result.macros_removed.append("macro block(s)")
    out = _RE_MACRO_BLOCK.sub("", out)

    # --- Pass 3: Remove set blocks and single-line sets ---
    out = _RE_SET_BLOCK.sub("", out)
    out = _RE_SET_LINE.sub("", out)

    # --- Pass 4: Remove config ---
    if _RE_CONFIG.search(out):
        result.macros_removed.append("config()")
    out = _RE_CONFIG.sub("", out)

    # --- Pass 5: Stub ref() ---
    for m in _RE_REF.finditer(out):
        result.refs_found.append(m.group(1))
    out = _RE_REF.sub(lambda m: m.group(1), out)

    # --- Pass 6: Stub source() ---
    for m in _RE_SOURCE.finditer(out):
        result.sources_found.append(f"{m.group(1)}.{m.group(2)}")
    out = _RE_SOURCE.sub(lambda m: f"{m.group(1)}__{m.group(2)}", out)

    # --- Pass 7: Stub var() ---
    for m in _RE_VAR.finditer(out):
        result.variables_found.append(m.group(1))
    out = _RE_VAR.sub(lambda m: f"'__var_{m.group(1)}__'", out)

    # --- Pass 8: Stub this ---
    out = _RE_THIS.sub("__this__", out)

    # --- Pass 9: Remove adapter.dispatch, return, log, exceptions ---
    out = _RE_ADAPTER_DISPATCH.sub("", out)
    out = _RE_UTILITY_CALLS.sub("", out)

    # --- Pass 10: Strip block tags (if/elif/else/endif, for/endfor) — keep content ---
    out = _RE_IF_OPEN.sub("", out)
    out = _RE_ELIF.sub("", out)
    out = _RE_ELSE.sub("", out)
    out = _RE_ENDIF.sub("", out)
    out = _RE_FOR_OPEN.sub("", out)
    out = _RE_ENDFOR.sub("", out)

    # --- Pass 11: Catch-all for remaining tags/expressions ---
    remaining_tags = _RE_REMAINING_TAG.findall(out)
    remaining_exprs = _RE_REMAINING_EXPR.findall(out)
    if remaining_tags or remaining_exprs:
        unhandled = [t.strip() for t in remaining_tags + remaining_exprs]
        result.warnings.append(
            f"Some Jinja expressions could not be fully resolved and were removed: "
            f"{', '.join(unhandled[:5])}"
        )
    out = _RE_REMAINING_TAG.sub("", out)
    out = _RE_REMAINING_EXPR.sub("__jinja_expr__", out)

    # --- Cleanup: collapse extra blank lines and trim ---
    out = re.sub(r"\n{3,}", "\n\n", out)
    out = out.strip()

    result.preprocessed_sql = out
    return result
