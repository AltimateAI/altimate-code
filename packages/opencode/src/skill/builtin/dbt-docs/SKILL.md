---
name: dbt-docs
description: Document dbt models and columns in schema.yml with business context — model descriptions, column definitions, and doc blocks. Use when adding or improving documentation for discoverability. Powered by altimate-dbt.
---

# dbt Documentation

## Requirements
**Agent:** builder or migrator (requires file write access)
**Tools used:** bash (runs `altimate-dbt` commands), read, glob, write, edit

## When to Use This Skill

**Use when the user wants to:**
- Add or improve model descriptions in schema.yml
- Write column-level descriptions with business context
- Create shared doc blocks for reusable definitions
- Improve dbt docs site content

**Do NOT use for:**
- Adding tests → use `dbt-test`
- Creating new models → use `dbt-develop`
- Generating sources.yml from scratch → use `dbt-develop`

## Workflow

### 1. Understand the Model

```bash
altimate-dbt columns --model <name>                    # what columns exist
altimate-dbt parents --model <name>                    # what feeds this model
altimate-dbt children --model <name>                   # who consumes it
altimate-dbt compile --model <name>                    # see the rendered SQL
```

Read the model SQL to understand the transformations:
```bash
glob models/**/<name>.sql
read <model_file>
```

### 2. Read Existing Documentation

Check what's already documented:
```bash
glob models/**/*schema*.yml models/**/*_models.yml
read <yaml_file>
```

### 3. Write Documentation

See [references/documentation-standards.md](references/documentation-standards.md) for quality guidelines.

#### Model-Level Description
Cover: **What** (business entity), **Why** (use case), **How** (key transforms), **When** (materialization).

```yaml
- name: fct_daily_revenue
  description: >
    Daily revenue aggregation by product category. Joins staged orders with
    product dimensions and calculates gross/net revenue. Materialized as
    incremental with unique key on (date_day, category_id). Used by the
    finance team for daily P&L reporting.
```

#### Column-Level Description
Describe business meaning, derivation formula, and caveats:

```yaml
columns:
  - name: net_revenue
    description: >
      Total revenue minus refunds and discounts for the day.
      Formula: gross_revenue - refund_amount - discount_amount.
      Can be negative if refunds exceed sales.
```

### 4. Validate

```bash
altimate-dbt compile --model <name>    # ensure YAML is valid
```

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Restating the column name as the description | `"order_id: The order ID"` → describe business meaning |
| Empty descriptions | Every column should have a description. If unsure, describe the source. |
| Not reading the SQL before documenting | Read the model to understand derivation logic |
| Duplicating descriptions across models | Use doc blocks for shared definitions |
| Writing implementation details instead of business context | Describe what it means to the business, not how it's computed |

## Reference Guides

| Guide | Use When |
|-------|----------|
| [references/altimate-dbt-commands.md](references/altimate-dbt-commands.md) | Need the full CLI reference |
| [references/documentation-standards.md](references/documentation-standards.md) | Writing high-quality descriptions |
