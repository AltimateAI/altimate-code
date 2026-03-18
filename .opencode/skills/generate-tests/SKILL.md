---
name: generate-tests
description: Add dbt schema tests, unit tests, and data quality checks to models. Use when the user wants to test a model, validate assumptions, or add not_null/unique/relationship checks.
---

# Generate dbt Tests

## Requirements
**Agent:** builder or migrator (requires file write access)
**Tools used:** bash (runs `altimate-dbt` commands), read, write, edit, altimate_core_testgen, schema_inspect, dbt_profiles

## When to Use This Skill

**Use when the user wants to:**
- Add schema tests (not_null, unique, accepted_values, relationships) to a model
- Generate a complete schema.yml test block for a model or source
- Add dbt unit tests (dbt >= 1.8)
- Run data quality checks on existing models
- Auto-generate tests from column metadata

**Do NOT use for:**
- Writing model SQL logic → use `dbt-develop`
- Debugging test failures → use `dbt-troubleshoot`
- Generating documentation descriptions → use `dbt-docs`

## Core Workflow

### 1. Discover the Model

```bash
altimate-dbt columns --model <name>           # list columns and types
altimate-dbt build --model <name> --no-full-refresh  # ensure model builds first
```

Read the model's SQL to understand grain, keys, and business rules.

### 2. Generate Tests with altimate_core_testgen

Call `altimate_core_testgen` with the model name to auto-generate test candidates:
- It analyzes column names, types, and sample data to suggest tests
- Review suggestions and keep only those that reflect real business constraints

### 3. Write Schema Tests

Add or update the `schema.yml` entry for the model:

```yaml
models:
  - name: <model_name>
    columns:
      - name: <pk_column>
        tests:
          - not_null
          - unique
      - name: <fk_column>
        tests:
          - not_null
          - relationships:
              to: ref('<parent_model>')
              field: id
      - name: status
        tests:
          - accepted_values:
              values: ['active', 'inactive', 'pending']
```

### 4. Add Unit Tests (dbt >= 1.8)

For models with complex business logic, add a unit test block:

```yaml
unit_tests:
  - name: test_<model>_<scenario>
    model: <model_name>
    given:
      - input: ref('<parent_model>')
        rows:
          - {id: 1, amount: 100, status: 'active'}
    expect:
      rows:
        - {id: 1, total_amount: 100, is_active: true}
```

### 5. Run Tests

```bash
altimate-dbt build --model <name>             # builds model + runs all its tests
altimate-dbt test --model <name>              # runs tests only (skips build)
```

Fix any test failures before marking the task done.

## Iron Rules

1. **Never add a test you can't justify.** Each test must reflect a real constraint (PK, FK, business rule).
2. **Always run tests after writing them.** A test that errors is worse than no test.
3. **unique + not_null on every primary key.** No exceptions.
4. **relationships tests must reference the correct model and field.** Verify with `altimate-dbt columns`.

## Common Test Patterns

| Column Pattern | Tests to Add |
|---|---|
| `*_id` primary key | not_null, unique |
| `*_id` foreign key | not_null, relationships |
| `status`, `type`, `category` | accepted_values |
| `amount`, `count`, `quantity` | not_null |
| `created_at`, `updated_at` | not_null |
| Boolean flags | accepted_values: [true, false] |
