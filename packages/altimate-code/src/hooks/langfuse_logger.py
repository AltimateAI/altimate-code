#!/usr/bin/env python3
"""
Langfuse Logger Hook for Claude Code CLI

Logs the full lifecycle of each Claude CLI conversation turn into Langfuse:
  - User prompt (trace input)
  - Assistant thinking / reasoning
  - Assistant intermediate text responses
  - Tool calls (input) and tool results (output)
  - Final assistant response (trace output)

Structure per turn:
  Trace (name="claude-code-turn", input=user prompt, output=final response)
    └── user-turn (root span)
        ├── assistant-thinking
        ├── assistant-response
        ├── tool-call:Bash
        ├── tool-result
        ├── assistant-thinking
        └── assistant-response (final)

Uses the Langfuse batch ingestion API (not OTel) for reliable cross-process
trace/span creation with proper hierarchy.

Setup:
  1. pip install langfuse
  2. Set environment variables (or rely on defaults in this script):
       LANGFUSE_PUBLIC_KEY set from LANGFUSE_PUBLIC_KEY_VALIDATION
       LANGFUSE_SECRET_KEY set from LANGFUSE_SECRET_KEY_VALIDATION
       LANGFUSE_BASE_URL from LANGFUSE_BASE_URL_VALIDATION  (defaults to https://cloud.langfuse.com)
  3. Add hook config to $CLAUDE_DIR/.claude/settings.json (see below)

Hook config for $CLAUDE_DIR/.claude/settings.json:
  {
    "hooks": {
      "UserPromptSubmit": [{"matcher": "", "hooks": [{"type": "command", "command": "python3 $CLAUDE_DIR/.claude/hooks/langfuse_logger.py"}]}],
      "PostToolUse":      [{"matcher": "", "hooks": [{"type": "command", "command": "python3 $CLAUDE_DIR/.claude/hooks/langfuse_logger.py"}]}],
      "Stop":             [{"matcher": "", "hooks": [{"type": "command", "command": "python3 $CLAUDE_DIR/.claude/hooks/langfuse_logger.py"}]}]
    }
  }

Tested with langfuse SDK v3.9+
"""

import datetime
import json
import os
import re
import sys
import time
import traceback
import uuid
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv

# ---------------------------------------------------------------------------
# Walk-up .env loading — find .claude dir by traversing parents from script
# ---------------------------------------------------------------------------
def _find_claude_dir():
    """Find the .claude directory by walking up from script location."""
    current = Path(__file__).resolve()
    for parent in current.parents:
        if parent.name == ".claude" and parent.is_dir():
            return parent
    return None


_claude_dir = _find_claude_dir()
if _claude_dir:
    _env_path = _claude_dir / ".env"
    if _env_path.exists():
        load_dotenv(_env_path)

# ---------------------------------------------------------------------------
# Configuration - set via .env or environment variables
# ---------------------------------------------------------------------------
LANGFUSE_PUBLIC_KEY = os.environ.get("LANGFUSE_PUBLIC_KEY_VALIDATION", "")
LANGFUSE_SECRET_KEY = os.environ.get("LANGFUSE_SECRET_KEY_VALIDATION", "")
LANGFUSE_HOST = (
    os.environ.get("LANGFUSE_HOST")
    or os.environ.get("LANGFUSE_BASE_URL_VALIDATION")
    or "https://cloud.langfuse.com"
)

STATE_DIR = os.environ.get("LANGFUSE_HOOK_STATE_DIR", "/tmp")
MAX_PAYLOAD_LEN = 50_000

# Transcript message types that carry no conversational content
_NOISE_TYPES = {"progress", "file-history-snapshot"}


def _should_skip(entry: dict) -> bool:
    """Return True for transcript entries that are internal noise."""
    entry_type = entry.get("type", "")
    if entry_type in _NOISE_TYPES:
        return True
    if entry_type == "system" and entry.get("subtype") in ("hookResult", "stop"):
        return True
    return False


def _get_user_email() -> str:
    """Get user email from git config."""
    import subprocess
    try:
        result = subprocess.run(
            ["git", "config", "user.email"],
            capture_output=True, text=True, timeout=5,
        )
        email = result.stdout.strip()
        if email:
            return email
    except Exception:
        pass
    return os.environ.get("USER", "unknown")


# ---------------------------------------------------------------------------
# State management
# ---------------------------------------------------------------------------

def _state_file(session_id: str) -> str:
    safe_id = session_id.replace("/", "_").replace("..", "_")
    return os.path.join(STATE_DIR, f"claude_langfuse_trace_{safe_id}.json")


def _save_state(session_id: str, data: dict) -> None:
    with open(_state_file(session_id), "w") as f:
        json.dump(data, f)


def _load_state(session_id: str) -> Optional[dict]:
    try:
        with open(_state_file(session_id)) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


# ---------------------------------------------------------------------------
# Pending evaluation state (for post-response validation consent)
# ---------------------------------------------------------------------------

def _pending_eval_file(session_id: str) -> str:
    safe_id = session_id.replace("/", "_").replace("..", "_")
    return os.path.join(STATE_DIR, f"claude_pending_eval_{safe_id}.json")


def _save_pending_eval(session_id: str, trace_id: str) -> None:
    with open(_pending_eval_file(session_id), "w") as f:
        json.dump({"trace_id": trace_id, "timestamp": time.time()}, f)


def _load_pending_eval(session_id: str) -> Optional[dict]:
    try:
        with open(_pending_eval_file(session_id)) as f:
            data = json.load(f)
        # Expire after 10 minutes
        if time.time() - data.get("timestamp", 0) > 600:
            _clear_pending_eval(session_id)
            return None
        return data
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def _clear_pending_eval(session_id: str) -> None:
    try:
        os.remove(_pending_eval_file(session_id))
    except OSError:
        pass


def _load_latest_trace() -> Optional[str]:
    """Read the latest completed trace ID from the persistent state file."""
    state_file = Path.home() / ".claude" / "state" / "current_trace.json"
    try:
        data = json.loads(state_file.read_text())
        return data.get("trace_id")
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def _get_langfuse():
    from langfuse import Langfuse
    return Langfuse(
        public_key=LANGFUSE_PUBLIC_KEY,
        secret_key=LANGFUSE_SECRET_KEY,
        host=LANGFUSE_HOST,
    )


def _truncate(value: str, max_len: int = MAX_PAYLOAD_LEN) -> str:
    if len(value) > max_len:
        return value[:max_len] + "... [truncated]"
    return value


def _ts() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


# ---------------------------------------------------------------------------
# Batch ingestion helpers
# ---------------------------------------------------------------------------

def _create_trace(lf, trace_id: str, **kwargs) -> None:
    """Create or update a trace via the batch ingestion API."""
    from langfuse.api.resources.ingestion.types import IngestionEvent_TraceCreate
    from langfuse.api.resources.ingestion.types.trace_body import TraceBody

    lf.api.ingestion.batch(batch=[
        IngestionEvent_TraceCreate(
            id=str(uuid.uuid4()),
            type="trace-create",
            timestamp=_ts(),
            body=TraceBody(id=trace_id, **kwargs),
        ),
    ])


def _create_span(lf, span_id: str, trace_id: str, parent_id: Optional[str] = None,
                  **kwargs) -> None:
    """Create a span via the batch ingestion API."""
    from langfuse.api.resources.ingestion.types import IngestionEvent_SpanCreate
    from langfuse.api.resources.ingestion.types.create_span_body import CreateSpanBody

    body_kwargs = {"id": span_id, "trace_id": trace_id, **kwargs}
    if parent_id:
        body_kwargs["parent_observation_id"] = parent_id

    lf.api.ingestion.batch(batch=[
        IngestionEvent_SpanCreate(
            id=str(uuid.uuid4()),
            type="span-create",
            timestamp=_ts(),
            body=CreateSpanBody(**body_kwargs),
        ),
    ])


def _update_span(lf, span_id: str, trace_id: str, **kwargs) -> None:
    """Update a span via the batch ingestion API."""
    from langfuse.api.resources.ingestion.types import IngestionEvent_SpanUpdate
    from langfuse.api.resources.ingestion.types.update_span_body import UpdateSpanBody

    lf.api.ingestion.batch(batch=[
        IngestionEvent_SpanUpdate(
            id=str(uuid.uuid4()),
            type="span-update",
            timestamp=_ts(),
            body=UpdateSpanBody(id=span_id, trace_id=trace_id, **kwargs),
        ),
    ])


def _batch_create_spans(lf, spans: list) -> None:
    """Create multiple spans in a single batch call."""
    from langfuse.api.resources.ingestion.types import IngestionEvent_SpanCreate
    from langfuse.api.resources.ingestion.types.create_span_body import CreateSpanBody

    if not spans:
        return

    events = []
    for s in spans:
        events.append(IngestionEvent_SpanCreate(
            id=str(uuid.uuid4()),
            type="span-create",
            timestamp=_ts(),
            body=CreateSpanBody(**s),
        ))

    lf.api.ingestion.batch(batch=events)


def _batch_create_generations(lf, generations: list) -> None:
    """Create multiple generations in a single batch call."""
    from langfuse.api.resources.ingestion.types import IngestionEvent_GenerationCreate
    from langfuse.api.resources.ingestion.types.create_generation_body import CreateGenerationBody

    if not generations:
        return

    events = []
    for g in generations:
        events.append(IngestionEvent_GenerationCreate(
            id=str(uuid.uuid4()),
            type="generation-create",
            timestamp=_ts(),
            body=CreateGenerationBody(**g),
        ))

    lf.api.ingestion.batch(batch=events)


# ---------------------------------------------------------------------------
# Transcript parsing
# ---------------------------------------------------------------------------

def _read_new_transcript_lines(transcript_path: str, last_line_read: int) -> list:
    if not transcript_path or not os.path.exists(transcript_path):
        return []
    try:
        with open(transcript_path) as f:
            all_lines = f.readlines()
        parsed = []
        for line in all_lines[last_line_read:]:
            line = line.strip()
            if line:
                try:
                    parsed.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
        return parsed
    except Exception:
        return []


def _count_transcript_lines(transcript_path: str) -> int:
    if not transcript_path or not os.path.exists(transcript_path):
        return 0
    try:
        with open(transcript_path) as f:
            return sum(1 for _ in f)
    except Exception:
        return 0


def _extract_content_blocks(content) -> dict:
    """Extract text, thinking, and tool_use blocks from message content."""
    result = {"texts": [], "thinking": [], "tool_uses": []}

    if isinstance(content, str):
        if content.strip():
            result["texts"].append(content)
        return result

    if not isinstance(content, list):
        return result

    for block in content:
        if not isinstance(block, dict):
            continue
        btype = block.get("type", "")
        if btype == "text":
            text = block.get("text", "")
            if text.strip():
                result["texts"].append(text)
        elif btype == "thinking":
            thinking = block.get("thinking", "")
            if thinking.strip():
                result["thinking"].append(thinking)
        elif btype == "tool_use":
            result["tool_uses"].append({
                "id": block.get("id", ""),
                "name": block.get("name", ""),
                "input": block.get("input", {}),
            })

    return result


def _build_spans_from_transcript(trace_id: str, turn_span_id: str,
                                  new_lines: list, span_count: int,
                                  base_time: datetime.datetime) -> tuple:
    """Build span and generation dicts from transcript lines for batch creation.

    Returns (list_of_span_dicts, list_of_generation_dicts, updated_span_count).
    Assistant text responses are emitted as generations; everything else as spans.
    """
    spans = []
    generations = []
    offset = 0

    for entry in new_lines:
        if _should_skip(entry):
            continue

        entry_type = entry.get("type", "")

        if entry_type == "assistant":
            content = entry.get("message", {}).get("content", "")
            blocks = _extract_content_blocks(content)

            for thinking_text in blocks["thinking"]:
                span_count += 1
                offset += 1
                spans.append({
                    "id": str(uuid.uuid4()),
                    "trace_id": trace_id,
                    "parent_observation_id": turn_span_id,
                    "name": "assistant-thinking",
                    "start_time": base_time + datetime.timedelta(milliseconds=offset),
                    "end_time": base_time + datetime.timedelta(milliseconds=offset + 1),
                    "input": _truncate(thinking_text),
                    "metadata": {"span_index": span_count},
                })

            for text in blocks["texts"]:
                span_count += 1
                offset += 1
                generations.append({
                    "id": str(uuid.uuid4()),
                    "trace_id": trace_id,
                    "parent_observation_id": turn_span_id,
                    "name": "assistant-response",
                    "start_time": base_time + datetime.timedelta(milliseconds=offset),
                    "end_time": base_time + datetime.timedelta(milliseconds=offset + 1),
                    "output": _truncate(text),
                    "metadata": {"span_index": span_count},
                })

            for tool_use in blocks["tool_uses"]:
                span_count += 1
                offset += 1
                spans.append({
                    "id": str(uuid.uuid4()),
                    "trace_id": trace_id,
                    "parent_observation_id": turn_span_id,
                    "name": f"tool-call:{tool_use['name']}",
                    "start_time": base_time + datetime.timedelta(milliseconds=offset),
                    "end_time": base_time + datetime.timedelta(milliseconds=offset + 1),
                    "input": _truncate(json.dumps(tool_use["input"], default=str)),
                    "metadata": {
                        "tool_use_id": tool_use["id"],
                        "span_index": span_count,
                    },
                })

        elif entry_type == "user":
            tool_use_result = entry.get("toolUseResult")
            if tool_use_result:
                span_count += 1
                offset += 1
                spans.append({
                    "id": str(uuid.uuid4()),
                    "trace_id": trace_id,
                    "parent_observation_id": turn_span_id,
                    "name": "tool-result",
                    "start_time": base_time + datetime.timedelta(milliseconds=offset),
                    "end_time": base_time + datetime.timedelta(milliseconds=offset + 1),
                    "input": _truncate(str(tool_use_result)),
                    "metadata": {
                        "sourceToolAssistantUUID": entry.get("sourceToolAssistantUUID", ""),
                        "span_index": span_count,
                    },
                })

    return spans, generations, span_count


def _extract_final_assistant_text(lines: list) -> str:
    """Walk lines in reverse to find the last assistant text response."""
    for entry in reversed(lines):
        if entry.get("type") == "assistant":
            blocks = _extract_content_blocks(entry.get("message", {}).get("content", ""))
            if blocks["texts"]:
                return "\n".join(blocks["texts"])
    return ""


# ---------------------------------------------------------------------------
# MCP state file
# ---------------------------------------------------------------------------

def write_state_file(trace_id: str, session_id: str) -> None:
    """Write the current trace info to the state file for the MCP server."""
    state_dir = Path.home() / ".claude" / "state"
    state_dir.mkdir(parents=True, exist_ok=True)

    state_file = state_dir / "current_trace.json"
    state_file.write_text(
        json.dumps({
            "trace_id": trace_id,
            "session_id": session_id,
            "updated_at": _now().isoformat(),
        })
    )


# ---------------------------------------------------------------------------
# Event handlers
# ---------------------------------------------------------------------------

def _normalize_date(date_str):
    """Normalize a date string to ISO format with timezone."""
    date_str = date_str.strip()
    # Already ISO datetime with timezone
    if "T" in date_str and ("+" in date_str or date_str.endswith("Z")):
        return date_str
    # ISO datetime without timezone
    if "T" in date_str:
        return date_str + "+00:00"
    # Date only (YYYY-MM-DD) — append time
    if re.match(r"^\d{4}-\d{2}-\d{2}$", date_str):
        return date_str + "T00:00:00+00:00"
    # Return as-is and let batch_validate.py handle parsing
    return date_str


def _parse_validate_prompt(prompt_stripped, prompt_lower, session_id):
    """Parse validation prompt patterns. Returns additionalContext string or None."""

    # Pattern 1: "validate from <date> to <date> [for/user <user_id>]"
    date_range_match = re.match(
        r"validate\s+(?:all\s+)?(?:traces?\s+)?from\s+(\S+)\s+to\s+(\S+)"
        r"(?:\s+(?:for|user|--user-id)\s+(\S+))?",
        prompt_lower,
    )
    if date_range_match:
        from_date = _normalize_date(date_range_match.group(1))
        to_date = _normalize_date(date_range_match.group(2))
        # For end dates that are date-only, use end of day
        raw_to = date_range_match.group(2).strip()
        if re.match(r"^\d{4}-\d{2}-\d{2}$", raw_to):
            to_date = raw_to + "T23:59:59+00:00"

        args = f"--from {from_date} --to {to_date}"
        user_id = date_range_match.group(3)
        if user_id:
            args += f" --user-id {user_id}"

        _clear_pending_eval(session_id)
        return f"Run the /validate skill with the arguments: /validate {args}"

    # Pattern 2: "validate" or "validate the answer" — latest trace
    if prompt_lower in ("validate", "validate the answer"):
        # Prefer the session-scoped pending eval (set right after the last Stop event)
        pending = _load_pending_eval(session_id)
        if pending:
            trace_id_eval = pending["trace_id"]
            _clear_pending_eval(session_id)
            return f"Run the /validate skill with the trace ID: /validate {trace_id_eval}"
        # Fall back to the persistent latest-trace file (never expires)
        latest = _load_latest_trace()
        if latest:
            return f"Run the /validate skill with the trace ID: /validate {latest}"
        # No trace available — skip logging this bare user-turn
        return ""

    # Pattern 3: "validate <anything_else>" — pass through as trace IDs
    if prompt_lower.startswith("validate "):
        args = prompt_stripped[len("validate "):].strip()
        if args:
            _clear_pending_eval(session_id)
            return f"Run the /validate skill with: /validate {args}"

    return None


def handle_user_prompt_submit(lf, data: dict) -> None:
    """Create trace + root turn span via batch API."""
    session_id = data.get("session_id", "unknown")
    prompt = data.get("prompt", "")
    cwd = data.get("cwd", "")
    transcript_path = data.get("transcript_path", "")

    # Check if user is requesting validation
    prompt_lower = prompt.strip().lower()
    prompt_stripped = prompt.strip()

    additional_context = _parse_validate_prompt(prompt_stripped, prompt_lower, session_id)
    if additional_context is not None:
        if additional_context:
            json.dump({"additionalContext": additional_context}, sys.stdout)
        return  # Skip trace creation for bare validate turns and validation redirects

    trace_id = lf.create_trace_id(seed=f"{session_id}-{int(time.time() * 1000)}")
    turn_span_id = str(uuid.uuid4())
    now = _now()

    # Create trace and root span in a single batch
    _create_trace(lf, trace_id,
        name="claude-code-turn",
        session_id=session_id,
        user_id=_get_user_email(),
        input=prompt,
        metadata={"cwd": cwd, "permission_mode": data.get("permission_mode", "")},
    )
    _create_span(lf, turn_span_id, trace_id,
        name="user-turn",
        start_time=now,
        input=prompt,
        metadata={"cwd": cwd, "permission_mode": data.get("permission_mode", "")},
    )

    line_count = _count_transcript_lines(transcript_path)

    _save_state(session_id, {
        "trace_id": trace_id,
        "turn_span_id": turn_span_id,
        "created_at": time.time(),
        "span_count": 0,
        "transcript_path": transcript_path,
        "last_line_read": line_count,
    })


def handle_post_tool_use(lf, data: dict) -> None:
    """Read new transcript lines → batch-create child spans."""
    session_id = data.get("session_id", "unknown")
    state = _load_state(session_id)
    if not state:
        return

    trace_id = state["trace_id"]
    turn_span_id = state["turn_span_id"]
    transcript_path = state.get("transcript_path") or data.get("transcript_path", "")
    last_line_read = state.get("last_line_read", 0)

    new_lines = _read_new_transcript_lines(transcript_path, last_line_read)
    span_count = state.get("span_count", 0)

    if new_lines:
        spans, generations, span_count = _build_spans_from_transcript(
            trace_id, turn_span_id, new_lines, span_count, _now()
        )
        if spans:
            _batch_create_spans(lf, spans)
        if generations:
            _batch_create_generations(lf, generations)

    state["span_count"] = span_count
    state["last_line_read"] = last_line_read + len(new_lines)
    state["transcript_path"] = transcript_path
    _save_state(session_id, state)


def handle_stop(lf, data: dict) -> None:
    """Log remaining transcript, close root span, set trace output."""
    session_id = data.get("session_id", "unknown")
    state = _load_state(session_id)
    if not state:
        return

    trace_id = state["trace_id"]
    turn_span_id = state["turn_span_id"]
    transcript_path = state.get("transcript_path") or data.get("transcript_path", "")
    last_line_read = state.get("last_line_read", 0)
    span_count = state.get("span_count", 0)
    duration = round(time.time() - state.get("created_at", 0), 2)

    # Log remaining transcript lines
    new_lines = _read_new_transcript_lines(transcript_path, last_line_read)
    if new_lines:
        spans, generations, span_count = _build_spans_from_transcript(
            trace_id, turn_span_id, new_lines, span_count, _now()
        )
        if spans:
            _batch_create_spans(lf, spans)
        if generations:
            _batch_create_generations(lf, generations)

    # Extract final assistant text
    final_output = _extract_final_assistant_text(new_lines)

    # Close root span with output
    _update_span(lf, turn_span_id, trace_id,
        end_time=_now(),
        output=_truncate(final_output) if final_output else "Turn completed",
    )

    # Update trace output (does NOT overwrite name/session/input)
    _create_trace(lf, trace_id,
        output=_truncate(final_output) if final_output else "Turn completed",
        metadata={
            "status": "completed",
            "total_spans": span_count,
            "duration_seconds": duration,
        },
    )

    # Save trace ID so user can trigger validation on-demand with "validate"
    _save_pending_eval(session_id, trace_id)

    # Write MCP state file for external consumers
    write_state_file(trace_id, session_id)

    # Clean up trace state
    try:
        os.remove(_state_file(session_id))
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

HANDLERS = {
    "UserPromptSubmit": handle_user_prompt_submit,
    "PostToolUse": handle_post_tool_use,
    "Stop": handle_stop,
}


def main() -> None:
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            return
        data = json.loads(raw)
    except (json.JSONDecodeError, Exception):
        return

    event = data.get("hook_event_name", "")
    handler = HANDLERS.get(event)
    if not handler:
        return

    try:
        lf = _get_langfuse()
        handler(lf, data)
    except Exception:
        log_path = os.path.join(STATE_DIR, "claude_langfuse_errors.log")
        with open(log_path, "a") as f:
            f.write(f"\n--- {time.strftime('%Y-%m-%d %H:%M:%S')} [{event}] ---\n")
            traceback.print_exc(file=f)


if __name__ == "__main__":
    main()
