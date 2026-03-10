Expectations apply data quality constraints to Lakeflow Spark Declarative Pipelines tables and views in Python. They use SQL Boolean expressions to validate each record and take actions when constraints are violated.

## When to Use Expectations

- Apply to `@dp.materialized_view()`/`@dp.table()`/`@dlt.table()`/`@dp.temporary_view()`/`@dp.view()`/`@dlt.view()` decorated functions
- Use on streaming tables, materialized views, or temporary views
- Stack multiple expectation decorators above the dataset function

## Decorator Types

### Single Expectation Decorators

**@dp.expect(description, constraint)** (or **@dlt.expect(description, constraint)**)

- Logs violations but allows invalid records to pass through
- Collects metrics for monitoring

**@dp.expect_or_drop(description, constraint)** (or **@dlt.expect_or_drop(description, constraint)**)

- Removes invalid records before writing to target
- Logs dropped record metrics

**@dp.expect_or_fail(description, constraint)** (or **@dlt.expect_or_fail(description, constraint)**)

- Stops pipeline execution immediately on violation
- Requires manual intervention to resolve

### Multiple Expectations Decorators

**@dp.expect_all({description: constraint, ...})** (or **@dlt.expect_all({description: constraint, ...})**)

- Applies multiple warn-level expectations
- Takes dictionary of description-constraint pairs

**@dp.expect_all_or_drop({description: constraint, ...})** (or **@dlt.expect_all_or_drop({description: constraint, ...})**)

- Applies multiple drop-level expectations
- Records dropped if any constraint fails

**@dp.expect_all_or_fail({description: constraint, ...})** (or **@dlt.expect_all_or_fail({description: constraint, ...})**)

- Applies multiple fail-level expectations
- Pipeline stops if any constraint fails

## Parameters

**description** (str, required)

- Unique identifier for the constraint within the dataset
- Should clearly communicate what is being validated
- Can be reused across different datasets

**constraint** (str, required)

- SQL Boolean expression evaluated per record
- Must return true or false
- Cannot contain Python functions or UDFs, external calls, or subqueries
- Cannot include subqueries in constraint logic

## Usage Examples

All variants below work on both the `table`, `materialized_view` or `view` decorators.

### Basic Single Expectation

```python
@dp.materialized_view()
@dp.expect("valid_price", "price >= 0")
def sales_data():
    return spark.read.table("raw_sales")

@dp.table()
@dp.expect("valid_price", "price >= 0")
def sales_data():
    return spark.read.table("raw_sales")
```

### Drop Invalid Records

```python
@dp.materialized_view()
@dp.expect_or_drop("valid_email", "email IS NOT NULL AND email LIKE '%@%'")
def customer_contacts():
    return spark.read.table("raw_contacts")
```

### Fail on Critical Violations

```python
@dp.materialized_view()
@dp.expect_or_fail("required_id", "customer_id IS NOT NULL")
def customer_master():
    return spark.read.table("raw_customers")
```

### Multiple Expectations

```python
@dp.materialized_view()
@dp.expect_all({
    "valid_age": "age >= 0 AND age <= 120",
    "valid_country": "country_code IN ('US', 'CA', 'MX')",
    "recent_date": "created_date >= '2020-01-01'"
})
def validated_customers():
    return spark.read.table("raw_customers")
```

### Stacking Multiple Decorators

```python
@dp.materialized_view(
    comment="Clean customer data with quality checks"
)
@dp.expect_or_drop("valid_email", "email LIKE '%@%'")
@dp.expect_or_fail("required_id", "id IS NOT NULL")
@dp.expect("valid_age", "age BETWEEN 0 AND 120")
def customers_clean():
    return spark.read.table("raw_customers")
```

### With Views

```python
@dp.view(
    name="high_value_customers",
    comment="Customers with total purchases over $1000"
)
@dp.expect("valid_total", "total_purchases > 0")
def high_value_view():
    return spark.read.table("orders") \
        .groupBy("customer_id") \
        .agg(sum("amount").alias("total_purchases")) \
        .filter("total_purchases > 1000")
```

## Monitoring

- View metrics in pipeline UI
- Query the event log for detailed analytics
- Metrics unavailable if pipeline fails or no updates occur

## Best Practices

- Use unique, descriptive names for each expectation
- Apply `expect_or_fail` for critical business constraints
- Use `expect_or_drop` for data cleansing operations
- Use `expect` for monitoring optional quality metrics
- Keep constraint logic simple and SQL-based only
- Group related expectations using `expect_all` variants
