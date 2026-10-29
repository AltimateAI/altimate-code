---
title: "Tool CLI (Headless) — Altimate Code"
description: "Call Altimate Code data tools from any shell, agent or CI job without an LLM. Optional warm daemon keeps connections and the schema cache ready."
---

# Tool CLI (Headless)

Expose the data tools -- warehouse, SQL, schema, lineage, impact, PII, data-diff, FinOps and dbt -- as plain commands. No model or API key is involved, so Claude Code, Codex and CI jobs can call them directly.

## List tools

```bash
altimate-code tool list          # id and description
altimate-code tool list --json   # id, description and JSON input schema
```

`tool` and `mcp serve` share one implementation, so compact schemas, `sql_execute` with `tables`, `query_from` chaining, spilled result files, read-only enforcement and `answer_commit` (with its `request` argument) behave the same in both. `tool` exposes the full tool list; pass `--workspace-tools` to add `workspace_context`, `workspace_skill` and `workspace_execute`.

## Startup context

```bash
altimate-code tool context [--connections <file>] [--json]
```

Prints the analyst method and the connections known at startup (the same text `mcp serve` sends as its instructions), so a shell agent gets it in one call.

## Run a tool

```bash
altimate-code tool run sql_format --args '{"sql":"select a,b from t","dialect":"postgres"}'
altimate-code tool run warehouse_list
altimate-code tool run schema_inspect --args-file inspect.json --json
echo '{"query":"select 1"}' | altimate-code tool run sql_execute --args -
```

| Option | Description |
|---|---|
| `--args '<json>'` | Tool arguments as a JSON object. `-` reads them from stdin. |
| `--args-file <path>` | Read the arguments from a file. |
| `--allow-write` | Allow writes. Without it, only reads run. |
| `--no-daemon` | Run in this process instead of using the daemon. |
| `--json` | Print `{"status","title","output","metadata"}`. Otherwise only `output` is printed. |

Arguments are validated against the tool's schema. An unknown tool, invalid arguments or a failing tool exits non-zero.

Only the data tools are exposed. Coding tools (`bash`, `read`, `edit`, ...), `dbt_pr_review` (use `altimate-code review`), memory and training tools are not available here.

## Permissions

Runs are read-only by default. Reads such as `sql_execute` on a SELECT and `schema_inspect` are allowed; anything else is refused with `Permission denied: <kind>. Re-run with --allow-write to enable writes.` Tools that change local configuration (`warehouse_add`, `warehouse_remove`, `warehouse_install_driver`) also need `--allow-write`.

`DROP DATABASE`, `DROP SCHEMA` and `TRUNCATE` stay blocked even with `--allow-write`.

## Daemon

`tool run` starts a background process per project directory and CLI version on first use, and reuses it afterwards so warehouse connections and the schema cache stay warm. If it cannot be reached within about 3 seconds, the call runs in-process. `scratch` tables created by `sql_materialize` live as long as the daemon does. Every caller in that directory shares the daemon, so concurrent agents share its `scratch` tables and its `answer_commit` history; use `--no-daemon` to keep a caller separate.

```bash
altimate-code tool daemon status
altimate-code tool daemon stop
```

| Setting | Description |
|---|---|
| `ALTIMATE_TOOL_DAEMON=0` | Always run in-process. |
| `ALTIMATE_TOOL_DAEMON_IDLE_MS` | Idle time before the daemon exits (default `600000`). |

The daemon listens on a local socket (a named pipe on Windows) under the Altimate Code state directory and removes it on exit.

## Claude Code routing

For clients that cannot use the `altimate-code` MCP server, the Claude Code plugin adds CLI routing guidance at session start: `altimate-code tool context` followed by `altimate-code tool run` for data questions, and `altimate-code run` for long multi-step jobs. To persist the same guidance in the repository, run `altimate-code link --claude-md`; it writes a managed block to the project's `CLAUDE.md` and never changes content outside the `<!-- altimate-code:routing start -->` / `<!-- altimate-code:routing end -->` markers.
