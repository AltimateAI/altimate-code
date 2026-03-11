"""Prompt engineering for Spider 2.0-DBT benchmark tasks.

Builds a self-contained prompt per task that instructs the agent to:
1. Absorb project context (schema.yml, existing models)
2. Explore actual data values
3. Plan before coding
4. Write/fix SQL models
5. Run `dbt run` to validate
6. Verify output data against source
"""

from __future__ import annotations

import os
from pathlib import Path


def _collect_project_context(project_dir: str) -> str:
    """Read schema.yml files and list existing SQL models to pre-load into prompt."""
    project = Path(project_dir)
    sections = []

    # Collect all YAML files (schema, sources, configs)
    yaml_files = sorted(
        list(project.glob("models/**/*.yml"))
        + list(project.glob("models/**/*.yaml"))
        + list(project.glob("*.yml"))
    )
    for yf in yaml_files:
        rel = yf.relative_to(project)
        # Skip dbt_project.yml and profiles.yml (agent reads these anyway)
        if rel.name in ("dbt_project.yml", "profiles.yml", "packages.yml"):
            continue
        content = yf.read_text().strip()
        if content:
            sections.append(f"### {rel}\n```yaml\n{content}\n```")

    # Collect all existing SQL model files with their content
    sql_files = sorted(project.glob("models/**/*.sql"))
    for sf in sql_files:
        rel = sf.relative_to(project)
        content = sf.read_text().strip()
        if content:
            sections.append(f"### {rel}\n```sql\n{content}\n```")

    if not sections:
        return "No schema or model files found."

    return "\n\n".join(sections)


def build_task_prompt(
    instance_id: str,
    instruction: str,
    project_dir: str,
) -> str:
    """Build the full prompt for a Spider2-DBT task.

    Args:
        instance_id: Unique task identifier (e.g., "ga4_001").
        instruction: The natural language task instruction from the benchmark.
        project_dir: Absolute path to the dbt project working directory.

    Returns:
        A complete prompt string for the agent.
    """
    project_context = _collect_project_context(project_dir)

    return f"""You are working on a dbt + DuckDB data engineering task.

## Task ID: {instance_id}

## Instruction
{instruction}

## Working Directory
Your dbt project is at: {project_dir}

## Pre-Loaded Project Context

The following files already exist in the project. Study them carefully — they define the expected models, columns, business logic patterns, and conventions you MUST follow.

{project_context}

## Steps

1. **Absorb the context above BEFORE doing anything else:**
   - The schema.yml column descriptions ARE your requirements. If it says "revenue lost due to returned items", that means filter for returned items only.
   - Look at WHERE clauses in existing SQL models — they define the project's business logic vocabulary. If existing models filter `WHERE item_status = 'R'` for returns, your new models MUST use the same pattern.
   - Note exact column names and counts from schema.yml — your output must match exactly (no extra columns).
   - Check `refs` in schema.yml to understand which models your target depends on.

2. **Explore the actual data:**
   - Query the database to understand table schemas and actual values:
     ```bash
     cd {project_dir} && duckdb *.duckdb -c ".tables"
     ```
   - For key columns (flags, status fields, categories), query distinct values and distributions:
     ```bash
     cd {project_dir} && duckdb *.duckdb -c "SELECT DISTINCT <column>, COUNT(*) FROM <table> GROUP BY 1"
     ```

3. **State your plan before coding:**
   - List the exact columns your output should have (from schema.yml).
   - State the business logic you inferred from existing models — specifically what filters and aggregation patterns you will follow.
   - If you need to define threshold values (e.g., for status categories) that aren't specified, examine the data distribution to pick reasonable breakpoints.

4. **Implement the solution:**
   - Create or modify SQL model files in the `models/` directory.
   - Follow the same patterns as existing models (column names, filter logic, precision, rounding).
   - Use `ref()` for model references, `source()` for sources.
   - Match the column list from schema.yml EXACTLY — do not add extra columns.
   - Ensure valid DuckDB SQL syntax.

5. **Validate by running dbt:**
   ```bash
   cd {project_dir} && dbt run --profiles-dir . --project-dir .
   ```
   If dbt run fails, read the error, fix the SQL, and retry (up to 3 times).

6. **Verify the output data (MANDATORY):**
   After dbt run succeeds, query the output tables:
   ```bash
   cd {project_dir} && duckdb *.duckdb -c "SELECT COUNT(*) FROM <model>; SELECT * FROM <model> LIMIT 10;"
   ```
   - Spot-check 2-3 rows by tracing values back to source tables.
   - Check edge cases: percentages > 100%, negative values, unexpected NULLs.
   - Verify the column count and names match schema.yml exactly.
   - Check status/category distributions with `GROUP BY`.
   - If anything looks wrong, fix and re-run.

## Important Rules
- Stay within the project directory: {project_dir}
- Do NOT install new packages or modify system configuration
- Do NOT modify `profiles.yml` unless the task specifically requires it
- Use `dbt run --profiles-dir . --project-dir .` (not just `dbt run`)
- If a model already exists and the task asks to modify it, edit in place
- Write clean, readable SQL with appropriate comments
- Output ONLY the columns listed in schema.yml — no extra columns
"""
