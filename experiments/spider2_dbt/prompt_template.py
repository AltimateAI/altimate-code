"""Prompt engineering for Spider 2.0-DBT benchmark tasks.

Builds a self-contained prompt per task that instructs the agent to:
1. Explore the dbt project structure
2. Understand the task requirements
3. Write/fix SQL models
4. Run `dbt run` to validate
5. Retry on failure (up to 3 times)
"""

from __future__ import annotations


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
    return f"""You are working on a dbt + DuckDB data engineering task.

## Task ID: {instance_id}

## Instruction
{instruction}

## Working Directory
Your dbt project is at: {project_dir}

## Steps

1. **Explore the project structure first:**
   - Read `dbt_project.yml` to understand the project configuration
   - Read `profiles.yml` to understand the DuckDB connection
   - List files in `models/` to see existing SQL models
   - Check `seeds/` or `data/` for any CSV seed files
   - Look at any existing `.sql` files to understand the schema and naming conventions

2. **Understand the data:**
   - Check what DuckDB databases are available (look for `.duckdb` or `.db` files)
   - If needed, query the database to understand table schemas:
     ```bash
     cd {project_dir} && duckdb *.duckdb -c ".tables"
     ```
   - Read any README or documentation files in the project

3. **Implement the solution:**
   - Create or modify SQL model files in the `models/` directory as needed
   - Follow dbt best practices (use `ref()` for model references, `source()` for sources)
   - Ensure your SQL is valid DuckDB SQL syntax

4. **Validate by running dbt:**
   ```bash
   cd {project_dir} && dbt run --profiles-dir . --project-dir .
   ```

5. **If dbt run fails:**
   - Read the error message carefully
   - Fix the SQL or configuration issue
   - Re-run `dbt run --profiles-dir . --project-dir .`
   - Retry up to 3 times total

6. **Final check:**
   - Make sure all models compile and run successfully
   - Verify the output tables exist in DuckDB

## Important Rules
- Stay within the project directory: {project_dir}
- Do NOT install new packages or modify system configuration
- Do NOT modify `profiles.yml` unless the task specifically requires it
- Use `dbt run --profiles-dir . --project-dir .` (not just `dbt run`)
- If a model already exists and the task asks to modify it, edit in place
- Write clean, readable SQL with appropriate comments
"""
