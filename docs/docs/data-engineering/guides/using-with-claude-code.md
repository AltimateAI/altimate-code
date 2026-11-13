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

### dbt helpers beside the chat

In a dbt project the plugin also does what dbt Power User does in VS Code, inside the Claude Code session. Each helper runs the project's own dbt (from a `.venv` or `venv` in the project folder when there is one, else `dbt` on `PATH`) and calls no model:

| Helper | When it runs | What you see | What Claude is told |
|---|---|---|---|
| Compile and validate | After Claude edits or writes a model's `.sql` file, and again after Claude's next command or edit when the model, a schema file or another SQL file (a macro) changed | A line above the prompt: the model compiled and ran (`dbt show`, one row), with the columns `schema.yml` documents but the query did not return, and those it returned undocumented. When the query returns no row or `schema.yml` documents no columns, it says the columns were not compared. A problem opens the **dbt check** pane with every column, or dbt's whole error | dbt's own error when the model does not compile or run, or the column differences |
| Explain and Fix | After a `dbt run`, `test`, `build`, `seed`, `snapshot` or `retry` Claude ran fails | The failed nodes with **Explain** (Claude explains each failure without changing files) and **Fix with Altimate Code** (runs `/altimate-code:altimate` on the failures) | The failure, read from the `target/run_results.json` the command wrote, together with the errors dbt printed, when you press a button. A passing run of the same kind (or a build) with the same selection and target, or of the whole project, clears it (a passing `dbt retry` never does; a compound command is cleared only by the same command or a whole-project build, and a killed run or output that cannot be split per command, such as output piped through `tail` with its headers cut off, clears nothing) |
| Results pane | After Claude runs `dbt show`, or when you run `/dbt-show <model>` or `/dbt-show select …` | The rows as a table beside the chat, with **Re-run** (Claude's own command with the same flags and folder, unless it depended on its shell, such as a variable or `~`; or your query), **Bookmark**, **Clear history**, the history and your bookmarks (kept on this machine across sessions); several different `dbt show`s in one command save no preview | Nothing |
| Model context | When Claude reads a model's `.sql` file | A toast with the counts | The model's materialization, columns with their types, descriptions and tests, its parents and children, and how deep it sits upstream and downstream, from `target/manifest.json` |
| Environment doctor | At session start, and `/dbt-doctor` | A line above the prompt when something is wrong: dbt, Python, the profile's adapter, `dbt deps`, and a manifest older than the files it was built from, with **Run dbt parse** or **Run dbt deps** | The checks, with the first prompt after they finish |

The doctor tests the warehouse connection (`dbt debug`) only when you run `/dbt-doctor` or press **Test connection**, never at session start. Compile and validate runs a query on your warehouse after each model edit, which costs money on a warehouse that bills by bytes scanned or wakes a suspended one. To turn the helpers off, set the plugin's `dbt_mods` option to false in `/config`.

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
