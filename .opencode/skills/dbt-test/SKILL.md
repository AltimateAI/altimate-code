---
name: dbt-test
description: Add schema tests, unit tests, and data quality checks to dbt models. Use when validating data integrity, adding test definitions to schema.yml, writing unit tests, or practicing test-driven development in dbt. Powered by altimate-dbt.
---

# dbt Testing

## Requirements
**Agent:** builder or migrator (requires file write access)
**Tools used:** bash (runs `altimate-dbt` commands), read, glob, write, edit

## When to Use This Skill

**Use when the user wants to:**
- Add tests to a model's schema.yml (unique, not_null, relationships, accepted_values)
- Write dbt unit tests (mock inputs → expected outputs)
- Create custom generic or singular tests
- Debug why a test is failing
- Practice test-driven development in dbt

**Do NOT use for:**
- Creating or modifying model SQL → use `dbt-develop`
- Writing model descriptions → use `dbt-docs`
- Debugging build/compilation errors → use `dbt-troubleshoot`

## The Iron Rule

**Never modify a test to make it pass without understanding why it's failing.**

A failing test is information. It means either:
1. The data has a real quality issue (fix the data or the model)
2. The test expectation is wrong (update the test with justification)
3. The model logic is wrong (fix the model)

Option 2 requires explicit user confirmation. Do not silently weaken tests.

## Schema Test Workflow

### 1. Discover Columns

```bash
altimate-dbt columns --model <name>
altimate-dbt column-values --model <name> --column <col>
```

### 2. Read Existing Tests

```bash
glob models/**/*schema*.yml models/**/*_models.yml
read <yaml_file>
```

### 3. Generate Tests

Apply test rules based on column patterns — see [references/schema-test-patterns.md](references/schema-test-patterns.md).

### 4. Write YAML

Merge into existing schema.yml (don't duplicate). Use `edit` for existing files, `write` for new ones.

### 5. Run Tests

```bash
altimate-dbt test --model <name>          # run tests for this model
altimate-dbt build --model <name>         # build + test together
```

## Unit Test Workflow

See [references/unit-test-guide.md](references/unit-test-guide.md) for the full unit test framework.

### Quick Pattern

```yaml
unit_tests:
  - name: test_order_total_calculation
    model: fct_orders
    given:
      - input: ref('stg_orders')
        rows:
          - { order_id: 1, quantity: 3, unit_price: 10.00 }
          - { order_id: 2, quantity: 1, unit_price: 25.00 }
    expect:
      rows:
        - { order_id: 1, order_total: 30.00 }
        - { order_id: 2, order_total: 25.00 }
```

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Testing every column with `not_null` | Only test columns that should never be null. Think about what NULL means. |
| Missing `unique` test on primary keys | Every primary key needs `unique` + `not_null` |
| `accepted_values` with incomplete list | Use `altimate-dbt column-values` to discover real values first |
| Modifying a test to make it pass | Understand WHY it fails first. The test might be right. |
| No `relationships` test on foreign keys | Add `relationships: {to: ref('parent'), field: parent_id}` |
| Unit testing trivial logic | Don't unit test `SELECT a, b FROM source`. Test calculations and business logic. |

## Reference Guides

| Guide | Use When |
|-------|----------|
| [references/altimate-dbt-commands.md](references/altimate-dbt-commands.md) | Need the full CLI reference |
| [references/schema-test-patterns.md](references/schema-test-patterns.md) | Adding schema.yml tests by column pattern |
| [references/unit-test-guide.md](references/unit-test-guide.md) | Writing dbt unit tests |
| [references/custom-tests.md](references/custom-tests.md) | Creating generic or singular tests |
