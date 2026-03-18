---
name: impact-analysis
description: Analyze the downstream impact of a model change using column-level lineage and the dbt DAG. Use before modifying a model to understand what breaks, what needs revalidation, and what downstream consumers are affected.
---

# Impact Analysis

## Requirements
**Agent:** any (read-only analysis)
**Tools used:** bash (runs `altimate-dbt` commands), read, glob, dbt_lineage, altimate_core_column_lineage, altimate-dbt children/parents

## When to Use This Skill

**Use when the user wants to:**
- Understand what breaks if they change a model's SQL or schema
- See which downstream models, reports, or dashboards depend on a model
- Trace how a column flows through the DAG before renaming or removing it
- Plan a safe migration by knowing all affected consumers

**Do NOT use for:**
- Making the actual model changes → use `dbt-develop`
- Debugging failures after a change → use `dbt-troubleshoot`
- Writing tests → use `dbt-test` or `generate-tests`

## Core Workflow

### 1. Map the DAG — Who Depends on This Model?

```bash
altimate-dbt children --model <name>          # direct downstream models
altimate-dbt parents --model <name>           # direct upstream models
```

For a full tree (recursive):
```bash
altimate-dbt children --model <name> --downstream   # all transitive descendants
```

Read the output carefully:
- How many models depend on this model?
- Are any marts or gold-layer tables downstream? (High-impact change)
- Are any external consumers (BI tools, APIs) at the end of the chain?

### 2. Column-Level Lineage — What Columns Are Affected?

Use `altimate_core_column_lineage` to trace how specific columns flow:
- Identify which downstream columns derive from the column you're changing
- Rename/remove detection: if you rename `customer_id` → `cust_id`, find all models that SELECT `customer_id` from this model

```bash
altimate-dbt columns --model <name>           # list columns in this model
```

Then call `altimate_core_column_lineage` with the model name and target column.

### 3. Read Downstream Models

For each direct child model, read its SQL:
```bash
glob models/**/*.sql
read <child_model_file>
```

Check:
- Does it reference the column you're changing by name?
- Does it use `SELECT *` (will silently pick up new columns, miss removed ones)?
- Does it have tests that validate the relationship to this model?

### 4. Assess Risk Level

| Risk | Signal |
|---|---|
| **Critical** | Gold/mart model or BI-facing table is downstream |
| **High** | 5+ downstream models reference the changed column |
| **Medium** | 1-4 downstream models; changes are isolated |
| **Low** | No downstream models (leaf node) or only view materialization downstream |

### 5. Produce Impact Report

Summarize findings for the user:
```
## Impact Analysis: <model_name>

**Changed column:** <column>
**Downstream models affected:** N

### Direct children:
- <child1>: references <column> in SELECT — needs update
- <child2>: uses SELECT * — will adapt automatically

### Transitive impact:
- <grandchild1>: depends on <child1> — may need rebuild

### Recommendation:
1. Update <child1> to use the new column name
2. Run: altimate-dbt build --model <name> --downstream
3. Verify <grandchild1> output is unchanged
```

### 6. Validate After Changes

After any model modification:
```bash
altimate-dbt build --model <name> --downstream    # rebuild changed model + all descendants
```

Check that downstream models produce the same row counts and key values as before.

## Iron Rules

1. **Always run impact analysis before modifying a model** — never change blindly.
2. **Column renames are high-risk** — find every reference before renaming.
3. **Build downstream, not just the changed model** — `--downstream` flag catches breakage.
4. **`SELECT *` is a hidden risk** — models using it won't fail on column removal until runtime.
5. **Document the impact scope** — tell the user how many models are affected before making any change.
