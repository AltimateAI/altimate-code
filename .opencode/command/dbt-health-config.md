---
description: infer a dbt health-check config from the project's own conventions and write .altimate/dbt-health.yml
agent: build
subtask: true
---

Generate a dbt health-check configuration by inferring it from a dbt project's **existing conventions** (deterministic — no guessing).

## Target project

Use `$ARGUMENTS` as the dbt project directory if provided. Otherwise, locate the dbt project in the current worktree by finding the directory that contains a `dbt_project.yml` (run `project_scan` if you need to discover it). If there are **multiple** dbt projects, do this for **each** one — every project gets its own `.altimate/dbt-health.yml`.

## Steps

1. For each target project directory, call the **`dbt_health_config`** tool:
   `dbt_health_config({ project_dir: "<dir>" })`
   This deterministically infers the config from the project (modal tags / meta keys / tests, configured schemas & databases, naming contracts, distribution-ratcheted thresholds) and writes it to `<dir>/.altimate/dbt-health.yml`.

2. Then run **`dbt_project_health`** on the same directory:
   `dbt_project_health({ project_dir: "<dir>" })`
   It auto-discovers the freshly written `.altimate/dbt-health.yml`, so the report now reflects the inferred rules.

3. Summarize for the user: the path(s) written, which config-driven checks were activated (tags, meta keys, tests, naming contracts, parent schema/database whitelists, thresholds), and the resulting finding counts by severity. Tell them the file is committed with the project and can be hand-edited — re-running this command regenerates it deterministically.

Do not fabricate values; everything comes from the two tools above.
