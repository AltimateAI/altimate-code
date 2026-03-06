#!/usr/bin/env python3
"""
Batch Validation Script

Validates one or more Langfuse traces via the validation API.

Modes:
  1. Trace IDs:   --trace-ids id1,id2,id3
  2. Date range:  --from-time <ISO datetime> --to-time <ISO datetime>
  3. Session ID:  --session-id <langfuse_session_id>
  4. Combined:    Any combination (union of results)

For each trace:
  - Calls the validation API
  - Collects the response

Output:
  - Writes structured JSON to logs/batch_validation_<timestamp>.json
  - Prints JSON to stdout for Claude to process
"""

import argparse
import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

# ---------------------------------------------------------------------------
# Path resolution
# ---------------------------------------------------------------------------
_script_dir = Path(__file__).resolve().parent


def _find_claude_dir():
    """Find the .claude directory by walking up from script location."""
    current = Path(__file__).resolve()
    for parent in current.parents:
        if parent.name == ".claude" and parent.is_dir():
            return parent
    return None


def _find_project_root(override=None):
    """Find project root by walking up from script location to find .claude directory.

    If override is provided, use that path directly.
    Otherwise, walk up from the script's location until a parent named '.claude'
    is found — the project root is the directory containing '.claude/'.
    Falls back to cwd if no .claude ancestor is found.
    """
    if override:
        return Path(override).resolve()

    claude_dir = _find_claude_dir()
    if claude_dir:
        return claude_dir.parent
    return Path.cwd()


# Placeholder — overridden in main() when --project-root is parsed.
# Module-level code that runs before main() uses _script_dir for .env.
_project_root = _find_project_root()

# ---------------------------------------------------------------------------
# Environment loading
# ---------------------------------------------------------------------------
_claude_dir = _find_claude_dir()

if _claude_dir:
    _env_path = _claude_dir / ".env"
    if _env_path.exists():
        load_dotenv(_env_path)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
API_URL = os.environ.get(
    "VALIDATE_API_URL", "https://apimi.tryaltimate.com/validate"
)
API_TOKEN = os.environ.get(
    "VALIDATE_API_TOKEN", ""
)

# Per-project Langfuse configs: VALIDATION (primary) and PRODUCTION (fallback)
LANGFUSE_PROJECTS = {
    "VALIDATION": {
        "public_key": os.environ.get("LANGFUSE_PUBLIC_KEY_VALIDATION", ""),
        "secret_key": os.environ.get("LANGFUSE_SECRET_KEY_VALIDATION", ""),
        "host": os.environ.get("LANGFUSE_BASE_URL_VALIDATION", "https://cloud.langfuse.com"),
    },
    "PRODUCTION": {
        "public_key": os.environ.get("LANGFUSE_PUBLIC_KEY_PRODUCTION", ""),
        "secret_key": os.environ.get("LANGFUSE_SECRET_KEY_PRODUCTION", ""),
        "host": os.environ.get("LANGFUSE_BASE_URL_PRODUCTION", "https://cloud.langfuse.com"),
    },
}

LOG_DIR = _project_root / "logs"
LOG_DIR.mkdir(exist_ok=True)


# ---------------------------------------------------------------------------
# Langfuse query
# ---------------------------------------------------------------------------
PAGE_SIZE = 50  # Traces per page when paginating


def _get_langfuse_client(project="VALIDATION"):
    """Return a configured Langfuse client for the given project."""
    from langfuse import Langfuse

    config = LANGFUSE_PROJECTS.get(project, {})
    return Langfuse(
        public_key=config.get("public_key", ""),
        secret_key=config.get("secret_key", ""),
        host=config.get("host", "https://cloud.langfuse.com"),
        timeout=60,
    )


def _paginate_traces(client, **kwargs):
    """Paginate through Langfuse trace.list() and return all trace entries."""
    trace_entries = []
    page = 1

    while True:
        page_kwargs = {**kwargs, "limit": PAGE_SIZE, "page": page}
        # print(f"Page kwargs:{page_kwargs}")
        traces_response = client.api.trace.list(**page_kwargs)
        traces_data = traces_response.data if hasattr(traces_response, "data") else []

        for trace in traces_data:
            trace_entries.append(
                {
                    "id": trace.id,
                    "name": getattr(trace, "name", "Unnamed") or "Unnamed",
                    "timestamp": str(getattr(trace, "timestamp", "")),
                    "input_preview": str(getattr(trace, "input", ""))[:200],
                }
            )

        meta = getattr(traces_response, "meta", None)
        if meta:
            total_pages = getattr(meta, "total_pages", 1)
            total_items = getattr(meta, "total_items", len(trace_entries))
            print(
                f"  Page {page}/{total_pages} fetched "
                f"({len(trace_entries)}/{total_items} traces)",
                file=sys.stderr,
            )
            if page >= total_pages:
                break
        else:
            break

        page += 1

    return trace_entries


def _fetch_traces_with_fallback(paginate_kwargs):
    """Try VALIDATION project first; fall back to PRODUCTION if no traces found."""
    for project in ("VALIDATION", "PRODUCTION"):
        print(f"  Querying Langfuse project: {project}...", file=sys.stderr)
        client = _get_langfuse_client(project)
        traces = _paginate_traces(client, **paginate_kwargs)
        if traces:
            print(
                f"  Found {len(traces)} traces in {project} project",
                file=sys.stderr,
            )
            return traces
        print(f"  No traces found in {project} project", file=sys.stderr)
    return []


def fetch_traces_by_date_range(from_time, to_time, user_id=None):
    """Fetch ALL trace entries from Langfuse for a given date range using pagination."""
    kwargs = {"from_timestamp": from_time, "to_timestamp": to_time}
    if user_id:
        kwargs["user_id"] = user_id
    return _fetch_traces_with_fallback(kwargs)


def fetch_traces_by_session_id(session_id):
    """Fetch ALL trace entries from Langfuse for a given session ID using pagination."""
    return _fetch_traces_with_fallback({"session_id": session_id})


# ---------------------------------------------------------------------------
# Validation API call
# ---------------------------------------------------------------------------
def validate_trace(trace_id):
    """Call the validation API for a single trace. Returns (response_dict, http_status)."""
    payload = json.dumps({"trace_id": trace_id}).encode("utf-8")
    req = urllib.request.Request(
        API_URL,
        data=payload,
        headers={
            "Authorization": f"Bearer {API_TOKEN}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    ctx = ssl.create_default_context()

    try:
        with urllib.request.urlopen(req, timeout=300, context=ctx) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            return body, resp.status
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8", errors="replace")
        try:
            error_json = json.loads(error_body)
        except json.JSONDecodeError:
            error_json = {"detail": error_body}
        return error_json, e.code
    except Exception as e:
        return {"detail": str(e)}, 0


# ---------------------------------------------------------------------------
# Score extraction
# ---------------------------------------------------------------------------
SCORE_KEY_MAP = {
    "Groundedness": "groundedness score",
    "Validity": "validity score",
    "Coherence": "coherence score",
    "Utility": "utility score",
    "Tool Validation": "tool validation score",
}


def _extract_score(text_response, category_name):
    """Extract score from <structured_output> tags in a text response."""
    score_key = SCORE_KEY_MAP.get(category_name)
    if not score_key:
        return None

    pattern = r"<structured_output>\s*(.*?)\s*</structured_output>"
    matches = re.findall(pattern, text_response, re.DOTALL)

    for match_text in matches:
        clean = re.sub(r"^```json\s*", "", match_text.strip())
        clean = re.sub(r"\s*```$", "", clean)
        clean = re.sub(r",(\s*[}\]])", r"\1", clean)
        try:
            data = json.loads(clean)
            if isinstance(data, dict) and score_key in data:
                val = data[score_key]
                if isinstance(val, (int, float)):
                    return int(val)
                if isinstance(val, str):
                    m = re.search(r"(\d+)", val)
                    if m:
                        return int(m.group(1))
        except json.JSONDecodeError:
            continue

    return None


# ---------------------------------------------------------------------------
# Summary generation
# ---------------------------------------------------------------------------
CATEGORIES = ["Groundedness", "Validity", "Coherence", "Utility", "Tool Validation"]


def generate_summary(all_results):
    """Generate a cross-trace summary with per-category score aggregation."""
    category_scores = {cat: [] for cat in CATEGORIES}

    for entry in all_results:
        result = entry.get("result", {})
        criteria = result.get("criteria_results", {})

        for cat_name in CATEGORIES:
            cat_data = criteria.get(cat_name, {})
            if not isinstance(cat_data, dict):
                continue

            text_resp = cat_data.get("text_response", "")
            score = _extract_score(text_resp, cat_name)
            if score is not None:
                category_scores[cat_name].append(
                    {"trace_id": entry["trace_id"], "score": score}
                )

    summary = {}
    for cat_name, scores in category_scores.items():
        if scores:
            score_values = [s["score"] for s in scores]
            summary[cat_name] = {
                "average_score": round(sum(score_values) / len(score_values), 2),
                "min_score": min(score_values),
                "max_score": max(score_values),
                "total_evaluated": len(score_values),
                "per_trace": scores,
            }
        else:
            summary[cat_name] = {
                "average_score": None,
                "min_score": None,
                "max_score": None,
                "total_evaluated": 0,
                "per_trace": [],
            }

    return summary


# ---------------------------------------------------------------------------
# Markdown report generation
# ---------------------------------------------------------------------------
STATUS_MAP = {"RIGHT NODE": "SUCCESS", "WRONG NODE": "FAILURE"}


def _normalize_status(raw_status):
    """Map 'RIGHT NODE'/'WRONG NODE' to 'SUCCESS'/'FAILURE'."""
    if not raw_status:
        return "N/A"
    for key, val in STATUS_MAP.items():
        if key in raw_status.upper():
            return val
    return raw_status


def _extract_status(text_response, category_name):
    """Extract status from <structured_output> tags."""
    status_key_map = {
        "Groundedness": "groundedness status",
        "Validity": "validity status",
        "Coherence": "coherence status",
        "Utility": "utility status",
        "Tool Validation": "tool validation status",
    }
    status_key = status_key_map.get(category_name)
    if not status_key:
        return "N/A"

    pattern = r"<structured_output>\s*(.*?)\s*</structured_output>"
    matches = re.findall(pattern, text_response, re.DOTALL)
    for match_text in matches:
        clean = re.sub(r"^```json\s*", "", match_text.strip())
        clean = re.sub(r"\s*```$", "", clean)
        clean = re.sub(r",(\s*[}\]])", r"\1", clean)
        try:
            data = json.loads(clean)
            if isinstance(data, dict) and status_key in data:
                return _normalize_status(str(data[status_key]))
        except json.JSONDecodeError:
            continue
    return "N/A"


def _extract_claim_details(text_response):
    """Extract claim details from TOOL_CALL_DETAILS in Groundedness response."""
    import ast as _ast

    pattern = r"<TOOL_CALL_DETAILS>\s*(.*?)\s*</TOOL_CALL_DETAILS>"
    matches = re.findall(pattern, text_response, re.DOTALL)
    for m in matches:
        try:
            d = _ast.literal_eval(m)
            return d.get("output", {})
        except Exception:
            continue
    return {}


def generate_trace_report(entry, idx):
    """Generate a markdown report for a single trace."""
    trace_id = entry["trace_id"]
    status_code = entry["status_code"]
    result = entry.get("result", {})
    metadata = entry.get("metadata", {})

    lines = []
    lines.append(f"# Trace Report: `{trace_id}`\n")
    lines.append(f"**Generated:** {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}")
    lines.append(f"**Trace Index:** {idx + 1}\n")
    if metadata:
        lines.append(f"- **Name:** {metadata.get('name', 'N/A')}")
        lines.append(f"- **Timestamp:** {metadata.get('timestamp', 'N/A')}")
    lines.append(f"- **API Status:** {status_code}")
    lines.append(f"- **Observations:** {result.get('observation_count', 'N/A')}")
    lines.append(f"- **Elapsed:** {result.get('elapsed_seconds', 'N/A')}s\n")

    if status_code != 200:
        lines.append(f"**Error:** {result.get('detail', 'Unknown error')}\n")
        return "\n".join(lines), {}

    criteria = result.get("criteria_results", {})

    # Criteria summary table
    scores_row = {}
    lines.append("## Criteria Summary\n")
    lines.append("| Criteria | Status | Score |")
    lines.append("|---|---|---|")
    for cat in CATEGORIES:
        cat_data = criteria.get(cat, {})
        if not isinstance(cat_data, dict):
            lines.append(f"| **{cat}** | N/A | N/A |")
            continue
        text_resp = cat_data.get("text_response", "")
        score = _extract_score(text_resp, cat)
        status = _extract_status(text_resp, cat)
        score_str = f"{score}/5" if score is not None else "N/A"
        lines.append(f"| **{cat}** | {status} | {score_str} |")
        scores_row[cat] = score
    lines.append("")

    # Groundedness claim details
    g_data = criteria.get("Groundedness", {})
    if isinstance(g_data, dict):
        g_text = g_data.get("text_response", "")
        claim_output = _extract_claim_details(g_text)
        claims = claim_output.get("claim_details", [])
        if claims:
            lines.append("## Groundedness Claims\n")
            lines.append("| # | Claim Text | Claimed | Source Data | Type | Error | Status | Reason |")
            lines.append("|---|---|---|---|---|---|---|---|")
            for c in claims:
                lines.append(
                    f"| {c.get('claim_id', '')} "
                    f"| {c.get('claim_text', '')} "
                    f"| {c.get('claimed_value', '')} "
                    f"| {str(c.get('source_data', ''))} "
                    f"| {c.get('input_transformation_type', '')} "
                    f"| {c.get('Error in claim', '')} "
                    f"| {c.get('status', '')} "
                    f"| {c.get('reason', '')} |"
                )
            lines.append("")

            # Failed claims only
            failed = [c for c in claims if c.get("status") == "FAILURE"]
            if failed:
                lines.append("## Failed Claims\n")
                lines.append("| # | Claim Text | Claimed | Source Data | Error | Reason |")
                lines.append("|---|---|---|---|---|---|")
                for c in failed:
                    lines.append(
                        f"| {c.get('claim_id', '')} "
                        f"| {c.get('claim_text', '')} "
                        f"| {c.get('claimed_value', '')} "
                        f"| {str(c.get('source_data', ''))} "
                        f"| {c.get('Error in claim', '')} "
                        f"| {c.get('reason', '')} |"
                    )
                lines.append("")

    # Per-criteria full analysis
    for cat in CATEGORIES:
        cat_data = criteria.get(cat, {})
        if not isinstance(cat_data, dict):
            continue
        text_resp = cat_data.get("text_response", "")
        if text_resp:
            lines.append(f"## {cat} - Full Analysis\n")
            lines.append(text_resp)
            lines.append("")

    return "\n".join(lines), scores_row


def _collect_failed_claims(all_results):
    """Collect all failed Groundedness claims across traces."""
    failed_by_trace = []
    for entry in all_results:
        trace_id = entry["trace_id"]
        result = entry.get("result", {})
        criteria = result.get("criteria_results", {})
        g_data = criteria.get("Groundedness", {})
        if not isinstance(g_data, dict):
            continue
        g_text = g_data.get("text_response", "")
        claim_output = _extract_claim_details(g_text)
        claims = claim_output.get("claim_details", [])
        failed = [c for c in claims if c.get("status") == "FAILURE"]
        if failed:
            failed_by_trace.append({"trace_id": trace_id, "failed_claims": failed})
    return failed_by_trace


def _extract_node_results(text_response):
    """Extract per-node results from Validity/Coherence/Utility text_response."""
    import ast as _ast

    pattern = r"<TOOL_CALL_DETAILS>\s*(.*?)\s*</TOOL_CALL_DETAILS>"
    matches = re.findall(pattern, text_response, re.DOTALL)
    for m in matches:
        try:
            d = _ast.literal_eval(m)
            return d.get("output", {})
        except Exception:
            continue
    return {}


def generate_summary_report(all_results, summary, trace_scores, report_files):
    """Generate a cross-trace summary markdown report."""
    lines = []
    lines.append("# Batch Validation Summary\n")
    lines.append(f"**Generated:** {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}")
    lines.append(f"**Total Traces:** {len(all_results)}\n")

    # Link to individual reports
    lines.append("## Individual Trace Reports\n")
    for trace_id, filename in report_files:
        lines.append(f"- [`{trace_id}`]({filename})")
    lines.append("")

    # Overall score table
    lines.append("## Overall Scores\n")
    lines.append("| Criteria | Average | Min | Max | Traces |")
    lines.append("|---|---|---|---|---|")
    for cat in CATEGORIES:
        s = summary.get(cat, {})
        avg = s.get("average_score")
        mn = s.get("min_score")
        mx = s.get("max_score")
        cnt = s.get("total_evaluated", 0)
        lines.append(
            f"| **{cat}** "
            f"| {f'{avg}/5' if avg is not None else 'N/A'} "
            f"| {f'{mn}/5' if mn is not None else 'N/A'} "
            f"| {f'{mx}/5' if mx is not None else 'N/A'} "
            f"| {cnt} |"
        )
    lines.append("")

    # Per-trace breakdown table
    lines.append("## Per-Trace Breakdown\n")
    header = "| Trace ID | " + " | ".join(CATEGORIES) + " |"
    sep = "|---|" + "|".join(["---"] * len(CATEGORIES)) + "|"
    lines.append(header)
    lines.append(sep)
    for row in trace_scores:
        tid = row["trace_id"][:16] + "..."
        scores = []
        for cat in CATEGORIES:
            s = row.get(cat)
            scores.append(f"{s}/5" if s is not None else "N/A")
        lines.append(f"| `{tid}` | " + " | ".join(scores) + " |")
    lines.append("")

    # --- Category-wise strengths & weaknesses ---
    lines.append("---\n")
    lines.append("## Category-Wise Analysis\n")

    for cat in CATEGORIES:
        s = summary.get(cat, {})
        avg = s.get("average_score")
        per_trace = s.get("per_trace", [])
        lines.append(f"### {cat}\n")

        if not per_trace:
            lines.append("No traces evaluated for this category.\n")
            continue

        score_values = [p["score"] for p in per_trace]
        perfect = sum(1 for v in score_values if v == 5)
        low = [p for p in per_trace if p["score"] < 4]

        # Strengths
        lines.append("**Strengths:**")
        if perfect == len(per_trace):
            lines.append(f"- All {len(per_trace)} traces scored 5/5 — excellent performance across the board.")
        elif perfect > 0:
            lines.append(f"- {perfect}/{len(per_trace)} traces achieved a perfect score of 5/5.")
        if avg is not None and avg >= 4.0:
            lines.append(f"- Strong average score of {avg}/5.")
        lines.append("")

        # Weaknesses
        lines.append("**Weaknesses:**")
        if low:
            for p in low:
                lines.append(f"- Trace `{p['trace_id'][:16]}...` scored {p['score']}/5.")
        elif avg is not None and avg < 5.0:
            lines.append(f"- Average score ({avg}/5) indicates minor room for improvement.")
        else:
            lines.append("- No significant weaknesses identified.")
        lines.append("")

    # --- Groundedness: Consolidated failed claims ---
    failed_by_trace = _collect_failed_claims(all_results)
    lines.append("---\n")
    lines.append("## Groundedness — Failed Claims Across All Traces\n")

    if not failed_by_trace:
        lines.append("No failed Groundedness claims across any trace.\n")
    else:
        total_failed = sum(len(t["failed_claims"]) for t in failed_by_trace)
        lines.append(f"**Total failed claims:** {total_failed} across {len(failed_by_trace)} trace(s)\n")
        lines.append("| Trace ID | # | Claim Text | Claimed | Source Data | Error | Reason |")
        lines.append("|---|---|---|---|---|---|---|")
        for t in failed_by_trace:
            tid = t["trace_id"][:16] + "..."
            for c in t["failed_claims"]:
                lines.append(
                    f"| `{tid}` "
                    f"| {c.get('claim_id', '')} "
                    f"| {c.get('claim_text', '')} "
                    f"| {c.get('claimed_value', '')} "
                    f"| {str(c.get('source_data', ''))} "
                    f"| {c.get('Error in claim', '')} "
                    f"| {c.get('reason', '')} |"
                )
        lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="Batch Validation Script")
    parser.add_argument(
        "--trace-ids",
        help="Comma-separated list of trace IDs to validate",
    )
    parser.add_argument(
        "--from-time",
        help="Start datetime in ISO format (e.g., 2026-02-10T00:00:00+00:00)",
    )
    parser.add_argument(
        "--to-time",
        help="End datetime in ISO format (e.g., 2026-02-15T23:59:59+00:00)",
    )
    parser.add_argument(
        "--user-id",
        help="Langfuse user ID filter for date range queries",
    )
    parser.add_argument(
        "--session-id",
        help="Langfuse session ID to fetch and validate all traces for",
    )
    parser.add_argument(
        "--output",
        help="Output log file path (defaults to logs/batch_validation_<timestamp>.json)",
    )
    parser.add_argument(
        "--project-root",
        help="Explicit project root directory. If omitted, auto-detected from script location.",
    )
    args = parser.parse_args()

    # Re-resolve project root and LOG_DIR when --project-root is provided
    global _project_root, LOG_DIR
    if args.project_root:
        _project_root = _find_project_root(override=args.project_root)
        LOG_DIR = _project_root / "logs"
        LOG_DIR.mkdir(exist_ok=True)
        print(f"Project root (override): {_project_root}", file=sys.stderr)
    else:
        print(f"Project root (auto-detected): {_project_root}", file=sys.stderr)

    # Resolve trace IDs
    trace_ids = []
    trace_metadata = {}

    if args.trace_ids:
        trace_ids = [tid.strip() for tid in args.trace_ids.split(",") if tid.strip()]

    if args.session_id:
        print(
            f"Querying Langfuse for traces in session {args.session_id}...",
            file=sys.stderr,
        )
        fetched = fetch_traces_by_session_id(args.session_id)
        print(f"Found {len(fetched)} traces in session", file=sys.stderr)
        for t in fetched:
            if t["id"] not in trace_ids:
                trace_ids.append(t["id"])
            trace_metadata[t["id"]] = t

    if args.from_time and args.to_time:
        from_time = datetime.fromisoformat(args.from_time)
        to_time = datetime.fromisoformat(args.to_time)
        print(
            f"Querying Langfuse for traces from {from_time} to {to_time}...",
            file=sys.stderr,
        )
        fetched = fetch_traces_by_date_range(from_time, to_time, args.user_id)
        print(f"Found {len(fetched)} traces in date range", file=sys.stderr)
        for t in fetched:
            if t["id"] not in trace_ids:
                trace_ids.append(t["id"])
            trace_metadata[t["id"]] = t

    if not trace_ids:
        print(
            "ERROR: No trace IDs to validate. Provide --trace-ids or --from-time/--to-time.",
            file=sys.stderr,
        )
        sys.exit(1)

    # Setup log file
    timestamp = datetime.now().strftime("%d_%m_%Y__%H_%M_%S")
    log_file = args.output or str(LOG_DIR / f"batch_validation_{timestamp}.json")

    # Validate each trace
    all_results = []
    total = len(trace_ids)

    for idx, trace_id in enumerate(trace_ids):
        print(
            f"[{idx + 1}/{total}] Validating trace: {trace_id}...", file=sys.stderr
        )
        result, status_code = validate_trace(trace_id)
        entry = {
            "trace_id": trace_id,
            "status_code": status_code,
            "result": result,
        }
        if trace_id in trace_metadata:
            entry["metadata"] = trace_metadata[trace_id]
        all_results.append(entry)
        print(
            f"  -> Status: {status_code}, "
            f"Error count: {result.get('error_count', 'N/A')}",
            file=sys.stderr,
        )

    # Generate cross-trace summary
    summary = generate_summary(all_results)

    # Create datetime-based report folder
    report_dir = LOG_DIR / f"batch_validation_{timestamp}"
    report_dir.mkdir(exist_ok=True)

    # Write individual trace reports
    trace_scores = []
    report_files = []
    for idx, entry in enumerate(all_results):
        trace_id = entry["trace_id"]
        report_md, scores_row = generate_trace_report(entry, idx)
        scores_row["trace_id"] = trace_id
        trace_scores.append(scores_row)

        # Use short trace ID prefix for filename readability
        safe_id = trace_id[:12].replace("/", "_")
        filename = f"trace_{idx + 1}_{safe_id}.md"
        filepath = report_dir / filename
        with open(filepath, "w") as f:
            f.write(report_md)
        report_files.append((trace_id, filename))
        print(f"  Report written: {filepath}", file=sys.stderr)

    # Write summary report
    summary_md = generate_summary_report(all_results, summary, trace_scores, report_files)
    summary_file = report_dir / "SUMMARY.md"
    with open(summary_file, "w") as f:
        f.write(summary_md)
    print(f"  Summary written: {summary_file}", file=sys.stderr)

    # Build output
    output = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "total_traces": total,
        "results": all_results,
        "summary": summary,
        "log_file": log_file,
        "report_dir": str(report_dir),
    }

    # Write JSON to log file
    with open(log_file, "w") as f:
        json.dump(output, f, indent=2, default=str)

    print(f"\nJSON results written to: {log_file}", file=sys.stderr)
    print(f"Reports folder: {report_dir}", file=sys.stderr)

    # Output JSON to stdout for Claude to process
    print(json.dumps(output, indent=2, default=str))


if __name__ == "__main__":
    main()
