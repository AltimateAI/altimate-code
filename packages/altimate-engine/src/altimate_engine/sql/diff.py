"""SQL diff — compare two SQL queries and show differences."""

from __future__ import annotations

import difflib


def diff_sql(original: str, modified: str, context_lines: int = 3) -> dict:
    """Generate a diff between two SQL strings.

    Args:
        original: The original SQL
        modified: The modified SQL
        context_lines: Number of context lines around changes

    Returns:
        Dict with unified diff, change summary, and line-level changes.
    """
    original_lines = original.splitlines(keepends=True)
    modified_lines = modified.splitlines(keepends=True)

    # Unified diff
    unified = list(difflib.unified_diff(
        original_lines,
        modified_lines,
        fromfile="original.sql",
        tofile="modified.sql",
        n=context_lines,
    ))
    unified_text = "".join(unified)

    # Similarity ratio
    matcher = difflib.SequenceMatcher(None, original, modified)
    similarity = round(matcher.ratio(), 4)

    # Count changes (character-level)
    additions = sum(j2 - j1 for tag, i1, i2, j1, j2 in matcher.get_opcodes() if tag in ("insert", "replace"))
    deletions = sum(i2 - i1 for tag, i1, i2, j1, j2 in matcher.get_opcodes() if tag in ("delete", "replace"))

    # Get opcodes for structured changes
    changes = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        changes.append({
            "type": tag,  # replace, insert, delete
            "original_start": i1,
            "original_end": i2,
            "modified_start": j1,
            "modified_end": j2,
            "original_text": original[i1:i2] if tag in ("replace", "delete") else "",
            "modified_text": modified[j1:j2] if tag in ("replace", "insert") else "",
        })

    return {
        "has_changes": len(changes) > 0,
        "unified_diff": unified_text,
        "additions": additions,
        "deletions": deletions,
        "change_count": len(changes),
        "similarity": similarity,
        "changes": changes[:50],  # Limit to first 50 changes
    }
