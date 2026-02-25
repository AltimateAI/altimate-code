"""Lineage classification types (Phase 2)."""

from __future__ import annotations

from enum import Enum


class LensType(str, Enum):
    """Classification lens for lineage analysis."""

    COLUMN = "column"
    TABLE = "table"
    TRANSFORMATION = "transformation"
