#!/usr/bin/env python3
"""
Docs freshness checker.
Reads YAML frontmatter `last_updated` from each docs page.
Prints a warning for pages not updated in 6 months.
Non-blocking (exits 0 always) — informational only.
"""

import os
import sys
from datetime import date, timedelta
from pathlib import Path

import yaml

DOCS_DIR = Path(__file__).parent.parent.parent / "docs" / "docs"
STALE_THRESHOLD_DAYS = 180

def check_freshness():
    stale_pages = []
    threshold = date.today() - timedelta(days=STALE_THRESHOLD_DAYS)

    for md_file in sorted(DOCS_DIR.rglob("*.md")):
        content = md_file.read_text(encoding="utf-8")
        if not content.startswith("---"):
            continue
        try:
            end = content.index("---", 3)
            frontmatter = yaml.safe_load(content[3:end])
            if not frontmatter or "last_updated" not in frontmatter:
                continue
            last_updated = frontmatter["last_updated"]
            if isinstance(last_updated, str):
                last_updated = date.fromisoformat(last_updated)
            if last_updated < threshold:
                rel_path = md_file.relative_to(DOCS_DIR.parent.parent)
                stale_pages.append((str(rel_path), last_updated.isoformat()))
        except (ValueError, yaml.YAMLError):
            pass

    if stale_pages:
        print(f"\n  {len(stale_pages)} docs page(s) not updated in {STALE_THRESHOLD_DAYS}+ days:")
        for path, date_str in stale_pages:
            print(f"   {date_str}  {path}")
        print()
    else:
        print("All docs pages with last_updated metadata are fresh.")

    sys.exit(0)  # Non-blocking

if __name__ == "__main__":
    check_freshness()
