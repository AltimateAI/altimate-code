"""Static structural checks for the data-vault skill.

Verifies:
    - SKILL.md exists and has valid frontmatter
    - Every references/*.md file exists on disk
    - Every reference file referenced by SKILL.md exists
    - Every internal link ([...](path)) in SKILL.md and references
      resolves to a real file
    - Every reference file has minimum structural elements
      (front-matter-free, has a top-level # heading, has a "Common
      Mistakes" section)
    - Dialect coverage matrix — every reference that discusses
      hashing mentions all supported dialects (or is explicitly
      dialect-neutral)
    - Iron Rules section exists in SKILL.md with expected rule count

Exit codes:
    0 = all checks passed
    1 = one or more failures
    2 = harness broken (missing skill directory, etc.)

Usage:
    python run.py [--skill-root <path>] [--output <dir>]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path


# ─── Config ──────────────────────────────────────────────────────────────

DEFAULT_SKILL_ROOT = Path(__file__).resolve().parents[3] / ".opencode" / "skills" / "data-vault"

# Every reference file that must exist
REQUIRED_REFERENCES = {
    # Foundations
    "core-concepts.md",
    "hard-vs-soft-rules.md",
    "source-modeling.md",
    "hashing-and-keys.md",
    "zero-keys-and-ghost.md",
    # Layers
    "staging-layer.md",
    "hub-patterns.md",
    "link-patterns.md",
    "satellite-patterns.md",
    "record-tracking-satellites.md",
    "reference-tables.md",
    "multi-temporal.md",
    "loading-patterns.md",
    "pit-and-bridge.md",
    # Business vault + consumption
    "business-vault.md",
    "exploration-and-computed-links.md",
    "information-marts.md",
    "real-time-and-virtualization.md",
    # Ops + delivery
    "metrics-and-error-vault.md",
    "methodology-and-delivery.md",
    # Platform-specific
    "snowflake-specific.md",
    "databricks-specific.md",
    "bigquery-specific.md",
    "redshift-specific.md",
    "ms-fabric-specific.md",
    "postgres-specific.md",
    # Orchestration + tools
    "dbtvault-and-automatedv.md",
    "native-sql-orchestration.md",
    "common-mistakes.md",
    # Enterprise-delivery layer
    "governance-and-compliance.md",
    "cdc-and-streaming-sources.md",
    "multi-tenancy.md",
    "data-contracts-and-change-mgmt.md",
    "mdm-integration.md",
    "scale-and-ops.md",
}

# Minimum iron-rule count expected in SKILL.md
MIN_IRON_RULES = 7

# Every reference file must have at least one heading and a Common Mistakes section
# (except a few foundational ones that don't have a mistake list)
FILES_WITHOUT_MISTAKES_SECTION = {
    "core-concepts.md",             # vocabulary reference
    "source-modeling.md",           # procedural reference; has anti-patterns table instead
    "methodology-and-delivery.md",  # process reference
    "hashing-and-keys.md",          # recipe reference; "never use these" section instead
}

# Dialect keywords — a reference that discusses hashing must mention most of these
DIALECT_KEYWORDS = {
    "snowflake": ["snowflake", "md5_binary"],
    "bigquery":  ["bigquery"],
    "redshift":  ["redshift"],
    "databricks": ["databricks", "delta"],
    "postgres":  ["postgres"],
    "sql server": ["sql server", "fabric", "hashbytes"],
}


# ─── Check implementations ──────────────────────────────────────────────

class Check:
    def __init__(self, name: str):
        self.name = name
        self.passes: list[str] = []
        self.failures: list[str] = []

    def ok(self, message: str) -> None:
        self.passes.append(message)

    def fail(self, message: str) -> None:
        self.failures.append(message)

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "passed": len(self.failures) == 0,
            "pass_count": len(self.passes),
            "fail_count": len(self.failures),
            "failures": self.failures,
        }


def check_skill_md_exists(root: Path) -> Check:
    c = Check("skill_md_exists")
    if not (root / "SKILL.md").is_file():
        c.fail(f"SKILL.md not found at {root / 'SKILL.md'}")
    else:
        c.ok("SKILL.md present")
    return c


def check_frontmatter(root: Path) -> Check:
    c = Check("frontmatter_valid")
    path = root / "SKILL.md"
    if not path.is_file():
        c.fail("SKILL.md missing; cannot check frontmatter")
        return c

    text = path.read_text()
    # Must start with ---
    if not text.startswith("---\n"):
        c.fail("SKILL.md does not begin with '---' frontmatter delimiter")
        return c
    # Find closing ---
    end = text.find("\n---\n", 4)
    if end == -1:
        c.fail("SKILL.md frontmatter has no closing '---'")
        return c
    front = text[4:end]
    # Required keys
    for key in ("name:", "description:"):
        if key not in front:
            c.fail(f"Frontmatter missing required key: {key}")
        else:
            c.ok(f"Frontmatter has {key}")
    # Name must be 'data-vault'
    m = re.search(r"^name:\s*(\S+)\s*$", front, re.MULTILINE)
    if m and m.group(1) != "data-vault":
        c.fail(f"Frontmatter name is {m.group(1)!r}, expected 'data-vault'")
    return c


def check_reference_files_exist(root: Path) -> Check:
    c = Check("required_references_exist")
    ref_dir = root / "references"
    if not ref_dir.is_dir():
        c.fail(f"references/ directory not found at {ref_dir}")
        return c
    existing = {p.name for p in ref_dir.glob("*.md")}
    missing = REQUIRED_REFERENCES - existing
    extra = existing - REQUIRED_REFERENCES
    for m in sorted(missing):
        c.fail(f"Required reference file missing: references/{m}")
    for name in sorted(REQUIRED_REFERENCES & existing):
        c.ok(f"references/{name} present")
    for e in sorted(extra):
        # Extras are informational, not failures
        c.ok(f"(extra) references/{e} present but not in REQUIRED_REFERENCES")
    return c


def check_skill_md_references_resolve(root: Path) -> Check:
    """Every references/*.md link in SKILL.md must point at a real file."""
    c = Check("skill_md_links_resolve")
    skill = root / "SKILL.md"
    text = skill.read_text() if skill.is_file() else ""
    # Match markdown links like [text](references/foo.md) or (references/foo.md)
    link_re = re.compile(r"\((references/[a-z0-9\-_]+\.md)\)")
    links = set(link_re.findall(text))
    if not links:
        c.fail("No references/*.md links found in SKILL.md — did the ref table get deleted?")
    for link in sorted(links):
        target = root / link
        if not target.is_file():
            c.fail(f"SKILL.md links to {link} but the file does not exist")
        else:
            c.ok(f"link resolves: {link}")
    # Also check every REQUIRED reference is linked at least once
    for req in sorted(REQUIRED_REFERENCES):
        needle = f"references/{req}"
        if needle not in text:
            c.fail(f"SKILL.md does not link to required reference: {needle}")
    return c


def check_internal_reference_links_resolve(root: Path) -> Check:
    """Every reference-to-reference link must resolve."""
    c = Check("reference_internal_links_resolve")
    ref_dir = root / "references"
    # Match [text](file.md) or [text](file.md#anchor) where the target is a sibling ref file
    link_re = re.compile(r"\[[^\]]+\]\(([a-z0-9\-_]+\.md)(?:#[^)]*)?\)")
    checked = 0
    for md in sorted(ref_dir.glob("*.md")):
        text = md.read_text()
        for link in link_re.findall(text):
            checked += 1
            target = ref_dir / link
            if not target.is_file():
                c.fail(f"{md.name} → sibling {link} does not exist")
    c.ok(f"checked {checked} internal reference-to-reference links")
    return c


def check_headings_present(root: Path) -> Check:
    """Every reference file has an H1 heading."""
    c = Check("reference_files_have_h1")
    ref_dir = root / "references"
    for md in sorted(ref_dir.glob("*.md")):
        text = md.read_text()
        # First non-empty line must start with `# `
        first_content = next((ln for ln in text.splitlines() if ln.strip()), "")
        if not first_content.startswith("# "):
            c.fail(f"{md.name} has no H1 heading (starts with: {first_content[:60]!r})")
        else:
            c.ok(f"{md.name} has H1: {first_content[:80]}")
    return c


def check_common_mistakes_section(root: Path) -> Check:
    """Layer / pattern reference files must include a 'Common ... Mistakes' section."""
    c = Check("common_mistakes_section")
    ref_dir = root / "references"
    for md in sorted(ref_dir.glob("*.md")):
        if md.name in FILES_WITHOUT_MISTAKES_SECTION:
            c.ok(f"{md.name} — skipped (opt-out)")
            continue
        text = md.read_text().lower()
        # Look for a "common ... mistakes" or "## common" or "anti-pattern" section
        if ("common" in text and "mistake" in text) or ("anti-pattern" in text):
            c.ok(f"{md.name} has mistakes/anti-patterns section")
        else:
            c.fail(f"{md.name} missing 'Common Mistakes' or 'Anti-Patterns' section")
    return c


def check_iron_rules(root: Path) -> Check:
    c = Check("skill_md_iron_rules")
    skill = root / "SKILL.md"
    text = skill.read_text() if skill.is_file() else ""
    # Find the "## Iron Rules" section
    m = re.search(r"^## Iron Rules\s*$(.*?)(?=^## )", text, re.MULTILINE | re.DOTALL)
    if not m:
        c.fail("No '## Iron Rules' section in SKILL.md")
        return c
    rules_section = m.group(1)
    # Count numbered rules "1. **...**" through "N. **...**"
    rule_lines = re.findall(r"^\s*\d+\.\s+\*\*", rules_section, re.MULTILINE)
    if len(rule_lines) < MIN_IRON_RULES:
        c.fail(f"Iron Rules section has {len(rule_lines)} rules, expected ≥ {MIN_IRON_RULES}")
    else:
        c.ok(f"Iron Rules section has {len(rule_lines)} rules")
    return c


def check_non_negotiable_rules(root: Path) -> Check:
    """Same, but for 'Non-Negotiable Rules' at the top of SKILL.md."""
    c = Check("skill_md_non_negotiable_rules")
    skill = root / "SKILL.md"
    text = skill.read_text() if skill.is_file() else ""
    m = re.search(
        r"^## The Non-Negotiable Rules of Data Vault 2\.0\s*$(.*?)(?=^## )",
        text, re.MULTILINE | re.DOTALL
    )
    if not m:
        c.fail("No '## The Non-Negotiable Rules of Data Vault 2.0' section in SKILL.md")
        return c
    rules_section = m.group(1)
    rule_lines = re.findall(r"^\s*\d+\.\s+\*\*", rules_section, re.MULTILINE)
    if len(rule_lines) < 6:
        c.fail(f"Non-negotiable rules count = {len(rule_lines)}, expected ≥ 6")
    else:
        c.ok(f"Non-negotiable rules count = {len(rule_lines)}")
    return c


def check_platform_detection_section(root: Path) -> Check:
    """SKILL.md must include Step 0 platform detection."""
    c = Check("skill_md_platform_detection")
    skill = root / "SKILL.md"
    text = skill.read_text() if skill.is_file() else ""
    if "### 0. Detect" not in text:
        c.fail("SKILL.md missing '### 0. Detect' step")
    else:
        c.ok("SKILL.md has Step 0 (platform detection)")
    # Must mention every supported warehouse
    for platform in ("Snowflake", "Databricks", "BigQuery", "Redshift", "Fabric", "PostgreSQL"):
        if platform not in text:
            c.fail(f"Step 0 does not mention {platform}")
        else:
            c.ok(f"Step 0 mentions {platform}")
    return c


def check_enterprise_probe_section(root: Path) -> Check:
    """SKILL.md must include Step 0.5 (enterprise probe) and Never-Assume section."""
    c = Check("skill_md_enterprise_probe")
    skill = root / "SKILL.md"
    text = skill.read_text() if skill.is_file() else ""
    if "### 0.5" not in text:
        c.fail("SKILL.md missing '### 0.5' enterprise-probe step")
    else:
        c.ok("SKILL.md has Step 0.5 (enterprise probe)")
    if "Never Assume" not in text:
        c.fail("SKILL.md missing 'Never Assume' / 'Ask Before' section")
    else:
        c.ok("SKILL.md has Never-Assume section")
    # Must mention each enterprise reference in Step 0.5
    for ref in ("governance-and-compliance", "cdc-and-streaming-sources",
                "multi-tenancy", "data-contracts-and-change-mgmt",
                "mdm-integration", "scale-and-ops"):
        needle = f"references/{ref}.md"
        if needle not in text:
            c.fail(f"Enterprise probe does not link {needle}")
        else:
            c.ok(f"Enterprise probe links {needle}")
    return c


def check_companion_skills_section(root: Path) -> Check:
    c = Check("skill_md_companion_skills")
    skill = root / "SKILL.md"
    text = skill.read_text() if skill.is_file() else ""
    if "## Companion altimate-code Skills" not in text:
        c.fail("SKILL.md missing '## Companion altimate-code Skills' section")
        return c
    c.ok("Companion skills section present")
    # Must mention the key sibling skills
    for skill_name in ("dbt-test", "dbt-unit-tests", "dbt-schema-verify",
                       "dbt-analyze", "data-parity", "sql-review", "pii-audit"):
        if skill_name not in text:
            c.fail(f"Companion section does not mention {skill_name}")
        else:
            c.ok(f"Companion section mentions {skill_name}")
    return c


def check_hashing_dialects_covered(root: Path) -> Check:
    """hashing-and-keys.md must cover every supported dialect."""
    c = Check("hashing_dialect_coverage")
    path = root / "references" / "hashing-and-keys.md"
    if not path.is_file():
        c.fail("hashing-and-keys.md missing")
        return c
    text = path.read_text().lower()
    for dialect, keywords in DIALECT_KEYWORDS.items():
        if any(kw in text for kw in keywords):
            c.ok(f"{dialect} covered")
        else:
            c.fail(f"hashing-and-keys.md missing dialect: {dialect} (looked for {keywords})")
    return c


def check_no_placeholder_content(root: Path) -> Check:
    """No 'TODO', 'TBD', 'FIXME', 'xxx' in the skill."""
    c = Check("no_placeholders")
    forbidden = ("TODO", "TBD", "FIXME", "XXX", "coming soon", "will be added")
    for md in sorted((root).rglob("*.md")):
        text = md.read_text()
        for token in forbidden:
            # Case-sensitive for TODO/TBD/FIXME/XXX (avoid matching "TODOs" etc.);
            # case-insensitive for the phrases
            if token in ("TODO", "TBD", "FIXME", "XXX"):
                if re.search(rf"\b{token}\b", text):
                    c.fail(f"{md.relative_to(root)} contains placeholder '{token}'")
                    break
            else:
                if token.lower() in text.lower():
                    c.fail(f"{md.relative_to(root)} contains placeholder phrase '{token}'")
                    break
    if not c.failures:
        c.ok("no placeholders found in any file")
    return c


def check_minimum_file_size(root: Path) -> Check:
    """Every reference file must be substantive (min 40 lines) — guards against stubs."""
    c = Check("reference_files_substantive")
    ref_dir = root / "references"
    MIN_LINES = 40
    for md in sorted(ref_dir.glob("*.md")):
        lines = md.read_text().count("\n")
        if lines < MIN_LINES:
            c.fail(f"{md.name} is only {lines} lines (< {MIN_LINES})")
        else:
            c.ok(f"{md.name}: {lines} lines")
    return c


def check_hard_vs_soft_rules_referenced(root: Path) -> Check:
    """The hard-vs-soft-rules concept must be referenced from staging/business-vault/hub/link/sat pages."""
    c = Check("hard_vs_soft_rules_wired_in")
    must_reference = [
        "staging-layer.md",
        "business-vault.md",
        "hub-patterns.md",
        "link-patterns.md",
        "satellite-patterns.md",
    ]
    ref_dir = root / "references"
    for name in must_reference:
        path = ref_dir / name
        if not path.is_file():
            c.fail(f"{name} missing; cannot check")
            continue
        text = path.read_text().lower()
        if "hard-vs-soft" in text or "hard rule" in text or "soft rule" in text:
            c.ok(f"{name} references hard/soft rules")
        else:
            c.fail(f"{name} never mentions hard/soft rules — is the concept wired in?")
    return c


# ─── Runner ─────────────────────────────────────────────────────────────

ALL_CHECKS = [
    check_skill_md_exists,
    check_frontmatter,
    check_reference_files_exist,
    check_skill_md_references_resolve,
    check_internal_reference_links_resolve,
    check_headings_present,
    check_common_mistakes_section,
    check_iron_rules,
    check_non_negotiable_rules,
    check_platform_detection_section,
    check_enterprise_probe_section,
    check_companion_skills_section,
    check_hashing_dialects_covered,
    check_no_placeholder_content,
    check_minimum_file_size,
    check_hard_vs_soft_rules_referenced,
]


def run_all(skill_root: Path) -> dict:
    if not skill_root.is_dir():
        print(f"ERROR: skill root does not exist: {skill_root}", file=sys.stderr)
        sys.exit(2)

    results = []
    for check_fn in ALL_CHECKS:
        try:
            r = check_fn(skill_root)
        except Exception as e:
            r = Check(check_fn.__name__)
            r.fail(f"check raised exception: {e!r}")
        results.append(r.to_dict())

    total_passed = sum(1 for r in results if r["passed"])
    total_failed = len(results) - total_passed

    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "skill_root": str(skill_root),
        "total_checks": len(results),
        "checks_passed": total_passed,
        "checks_failed": total_failed,
        "results": results,
    }


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--skill-root", type=Path, default=DEFAULT_SKILL_ROOT)
    p.add_argument("--output", type=Path,
                   default=Path(__file__).resolve().parent / "results")
    args = p.parse_args()

    report = run_all(args.skill_root)

    # Console output
    print(f"\n{'=' * 70}")
    print(f"SKILL STRUCTURE EVAL — {report['timestamp']}")
    print(f"skill root: {report['skill_root']}")
    print(f"{'=' * 70}")
    for r in report["results"]:
        status = "PASS" if r["passed"] else "FAIL"
        print(f"[{status}] {r['name']}  ({r['pass_count']} pass, {r['fail_count']} fail)")
        for f in r["failures"]:
            print(f"    ✗ {f}")
    print(f"\n{'=' * 70}")
    print(f"{report['checks_passed']}/{report['total_checks']} checks passed")
    print(f"{'=' * 70}\n")

    # Persist results
    args.output.mkdir(parents=True, exist_ok=True)
    ts = report["timestamp"].replace(":", "-").replace(".", "-")
    out_file = args.output / f"structure_{ts}.json"
    out_file.write_text(json.dumps(report, indent=2))
    print(f"Report written to: {out_file}")

    sys.exit(0 if report["checks_failed"] == 0 else 1)


if __name__ == "__main__":
    main()
