---
name: teach
description: Teach your AI teammate a pattern by showing it an example file from your codebase
---

# Teach

## Purpose
Learn a reusable pattern from an example file. The user shows you a well-written artifact (model, query, config), and you extract the patterns worth following.

## Workflow

1. **Identify the file**: The user provides a file reference (e.g., `@models/staging/stg_orders.sql`). Read the file.

2. **Analyze patterns**: Extract the structural patterns, NOT the specific content. Focus on:
   - File structure and organization (sections, ordering)
   - Naming conventions (prefixes, suffixes, casing)
   - SQL patterns (CTE vs subquery, join style, column ordering)
   - dbt conventions (materialization, tests, config blocks)
   - Common boilerplate (headers, comments, imports)
   - Data type choices
   - Error handling patterns

3. **Present findings**: Show the user what you learned in a structured list. Be specific:
   - Good: "Column order: keys first, then dimensions, then measures, then timestamps"
   - Bad: "Good column ordering"

4. **Ask for confirmation**: Let the user confirm, modify, or reject your findings before saving.

5. **Save via training_save**: Use the `training_save` tool with:
   - `kind`: "pattern"
   - `name`: A descriptive slug (e.g., "staging-model", "incremental-config")
   - `content`: The extracted patterns as a concise, actionable checklist
   - `scope`: "project" (default — shared with team via git)
   - `source`: The file path you learned from
   - `citations`: Reference to the source file

## Important Guidelines

- Extract PATTERNS, not content. "Use `{{ source() }}` macro" is a pattern. "Query the orders table" is content.
- Keep it concise — max 10 bullet points per pattern. If more are needed, split into multiple patterns.
- Use the file's actual conventions, don't impose your own preferences.
- If the file doesn't have clear patterns worth learning, say so honestly.
- Do NOT make any LLM calls beyond the normal conversation flow — pattern extraction happens in your analysis, not via separate API calls.

## Usage Examples

```
/teach @models/staging/stg_orders.sql
/teach staging-model @models/staging/stg_customers.sql
/teach @dbt_project.yml
```

If the user provides a name (first argument before the @file), use that as the pattern name. Otherwise, infer a name from the file type and purpose.
