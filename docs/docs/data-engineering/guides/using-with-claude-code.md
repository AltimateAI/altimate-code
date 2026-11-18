---
title: "Using Altimate with Claude Code"
description: "Hand data engineering work from Claude Code to Altimate Code with the Altimate Code plugin, and use an Altimate workspace's skills, knowledge and memory from Claude Code."
---

# Using altimate with Claude Code

altimate can work alongside Claude Code. While Claude Code handles general coding tasks, altimate provides specialized data engineering capabilities that Claude Code doesn't have.

## How it works

Claude Code can invoke altimate as a tool when working on data projects. The `/altimate` command routes data engineering tasks to altimate's specialized tools.

```
# In Claude Code
/altimate analyze the cost of our Snowflake warehouse
```

This gives Claude Code access to:
- SQL analysis and anti-pattern detection
- Column-level lineage
- Cost prediction and FinOps analysis
- Schema inspection and PII detection
- dbt manifest parsing and model scaffolding
- Cross-dialect SQL translation

## Example workflows

### Code review with cost analysis

When Claude Code reviews a PR that includes SQL changes:

```
Claude Code: I see changes to models/marts/fct_revenue.sql. Let me check
             for data engineering concerns.

> /altimate analyze fct_revenue.sql for anti-patterns and estimate cost

altimate:
  sql_analyze: No anti-patterns detected ✓
  lineage_check: Sources stg_orders.amount, dim_products.category
  schema_diff: Added column revenue_category (low severity)
```

### dbt project setup

```
You (in Claude Code): Set up a new dbt model for our customer metrics

Claude Code: I'll create the model structure. Let me use altimate
             to inspect the source tables first.

> /altimate inspect the raw.customers and raw.orders tables

altimate:
  schema_inspect raw.customers → 12 columns
  schema_inspect raw.orders → 8 columns
  lineage_check [draft SQL] → verified column mappings

Claude Code: Here's the staging model based on the actual schema...
```

### FinOps during development

```
You (in Claude Code): This query is slow, can you optimize it?

Claude Code: Let me analyze it with altimate's SQL tools.

> /altimate analyze and optimize: SELECT * FROM events WHERE YEAR(event_date) = 2026

altimate:
  sql_analyze:
    ⚠ SELECT_STAR: Use explicit columns
    ⚠ FUNCTION_IN_FILTER: YEAR() prevents partition pruning
  sql_optimize:
    Optimized: explicit columns + range predicate
    Estimated improvement: 70-80% fewer bytes scanned
```

## Setup

### The Altimate Code plugin (recommended)

1. Install Altimate Code (Node.js 20 or later): `npm install -g altimate-code`
2. Install the plugin from Anthropic's plugin directory:

    ```bash
    claude plugin install altimate-code
    ```

    Or add Altimate's own marketplace and install from it:

    ```bash
    claude plugin marketplace add AltimateAI/altimate-claude-plugin
    claude plugin install altimate-code@altimate-claude-plugin
    ```

3. Start a new Claude Code session in your project. Ask for dbt or warehouse work as usual, or start a request with `/altimate-code:altimate` to hand it over yourself. (Claude Code names plugin commands `<plugin>:<command>`; the bare `/altimate` below comes from `/configure-claude`.)

The plugin runs `altimate-code run` in your project for each task, with the model provider Altimate Code is set up with. If you have not set one up, run `altimate-code` once and choose a provider, or sign in to Altimate (below).

#### dbt helpers beside the chat

Plugin 1.8.0 or later brings five dbt Power User helpers into the Claude Code session when you work in a dbt project. They are on by default; to turn them off, set the plugin's `dbt_mods` option to false in `/config`. Anthropic's plugin directory serves a reviewed, pinned version of the plugin that does not yet include these helpers, so `claude plugin update altimate-code` will not bring them. Install from Altimate's marketplace instead, remove the other copy, then start a new session. Run `claude plugin list` to see which copy you have: the directory's copy is `altimate-code@anthropic-plugin-directory` (or `altimate-code@claude-plugins-official` when you added Anthropic's catalog from GitHub), and the uninstall below names it.

```bash
claude plugin uninstall altimate-code@anthropic-plugin-directory   # or the ID `claude plugin list` shows
claude plugin marketplace add AltimateAI/altimate-claude-plugin
claude plugin install altimate-code@altimate-claude-plugin
```

If you already installed from Altimate's marketplace, update it with `claude plugin marketplace update altimate-claude-plugin`, then `claude plugin update altimate-code@altimate-claude-plugin`.

The helpers run the project's own dbt (from a `.venv` or `venv` in the project folder when there is one, else `dbt` on `PATH`) for `dbt show` and `dbt ls` after a model edit, `dbt --version` at session start, `dbt parse` when you press **Run dbt parse** or after **Run dbt deps**, `dbt deps` when you press **Run dbt deps**, and `dbt debug` only when you run `/dbt-doctor` or press **Test connection**. **Fix with Altimate Code** asks Altimate Code to fix the failed nodes and then run the failed command again on your warehouse. The doctor reads `profiles.yml` through the project's Python to find the adapter. Model context reads the project's `manifest.json` (through the project's Python when it is over 4 MiB), and Explain and Fix read the output of the failed run and the project's `run_results.json`. If dbt cannot be started, the check says "dbt could not be run here". The helpers make no model-provider call on their own (only **Explain** and **Fix with Altimate Code**, when you press them, hand a failure to Claude or Altimate Code). What they add to Claude's context (dbt errors, column names, facts from the manifest, the doctor's checks) is part of the conversation and reaches your model provider. Secret values from the `profiles.yml` a dbt command reads (the one its `--profiles-dir` or `DBT_PROFILES_DIR` names, else the one in the folder it ran in, the project's, or `~/.dbt`'s: the string fields of its outputs, and the env vars it names with their defaults) are removed from dbt's messages (errors, logs, the doctor's details, the failure band, Explain and Fix, and the error text kept in the query history) that the helpers show, save or send, and dbt's errors about a `profiles.yml` it cannot read, validate or render are replaced with a fixed message. Identifiers such as schema, database, dataset, project, catalog, warehouse, role and user are not treated as secrets, nor are values under 6 characters or the `type`, `threads`, `method` and `port` fields; query results and manifest facts are shown as they are. The plugin reads those values locally and keeps them in memory only. Redaction is best effort, not a guarantee about every text dbt prints: it matches those values as written, JSON-escaped and in Python's string and byte forms, including values set for the command (`NAME=value dbt …`, `env`, `export`); it cannot catch a value dbt or an adapter prints in another form (encoded, transformed or split), or one the profile builds other than through `env_var`. Other dbt errors (a missing target or profile name, a model's own missing `env_var`) are kept, since they carry no secret. A dbt command Claude runs itself shows its output to Claude unchanged.

- **Compile and validate**
    - *When it runs:* after Claude edits or writes a model's `.sql` file. It checks the model again after Claude's next command when the model's file or its `schema.yml` changed, and after Claude edits another `.yml` or `.sql` file in the project (such as a macro). A macro changed by a command is not noticed. A model whose path has a space is skipped.
    - *What you see:* a line above the prompt: the model compiled and ran (`dbt show`, one row), with the columns `schema.yml` documents but the query did not return, and those it returned undocumented. When the query returns no row or `schema.yml` documents no columns, it says the columns were not compared. A problem opens the **dbt check** pane with every column, or dbt's error details.
    - *What Claude is told:* with the result of its edit when the check finishes within 30 seconds (otherwise with Claude's next Bash, Read or edit tool result), dbt's own error when the model does not compile or run, or the column differences. It is also told when the model was not checked or its columns were not compared, with the reason, and that the model compiled and ran with N columns. A recheck updates the line, a toast and the pane, but does not tell Claude.
- **Explain and Fix**
    - *When it runs:* after a `dbt run`, `test`, `build`, `seed`, `snapshot` or `retry` that Claude ran fails.
    - *What you see:* the failed nodes with **Explain** (asks Claude to explain the failures without changing files) and **Fix with Altimate Code** (runs `/altimate-code:altimate` on the failures).
    - *What Claude is told:* when you press a button, up to five failures, each cut to six lines and 600 characters, read from the project's `run_results.json` (the one the command wrote, unless it put its artifacts elsewhere) together with the errors dbt printed.
    - *When it clears:* a newer failing run replaces it. Pressing **Explain** or **Fix with Altimate Code** keeps it. **Dismiss** and `/clear` clear it. A passing run of the same kind (or a build) clears it when it matches the failed one: the same selection or the whole project, the same flags (target, vars, `--full-refresh`, …), the same folder and the same environment variables set in the command. Flags that change only the output or the concurrency, such as `--log-format` or `--threads`, are ignored (a passing `dbt retry` never clears it; a compound command is cleared only by the same command or a whole-project build, and a killed run or output that cannot be split per command, such as output piped through `tail` with its headers cut off, clears nothing). A band that vanished does not mean the run was fixed.
- **Query results pane**
    - *When it runs:* after Claude runs `dbt show`, or when you run `/dbt-show <model>` or `/dbt-show select …`.
    - *What you see:* the rows as a table beside the chat, resizable with **Min / Default / Max** (Default is the widest dock beside the chat; Min is a quarter of the terminal width; Max is as wide as Default and taller above the prompt; a size you drag yourself wins), with **Re-run** (Claude's own command with the same query and flags, with JSON output, the same folder and the dbt executable Claude ran when it named a path that still exists (a bare `dbt` runs as the project's own), unless it depended on its shell, such as a variable or `~`; or your query), **Bookmark**, **Clear history**, the history and your bookmarks (kept on this machine across sessions: the last 20 queries and at most 50 bookmarks, each with up to 50 rows and cells cut at 200 characters; **Clear history** keeps bookmarks and their rows). Several different `dbt show`s in one command save no preview.
    - *What Claude is told:* nothing beyond the output of Claude's own `dbt show`, which is already in the conversation. Rows from `/dbt-show` stay out of the conversation.
- **Model context**
    - *When it runs:* when Claude reads a model's `.sql` file.
    - *What you see:* a toast with the counts.
    - *What Claude is told:* the model's materialization, columns with their types, descriptions and tests, its parents and children, and how deep it sits upstream and downstream, from the project's `manifest.json`, for the first 40 columns (a wider model gets a count of the rest).
- **Environment doctor**
    - *When it runs:* at the start of an interactive session (not under `claude -p` or the SDK), and with `/dbt-doctor`.
    - *What you see:* a toast at session start, also when every check passes. A line above the prompt when something is wrong: dbt, Python, the profile's adapter, `dbt deps`, and a manifest older than the files it was built from, with **Run dbt parse** or **Run dbt deps**. `/dbt-doctor` opens a dbt doctor pane.
    - *What Claude is told:* the checks, with the first prompt after they finish.

Compile and validate runs one query on your warehouse after each model edit (a `dbt ls`, which runs no query, comes first when the manifest does not name the model; a second `dbt show` runs only when the first showed nothing and the manifest names the model differently). Rechecks run it again. That costs money on a warehouse that bills by bytes scanned or wakes a suspended one.

The helpers read `manifest.json` and `run_results.json` from the `target-path` that `dbt_project.yml` names (`target/` by default). A path set by `DBT_TARGET_PATH`, a command's `--target-path` or a Jinja `target-path` is not followed.

### The `/altimate` command, without the plugin

Run `/configure-claude` inside altimate to write the command:

```bash
altimate
# then in the TUI:
/configure-claude
```

This creates `~/.claude/commands/altimate.md`. You can now use `/altimate` in any Claude Code session.

## Use an Altimate workspace from Claude Code

Claude Code reaches a workspace through Altimate Code: every task the plugin hands over runs in your project, so it gets the workspace the project is linked to — its skills, its knowledge, your team's shared memory and its integrations. Nothing in Claude Code itself needs configuring.

1. **Sign in to Altimate.** In a terminal:

    ```bash
    altimate-code auth login -p altimate-backend --method "Altimate LLM Gateway"
    ```

    It opens your browser; sign in and return to the terminal. (Inside the TUI, `/connect` does the same.) The command also works from Claude Code: type it after `!` in the prompt.

2. **Link the project.** In the project folder:

    ```bash
    altimate-code link
    ```

    Pick the workspace, or create one. The picker needs an interactive terminal, so it does not run from Claude Code's `!` prompt or a script. There, list the workspaces with `altimate-code workspace list` and link with `altimate-code link --workspace <id or name>`, or create one with `altimate-code link --create`. Moving a linked project to a different workspace also needs `--yes`. Claude can run these for you: ask it to link the project to a workspace.

3. **Check it.** `altimate-code workspace status` shows the linked workspace and when its skills last synced.

4. **Ask Claude.** Questions about your team's conventions, best practices or knowledge are answered from the workspace when they reach Altimate Code. Start them with `/altimate-code:altimate` to be sure they do:

    ```
    /altimate-code:altimate what are our naming conventions for staging models?
    ```

What you teach Altimate Code during these tasks is saved to the workspace's memory and shared with your team in the CLI, the IDE and Studio. If an upload fails, the task ends with a line saying so; `altimate-code workspace sync` sends what is left. Skills added to the workspace sync into `.altimate-code/skill/_workspace/` at the start of the next task.

## When to use which

| Task | Use Claude Code | Use altimate |
|---|---|---|
| Writing Python/JS code | Yes | No |
| SQL anti-pattern detection | No | Yes |
| Column-level lineage | No | Yes |
| Cost prediction | No | Yes |
| FinOps analysis | No | Yes |
| Schema inspection | No | Yes |
| dbt model scaffolding | Partially | Yes (better) |
| Cross-dialect translation | No | Yes |
| PII detection | No | Yes |
| General code review | Yes | Supplement with data checks |
| File editing | Yes | Yes (in builder mode) |
