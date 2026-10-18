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
    altimate-code auth login -p altimate-backend
    ```

    Choose **Altimate LLM Gateway**. It opens your browser; sign in and return to the terminal. (Inside the TUI, `/connect` does the same.)

2. **Link the project.** In the project folder:

    ```bash
    altimate-code link
    ```

    Pick the workspace, or create one. Linking needs an interactive terminal; from a script or an agent, use `altimate-code link --workspace <id or name>` or `altimate-code link --create`.

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
