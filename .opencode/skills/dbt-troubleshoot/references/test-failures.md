# Test Failures

Test failures mean the data violates an expected constraint. The test is usually right — investigate before changing it.

## Diagnosis

```bash
altimate-dbt test --model <name>
```

## Common Test Failures

### `unique` test fails

**Meaning**: Duplicate values exist in the column.

**Investigate**:
```bash
altimate-dbt execute --query "
  SELECT <column>, count(*) as cnt
  FROM {{ ref('<model>') }}
  GROUP BY 1
  HAVING count(*) > 1
  ORDER BY cnt DESC
" --limit 10
```

**Common causes**:
- Missing deduplication in staging model
- Incorrect JOIN producing row multiplication (LEFT JOIN with 1:many relationship)
- Incorrect `GROUP BY` (missing a dimension)

### `not_null` test fails

**Meaning**: NULL values exist where they shouldn't.

**Investigate**:
```bash
altimate-dbt execute --query "
  SELECT * FROM {{ ref('<model>') }}
  WHERE <column> IS NULL
" --limit 5
```

**Common causes**:
- LEFT JOIN where INNER JOIN was intended (unmatched rows become NULL)
- Source data has genuine NULLs — may need `COALESCE()` or filter
- Wrong column referenced in the model SQL

### `accepted_values` test fails

**Meaning**: Values exist that weren't in the expected list.

**Investigate**:
```bash
altimate-dbt column-values --model <name> --column <column>
```

**Common causes**:
- New value appeared in source data (update the accepted list)
- Data quality issue upstream (fix the source or add a filter)
- Test list is incomplete (add the missing values)

### `relationships` test fails

**Meaning**: Foreign key references a value that doesn't exist in the parent table.

**Investigate**:
```bash
altimate-dbt execute --query "
  SELECT child.<fk_col>, count(*)
  FROM {{ ref('<child>') }} child
  LEFT JOIN {{ ref('<parent>') }} parent ON child.<fk_col> = parent.<pk_col>
  WHERE parent.<pk_col> IS NULL
  GROUP BY 1
" --limit 10
```

**Common causes**:
- Parent table hasn't been rebuilt with latest data
- Orphan records in source data
- Type mismatch between FK and PK (e.g., string vs integer)

## The Decision Framework

When a test fails:

1. **Understand**: Query the failing rows. Why do they exist?
2. **Classify**: Is it a data issue, a model logic bug, or a test definition problem?
3. **Fix the right thing**:
   - Data issue → fix upstream or add a filter/coalesce
   - Logic bug → fix the model SQL
   - Test is wrong → update the test (with explicit justification to the user)

**Never silently weaken a test.** If you need to change a test, explain why to the user.
