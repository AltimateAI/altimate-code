---
name: running-dbt-commands
description: Formats and executes dbt CLI commands, selects the correct dbt executable, and structures command parameters. Use when running models, tests, builds, compiles, or show queries via dbt CLI. Use when unsure which dbt executable to use or how to format command parameters.
tags: ["dbt"]
user-invocable: false
metadata:
  author: dbt-labs
---

# Running dbt Commands

## Preferences

1. **Use MCP tools if available** (`dbt_build`, `dbt_run`, `dbt_show`, etc.) - they handle paths, timeouts, and formatting automatically
2. **Use `build` instead of `run` or `test`** - `test` doesn't refresh the model, so testing a model change requires `build`. `build` does a `run` and a `test` of each node (model, seed, snapshot) in the order of the DAG
3. **Always use `--quiet`** with `--warn-error-options '{"error": ["NoNodesForSelectionCriteria"]}'` to reduce output while catching selector typos
4. **Always use `--select`** - never run the entire project without explicit user approval

## Quick Reference

```bash
# Standard command pattern
dbt build --select my_model --quiet --warn-error-options '{"error": ["NoNodesForSelectionCriteria"]}'

# Preview model output
dbt show --select my_model --limit 10

# Run inline SQL query
dbt show --inline "select * from {{ ref('orders') }}" --limit 5

# With variables (JSON format for multiple)
dbt build --select my_model --vars '{"key": "value"}'

# Full refresh for incremental models
dbt build --select my_model --full-refresh

# List resources before running
dbt list --select my_model+ --resource-type model
```

## dbt CLI Flavors

Three CLIs exist. **Ask the user which one if unsure.**

| Flavor | Location | Notes |
|--------|----------|-------|
| **dbt Core** | Python venv | `pip show dbt-core` or `uv pip show dbt-core` |
| **dbt Fusion** | `~/.local/bin/dbt` or `dbtf` | Faster and has stronger SQL comprehension |
| **dbt Cloud CLI** | `~/.local/bin/dbt` | Go-based, runs on platform |

**Common setup:** Core in venv + Fusion at `~/.local/bin`. Running `dbt` uses Core. Use `dbtf` or `~/.local/bin/dbt` for Fusion.

## Selectors

**Always provide a selector.** Graph operators:

| Operator | Meaning | Example |
|----------|---------|---------|
| `model+` | Model and all downstream | `stg_orders+` |
| `+model` | Model and all upstream | `+dim_customers` |
| `+model+` | Both directions | `+orders+` |
| `model+N` | Model and N levels downstream | `stg_orders+1` |

```bash
--select my_model              # Single model
--select staging.*             # Path pattern
--select fqn:*stg_*            # FQN pattern
--select model_a model_b       # Union (space)
--select tag:x,config.mat:y    # Intersection (comma)
--exclude my_model             # Exclude from selection
```

**Resource type filter:**
```bash
--resource-type model
--resource-type test --resource-type unit_test
```

Valid types: `model`, `test`, `unit_test`, `snapshot`, `seed`, `source`, `exposure`, `metric`, `semantic_model`, `saved_query`, `analysis`

## List

Use `dbt list` to preview what will be selected before running. Helpful for validating complex selectors.

```bash
dbt list --select my_model+              # Preview selection
dbt list --select my_model+ --resource-type model  # Only models
dbt list --output json                   # JSON output
dbt list --select my_model --output json --output-keys unique_id name resource_type config
```

**Available output keys for `--output json`:**
`unique_id`, `name`, `resource_type`, `package_name`, `original_file_path`, `path`, `alias`, `description`, `columns`, `meta`, `tags`, `config`, `depends_on`, `patch_path`, `schema`, `database`, `relation_name`, `raw_code`, `compiled_code`, `language`, `docs`, `group`, `access`, `version`, `fqn`, `refs`, `sources`, `metrics`

## Show

Preview data with `dbt show`. Use `--inline` for arbitrary SQL queries.

```bash
dbt show --select my_model --limit 10
dbt show --inline "select * from {{ ref('orders') }} where status = 'pending'" --limit 5
```

**Important:** Use `--limit` flag, not SQL `LIMIT` clause.

## Variables

Pass as STRING, not dict. No special characters (`\`, `\n`).

```bash
--vars 'my_var: value'                              # Single
--vars '{"k1": "v1", "k2": 42, "k3": true}'         # Multiple (JSON)
```

## Analyzing Run Results

After a dbt command, check `target/run_results.json` for detailed execution info:

```bash
# Quick status check
cat target/run_results.json | jq '.results[] | {node: .unique_id, status: .status, time: .execution_time}'

# Find failures
cat target/run_results.json | jq '.results[] | select(.status != "success")'
```

**Key fields:**
- `status`: success, error, fail, skipped, warn
- `execution_time`: seconds spent executing
- `compiled_code`: rendered SQL
- `adapter_response`: database metadata (rows affected, bytes processed)

## Defer (Skip Upstream Builds)

Reference production data instead of building upstream models:

```bash
dbt build --select my_model --defer --state prod-artifacts
```

**Flags:**
- `--defer` - enable deferral to state manifest
- `--state <path>` - path to manifest from previous run (e.g., production artifacts)
- `--favor-state` - prefer node definitions from state even if they exist locally

```bash
dbt build --select my_model --defer --state prod-artifacts --favor-state
```

## Static Analysis (Fusion Only)

Override SQL analysis for models with dynamic SQL or unrecognized UDFs:

```bash
dbt run --static-analysis=off
dbt run --static-analysis=unsafe
```

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Using `test` after model change | Use `build` - test doesn't refresh the model |
| Running without `--select` | Always specify what to run |
| Using `--quiet` without warn-error | Add `--warn-error-options '{"error": ["NoNodesForSelectionCriteria"]}'` |
| Running `dbt` expecting Fusion when we are in a venv | Use `dbtf` or `~/.local/bin/dbt` |
| Adding LIMIT to SQL in `dbt_show` | Use `limit` parameter instead |
| Vars with special characters | Pass as simple string, no `\` or `\n` |
