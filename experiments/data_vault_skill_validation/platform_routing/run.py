"""Platform-routing eval — verify SKILL.md's Step 0 has the expected
routing for each supported (warehouse, orchestration) combination.

Two checks per scenario:
  1. Each expected_references file is mentioned in SKILL.md.
  2. The warehouse keyword appears in the Step 0 block.

Exit codes:
    0 = all scenarios routed correctly
    1 = at least one scenario failed
    2 = harness/dataset error

Usage:
    python run.py [--input dataset.json] [--output results/]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path


DEFAULT_SKILL_ROOT = Path(__file__).resolve().parents[3] / ".opencode" / "skills" / "data-vault"


WAREHOUSE_KEYWORDS = {
    "snowflake":  ["Snowflake"],
    "databricks": ["Databricks"],
    "bigquery":   ["BigQuery"],
    "redshift":   ["Redshift"],
    "fabric":     ["Fabric"],
    "postgres":   ["PostgreSQL", "Postgres"],
}


def extract_step_0(skill_md_text: str) -> str:
    m = re.search(
        r"^### 0\. Detect.*?(?=^### 1\.)",
        skill_md_text,
        re.MULTILINE | re.DOTALL,
    )
    return m.group(0) if m else ""


def run_scenario(skill_root: Path, skill_md_text: str, step_0: str, case: dict) -> dict:
    checks = []

    # Warehouse keyword in Step 0
    kws = WAREHOUSE_KEYWORDS.get(case["warehouse"], [])
    if any(kw in step_0 for kw in kws):
        checks.append({"check": "warehouse_in_step_0", "passed": True, "detail": f"found one of {kws}"})
    else:
        checks.append({"check": "warehouse_in_step_0", "passed": False,
                       "detail": f"none of {kws} in Step 0"})

    # Each expected reference must be linked from SKILL.md
    for ref in case["expected_references"]:
        path = skill_root / ref
        exists = path.is_file()
        linked = ref in skill_md_text
        if exists and linked:
            checks.append({"check": f"ref_{ref}", "passed": True, "detail": "exists and linked"})
        else:
            reason = []
            if not exists: reason.append("file missing")
            if not linked: reason.append("not linked from SKILL.md")
            checks.append({"check": f"ref_{ref}", "passed": False, "detail": "; ".join(reason)})

    passed = all(c["passed"] for c in checks)
    return {
        "id": case["id"],
        "setup_description": case["setup_description"],
        "checks": checks,
        "passed": passed,
    }


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--input", type=Path,
                   default=Path(__file__).resolve().parent / "dataset.json")
    p.add_argument("--output", type=Path,
                   default=Path(__file__).resolve().parent / "results")
    p.add_argument("--skill-root", type=Path, default=DEFAULT_SKILL_ROOT)
    args = p.parse_args()

    if not args.input.is_file():
        print(f"ERROR: dataset not found: {args.input}", file=sys.stderr)
        sys.exit(2)

    skill_md = args.skill_root / "SKILL.md"
    if not skill_md.is_file():
        print(f"ERROR: SKILL.md not found: {skill_md}", file=sys.stderr)
        sys.exit(2)

    try:
        dataset = json.loads(args.input.read_text())
    except json.JSONDecodeError as e:
        print(f"ERROR: dataset is not valid JSON: {e}", file=sys.stderr)
        sys.exit(2)

    skill_text = skill_md.read_text()
    step_0 = extract_step_0(skill_text)
    if not step_0:
        print("ERROR: Step 0 section not found in SKILL.md", file=sys.stderr)
        sys.exit(1)

    results = [run_scenario(args.skill_root, skill_text, step_0, c) for c in dataset]
    passed = sum(1 for r in results if r["passed"])
    failed = len(results) - passed

    report = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "skill_root": str(args.skill_root),
        "total_scenarios": len(results),
        "scenarios_passed": passed,
        "scenarios_failed": failed,
        "results": results,
    }

    print(f"\n{'=' * 70}")
    print(f"PLATFORM ROUTING EVAL — {report['timestamp']}")
    print(f"{'=' * 70}")
    for r in results:
        status = "PASS" if r["passed"] else "FAIL"
        print(f"[{status}] {r['id']}: {r['setup_description'][:60]}")
        for c in r["checks"]:
            if not c["passed"]:
                print(f"    ✗ {c['check']}: {c['detail']}")

    print(f"\n{'=' * 70}")
    print(f"{passed}/{len(results)} scenarios passed")
    print(f"{'=' * 70}\n")

    args.output.mkdir(parents=True, exist_ok=True)
    ts = report["timestamp"].replace(":", "-").replace(".", "-")
    out_file = args.output / f"platform_routing_{ts}.json"
    out_file.write_text(json.dumps(report, indent=2))
    print(f"Report written to: {out_file}")

    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
