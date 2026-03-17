#!/usr/bin/env python3
"""
Auto-generates docs/docs/llms.txt from mkdocs.yml nav structure.
Run before docs build to keep llms.txt in sync.
Usage: python docs/scripts/generate-llms-txt.py
"""

import re
import sys
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).parent.parent.parent
MKDOCS_YML = REPO_ROOT / "docs" / "mkdocs.yml"
DOCS_DIR = REPO_ROOT / "docs" / "docs"
OUTPUT_FILE = DOCS_DIR / "llms.txt"
BASE_URL = "https://altimateai.github.io/altimate-code"

HEADER = """# altimate-code llms.txt
# AI-friendly documentation index for altimate-code
# Auto-generated from mkdocs.yml — do not edit manually
# Source: {base_url}

> altimate-code is an open-source data engineering harness — 99+ tools for building, validating, optimizing, and shipping data products. Use in your terminal, CI pipeline, orchestration DAGs, or as the tool layer for your data agents. Includes a deterministic SQL Intelligence Engine (100% F1 across 1,077 queries), column-level lineage, FinOps analysis, PII detection, and dbt integration. Works with any LLM provider. Local-first, MIT-licensed.

""".format(base_url=BASE_URL)


def get_page_description(md_path: Path) -> str:
    """Extract description from page frontmatter or first paragraph."""
    if not md_path.exists():
        return ""
    content = md_path.read_text(encoding="utf-8")
    if content.startswith("---"):
        try:
            end = content.index("---", 3)
            fm = yaml.safe_load(content[3:end])
            if fm and "description" in fm:
                return fm["description"]
        except (ValueError, yaml.YAMLError):
            pass
    # Fall back to first non-empty line after the H1
    lines = content.split("\n")
    h1_found = False
    for line in lines:
        line = line.strip()
        if line.startswith("# "):
            h1_found = True
            continue
        if h1_found and line and not line.startswith("#"):
            # Strip markdown formatting
            return re.sub(r"[*_`\[\]]", "", line)[:150]
    return ""


def nav_to_llms(nav, indent=0):
    lines = []
    for item in nav:
        if isinstance(item, dict):
            for key, value in item.items():
                if isinstance(value, list):
                    if indent == 0:
                        lines.append(f"\n## {key}\n")
                    else:
                        lines.append(f"\n### {key}\n")
                    lines.extend(nav_to_llms(value, indent + 1))
                elif isinstance(value, str) and not value.startswith("http"):
                    md_path = DOCS_DIR / value
                    desc = get_page_description(md_path)
                    url_path = value.replace(".md", "/")
                    url = f"{BASE_URL}/{url_path}"
                    entry = f"- [{key}]({url})"
                    if desc:
                        entry += f": {desc}"
                    lines.append(entry)
    return lines


def main():
    config = yaml.safe_load(MKDOCS_YML.read_text())
    nav = config.get("nav", [])

    lines = [HEADER]
    lines.extend(nav_to_llms(nav))

    OUTPUT_FILE.write_text("\n".join(lines) + "\n")
    print(f"Generated {OUTPUT_FILE} ({len(lines)} lines)")


if __name__ == "__main__":
    main()
