---
name: dbt-unit-tests
description: Generate dbt unit tests automatically for any model. Analyzes SQL logic (CASE/WHEN, JOINs, window functions, NULLs), creates type-correct mock inputs from manifest schema, and assembles complete YAML. Use when a user says "generate tests", "add unit tests", "test this model", or "test coverage" for dbt models.
---

# dbt Unit Test Generation

## Requirements
**Agent:** builder or migrator (requires file write access)
**Tools used:** dbt_unit_test_gen, dbt_manifest, dbt_lineage, altimate_core_validate, altimate_core_testgen, bash (runs `altimate-dbt` commands), read, glob, write, edit

## When to Use This Skill

**Use when the user wants to:**
- Generate unit tests for a dbt model
- Add test coverage to an existing model
- Create mock data for testing
- Test-driven development (TDD) for dbt
- Verify CASE/WHEN logic, NULL handling, JOIN behavior, or aggregation correctness
- Test incremental model logic

**Do NOT use for:**
- Adding schema tests (not_null, unique, accepted_values) -> use `dbt-test`
- Creating or modifying model SQL -> use `dbt-develop`
- Writing descriptions -> use `dbt-docs`
- Debugging build failures -> use `dbt-troubleshoot`

## The Iron Rules

1. **Never guess expected outputs.** Compute them by running SQL against mock data when possible. If you cannot run SQL, clearly mark expected outputs as placeholders that need verification.
2. **Never skip upstream dependencies.** Every ref() and source() the model touches MUST have a mock input. Miss one and the test won't compile.
3. **Use sql format for ephemeral models.** Dict format fails silently for ephemeral upstreams.
4. **Never weaken a test to make it pass.** If the test fails, the model logic may be wrong. Investigate before changing expected values.
5. **Compile before committing.** Always run `altimate-dbt test --model <name>` to verify tests compile and execute.

## Core Workflow: Analyze -> Generate -> Refine -> Validate -> Write

### Phase 1: Analyze the Model

Before generating any tests, deeply understand the model:

```bash
# 1. Ensure manifest is compiled
altimate-dbt compile --model <name>

# 2. Read the model SQL
read <model_sql_file>

# 3. Parse the manifest for dependencies
dbt_unit_test_gen(manifest_path: "target/manifest.json", model: "<name>")
```

**What to look for:**
- Which upstream refs/sources does this model depend on?
- What SQL constructs need testing? (CASE/WHEN, JOINs, window functions, aggregations)
- What edge cases exist? (NULLs, empty strings, zero values, boundary dates)
- Is this an incremental model? (needs `is_incremental` override tests)
- Are any upstream models ephemeral? (need sql format)

### Phase 2: Generate Tests

The `dbt_unit_test_gen` tool does the heavy lifting:

```text
dbt_unit_test_gen(
  manifest_path: "target/manifest.json",
  model: "fct_orders",
  max_scenarios: 5
)
```

This returns:
- Complete YAML with mock inputs and expected outputs
- Semantic context: model/column descriptions, column lineage, compiled SQL
- List of anti-patterns that informed edge case generation
- Warnings about ephemeral deps, missing columns, etc.

**If the tool reports missing columns** (placeholder rows in the YAML), discover them:
```bash
altimate-dbt columns --model <upstream_model_name>
altimate-dbt columns-source --source <source_name> --table <table_name>
```
Then update the generated YAML with real column names.

### Phase 3: Refine Expected Outputs

**This is the critical step that differentiates good tests from bad ones.**

The tool generates placeholder expected outputs based on column types. You MUST refine them:

**Option A: Compute by running SQL (preferred)**
```bash
# Run the model against mock data to get actual output
altimate-dbt test --model <name>
# If the test fails, the error shows actual vs expected — use actual as expected
```

**Option B: Manual computation**
Read the model SQL carefully and mentally execute it against the mock inputs.
For each test case:
1. Look at the mock input rows
2. Trace through the SQL logic (CASE/WHEN branches, JOINs, aggregations)
3. Write the correct expected output

**Option C: Use the warehouse (most accurate)**
```bash
# Build a CTE query with mock data and run the model SQL against it
altimate-dbt execute --query "WITH mock_stg_orders AS (SELECT 1 AS order_id, 100.00 AS amount) SELECT * FROM (<model_sql>) sub"
```

### Phase 4: Validate

```bash
# 1. Run the unit tests
altimate-dbt test --model <name>

# 2. If tests fail, read the error carefully
#    - Compilation error? Missing ref, wrong column name, type mismatch
#    - Assertion error? Expected output doesn't match actual

# 3. Fix and retry (max 3 iterations)
```

### Phase 5: Write to File

Place unit tests in one of these locations (match project convention):
- `models/<layer>/_unit_tests.yml` (dedicated file)
- `models/<layer>/schema.yml` (append to existing)

```bash
# Check existing convention
glob models/**/*unit_test*.yml models/**/*schema*.yml

# Write or append
edit <yaml_file>  # if file exists
write <yaml_file> # if creating new
```

## Test Case Categories

### Happy Path (always generate)
Standard inputs that exercise the main logic path. 2 rows minimum.

### NULL Handling
Set nullable columns to NULL in the last row. Verify COALESCE/NVL/IFNULL behavior.

### Boundary Values
Zero amounts, empty strings, epoch dates, MAX values. Tests robustness.

### Edge Cases
- Division by zero (if model divides)
- Non-matching JOINs (LEFT JOIN with no match)
- Single-row aggregation
- Duplicate key handling

### Incremental
For incremental models only. Use `overrides.macros.is_incremental: true` to test the incremental path.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Missing a ref() in given | Parse manifest for ALL depends_on nodes |
| Wrong column names in mock data | Use manifest columns, not guesses |
| Wrong data types | Use schema catalog types |
| Expected output is just mock input | Actually compute the transformation |
| Dict format for ephemeral model | Use `format: sql` with raw SQL |
| Not testing NULL path in COALESCE | Add null_handling test case |
| Hardcoded dates with current_timestamp | Use overrides.macros to mock timestamps |
| Testing trivial pass-through | Skip models with no logic |

## YAML Format Reference

```yaml
unit_tests:
  - name: test_<model>_<scenario>
    description: "What this test verifies"
    model: <model_name>
    overrides:                    # optional
      macros:
        is_incremental: true      # for incremental models
      vars:
        run_date: "2024-01-15"    # for date-dependent logic
    given:
      - input: ref('upstream_model')
        rows:
          - { col1: value1, col2: value2 }
      - input: source('source_name', 'table_name')
        rows:
          - { col1: value1 }
      - input: ref('ephemeral_model')
        format: sql
        rows: |
          SELECT 1 AS id, 'test' AS name
          UNION ALL
          SELECT 2 AS id, 'other' AS name
    expect:
      rows:
        - { output_col1: expected1, output_col2: expected2 }
```

## Reference Guides

| Guide | Use When |
|-------|----------|
| [references/unit-test-yaml-spec.md](references/unit-test-yaml-spec.md) | Full YAML specification and format details |
| [references/edge-case-patterns.md](references/edge-case-patterns.md) | Catalog of edge cases by SQL construct |
| [references/incremental-testing.md](references/incremental-testing.md) | Testing incremental models |
| [references/altimate-dbt-commands.md](references/altimate-dbt-commands.md) | Full CLI reference |
