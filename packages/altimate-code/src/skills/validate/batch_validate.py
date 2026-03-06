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
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests
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

# Session reuses TCP connection and SSL handshake across all traces.
_SESSION = requests.Session()


def validate_trace(trace_id):
    """Call the validation API for a single trace. Returns (response_dict, http_status)."""
    try:
        resp = _SESSION.post(
            API_URL,
            json={"trace_id": trace_id},
            headers={"Authorization": f"Bearer {API_TOKEN}"},
            timeout=300,
        )
        return resp.json(), resp.status_code
    except Exception as e:
        return {"detail": str(e)}, 0


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

    # Build output
    output = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "total_traces": total,
        "results": all_results,
        "log_file": log_file,
    }

    # Write JSON to log file
    with open(log_file, "w") as f:
        json.dump(output, f, indent=2, default=str)

    print(f"\nJSON results written to: {log_file}", file=sys.stderr)
    # Create datetime-based report folder
    report_dir = LOG_DIR / f"batch_validation_{timestamp}"
    report_dir.mkdir(exist_ok=True)
    print(f"Reports folder: {report_dir}", file=sys.stderr)

    # Output JSON to stdout for Claude to process
    print(json.dumps(output, indent=2, default=str))


if __name__ == "__main__":
    main()