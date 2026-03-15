---
name: training-status
description: Show what your AI teammate has learned — patterns, rules, glossary, and standards
---

# Training Status

## Purpose
Display a comprehensive overview of everything your AI teammate has been trained on.

## Workflow

1. **Fetch all training**: Use the `training_list` tool with no filters to get all training entries.

2. **Present the dashboard**: Format the output as a clean status report:

```
Training Status

Patterns:   X  (staging-model, incremental-config, ...)
Rules:      X  (no-float, no-select-star, ...)
Glossary:   X  (arr, mrr, churn-date, ...)
Standards:  X  (sql-style-guide, review-checklist, ...)

Recent Training:
  - 2 days ago: Learned rule "no-float" (from user correction)
  - 5 days ago: Learned pattern "staging-model" (from stg_orders.sql)
  - 1 week ago: Loaded standard "sql-style-guide" (from docs/sql-style.md)

Most Applied:
  - "staging-model" pattern — applied 12 times
  - "no-float" rule — applied 8 times
```

3. **Offer actions**: After showing status, suggest:
   - `/teach` to learn new patterns
   - `/train` to load standards from documents
   - `training_remove` to remove outdated entries
   - `training_list` with filters for detailed views

## Usage

```
/training-status
```
