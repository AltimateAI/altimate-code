import json
import os
import shlex
from pathlib import Path
from typing import Any

from ade_bench.agents.agent_name import AgentName
from ade_bench.agents.installed_agents.abstract_installed_agent import (
    AbstractInstalledAgent,
)
from ade_bench.agents.log_formatter import LogFormatter
from ade_bench.harness_models import TerminalCommand
from ade_bench.config import config
from ade_bench.agents.base_agent import AgentResult
from ade_bench.terminal.tmux_session import TmuxSession


class AltimateCodeLogFormatter(LogFormatter):
    """Log formatter for altimate-code JSON event stream."""

    def parse_log_file(self, log_path: Path) -> list[dict[str, Any]]:
        turns: list[dict[str, Any]] = []
        current_turn: dict[str, Any] | None = None
        turn_number = 0

        try:
            for line in log_path.read_text().splitlines():
                line = line.strip()
                if not line or not line.startswith("{"):
                    continue
                try:
                    data = json.loads(line)
                except json.JSONDecodeError:
                    continue

                msg_type = data.get("type", "unknown")
                if msg_type == "text":
                    turn_number += 1
                    current_turn = {
                        "turn": turn_number,
                        "thinking": [data.get("text", "")],
                        "tools": [],
                        "results": [],
                    }
                    turns.append(current_turn)
                elif msg_type == "tool_start":
                    if current_turn is None:
                        turn_number += 1
                        current_turn = {"turn": turn_number, "thinking": [], "tools": [], "results": []}
                        turns.append(current_turn)
                    current_turn["tools"].append(
                        {"name": data.get("tool", "unknown"), "input": data.get("input", {})}
                    )
                elif msg_type == "tool_end" and current_turn:
                    current_turn["results"].append(
                        {"content": data.get("output", ""), "is_error": data.get("is_error", False)}
                    )
        except Exception:
            pass

        return turns

    def format_readable_log(self, turns: list[dict[str, Any]]) -> str:
        lines = ["=" * 80, "ALTIMATE CODE AGENT INTERACTION LOG", "=" * 80, ""]
        for turn in turns:
            lines.append(f"--- TURN {turn['turn']} ---")
            for thought in turn.get("thinking", []):
                lines.append(f"[ASSISTANT] {thought[:500]}")
            for tool in turn.get("tools", []):
                lines.append(f"[TOOL] {tool['name']}")
            for result in turn.get("results", []):
                prefix = "[ERROR]" if result.get("is_error") else "[RESULT]"
                lines.append(f"{prefix} {str(result.get('content', ''))[:200]}")
            lines.append("")
        lines.extend(["=" * 80, "END OF LOG", "=" * 80])
        return "\n".join(lines)


class AltimateCodeParser:
    """Parser for altimate-code --format json output to extract benchmark metrics."""

    def parse(self, content: str) -> dict[str, Any]:
        default = {
            "runtime_ms": 0,
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_tokens": 0,
            "cost_usd": 0.0,
            "num_turns": 0,
            "success": False,
            "error": None,
            "model_name": "default",
        }

        try:
            input_tokens = output_tokens = cache_tokens = num_turns = 0
            cost_usd = 0.0
            runtime_ms = 0
            model_name: str | None = None
            success = False
            first_ts: int | None = None
            last_ts: int | None = None
            saw_step_finish = False

            for raw in content.splitlines():
                raw = raw.strip()
                if not raw.startswith("{"):
                    continue
                try:
                    data = json.loads(raw)
                except json.JSONDecodeError:
                    continue

                msg_type = data.get("type")
                ts = data.get("timestamp")
                if isinstance(ts, int):
                    first_ts = ts if first_ts is None else first_ts
                    last_ts = ts

                if msg_type == "system":
                    model_name = model_name or data.get("model")
                # altimate-code emits per-step usage as `step_finish` events.
                # Each event carries `part.tokens.{input,output,reasoning,cache}`
                # as PER-STEP deltas plus `part.cost` per-step in USD.
                if msg_type == "step_finish":
                    saw_step_finish = True
                    part = data.get("part", {}) or {}
                    tokens = part.get("tokens", {}) or {}
                    cache = tokens.get("cache", {}) or {}
                    input_tokens += int(tokens.get("input", 0) or 0)
                    output_tokens += int(tokens.get("output", 0) or 0)
                    cache_tokens += int(cache.get("read", 0) or 0)
                    cost_usd += float(part.get("cost", 0) or 0)
                    if part.get("reason") == "stop":
                        num_turns += 1
                        success = True
                if msg_type == "text":
                    # Surface assistant text turns when no step_finish events
                    # were emitted (older altimate-code format / aborted runs).
                    if not saw_step_finish:
                        num_turns += 1
                # Legacy summary event shape — kept as a fallback.
                if msg_type in ("done", "result"):
                    usage = data.get("usage", {})
                    if usage:
                        input_tokens = usage.get("input_tokens", input_tokens) or input_tokens
                        output_tokens = usage.get("output_tokens", output_tokens) or output_tokens
                        cache_tokens = usage.get("cache_read_input_tokens", cache_tokens) or cache_tokens
                    cost_usd = data.get("total_cost_usd", cost_usd) or cost_usd
                    runtime_ms = data.get("duration_ms", runtime_ms) or runtime_ms
                    if not saw_step_finish:
                        num_turns = data.get("num_turns", num_turns) or num_turns
                    model_name = data.get("model_name", model_name) or model_name
                    if "is_error" in data:
                        success = not data.get("is_error", True)

            if not runtime_ms and first_ts is not None and last_ts is not None:
                runtime_ms = max(0, last_ts - first_ts)

            return {
                "runtime_ms": runtime_ms,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cache_tokens": cache_tokens,
                "cost_usd": cost_usd,
                "num_turns": num_turns,
                "success": success,
                "error": None,
                "model_name": model_name or "default",
            }
        except Exception:
            return default


class AltimateCodeAgent(AbstractInstalledAgent):
    NAME = AgentName.ALTIMATE_CODE

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._parser = AltimateCodeParser()
        self._log_formatter = AltimateCodeLogFormatter()

    def _parse_agent_output(self, output: str) -> dict[str, Any]:
        result = self._parser.parse(output)
        # altimate-code's JSON event stream doesn't carry the model id; fall
        # back to whatever the harness invoked us with.
        if (not result.get("model_name") or result["model_name"] == "default") and self._model_name:
            result["model_name"] = self._model_name
        return result

    @property
    def _env(self) -> dict[str, str]:
        forward_keys = (
            "ANTHROPIC_API_KEY",
            "AZURE_RESOURCE_NAME",
            "AZURE_API_KEY",
            "AZURE_API_VERSION",
            "AZURE_BASE_URL",
            "AZURE_DEPLOYMENT_NAME",
            "OPENAI_API_KEY",
            "OPENROUTER_API_KEY",
            "OPENROUTER_MODEL_ID",
        )
        return {k: os.environ[k] for k in forward_keys if k in os.environ}

    @property
    def _install_agent_script(self) -> Path:
        return Path(__file__).parent / "altimate-code-setup.sh"

    @property
    def _local_tarball_path(self) -> Path:
        return Path(__file__).parent / "altimate-code-local.tgz"

    def perform_task(self, task_prompt, session, logging_dir=None, task_name=None) -> AgentResult:
        if self._local_tarball_path.exists():
            session.copy_to_container(
                self._local_tarball_path,
                container_dir="/installed-agent",
                container_filename="altimate-code-local.tgz",
            )
        return super().perform_task(task_prompt, session, logging_dir=logging_dir, task_name=task_name)

    def _run_agent_commands(self, task_prompt: str) -> list[TerminalCommand]:
        escaped_prompt = shlex.quote(task_prompt)
        command = f"echo 'AGENT RESPONSE: ' && altimate-code run --format json --yolo"

        if self._model_name:
            command += f" --model {shlex.quote(self._model_name)}"
        command += f" --max-turns 80 {escaped_prompt}"

        return [
            TerminalCommand(
                command=command,
                min_timeout_sec=0.0,
                max_timeout_sec=config.default_agent_timeout_sec,
                block=True,
                append_enter=True,
            )
        ]

    def format_agent_log(self, log_path: Path) -> str | None:
        return self._log_formatter.format_log(log_path)

    def extract_tools_used(self, log_path: Path) -> list[str] | None:
        try:
            tool_names: set[str] = set()
            for line in log_path.read_text().splitlines():
                line = line.strip()
                if not line.startswith("{"):
                    continue
                try:
                    data = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if data.get("type") == "tool_start":
                    name = data.get("tool", "")
                    if name and name.lower() not in {
                        "bash", "edit", "glob", "grep", "read", "write",
                        "webfetch", "websearch", "task", "todowrite",
                    }:
                        tool_names.add(name)
            return sorted(tool_names) if tool_names else None
        except Exception:
            return None
