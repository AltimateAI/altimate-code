Expectations apply data quality constraints to Lakeflow Spark Declarative Pipelines tables and views in SQL. They use SQL Boolean expressions to validate each record and take actions when constraints are violated.

## When to Use Expectations

- Apply within `CREATE OR REFRESH STREAMING TABLE`, `CREATE OR REFRESH MATERIALIZED VIEW`, or `CREATE LIVE VIEW` statements
- Use as optional clauses in table/view creation statements
- Stack multiple CONSTRAINT clauses (comma-separated) in a single statement

**Note on Temporary Views**: Use `CREATE LIVE VIEW` syntax when you need to include expectations with temporary views. The newer `CREATE TEMPORARY VIEW` syntax does not support CONSTRAINT clauses. `CREATE LIVE VIEW` is retained specifically for this use case, even though `CREATE TEMPORARY VIEW` is otherwise preferred for temporary views without expectations.

## Constraint Syntax

### Single Expectation (Warn)

**CONSTRAINT constraint_name EXPECT (condition)**

- Logs violations but allows invalid records to pass through
- Collects metrics for monitoring
- Invalid records are retained in target dataset

### Single Expectation (Drop)

**CONSTRAINT constraint_name EXPECT (condition) ON VIOLATION DROP ROW**

- Removes invalid records before writing to target
- Logs dropped record metrics
- Invalid records are excluded from target

### Single Expectation (Fail)

**CONSTRAINT constraint_name EXPECT (condition) ON VIOLATION FAIL UPDATE**

- Stops pipeline execution immediately on violation
- Requires manual intervention to resolve
- Transaction rolls back atomically

### Multiple Expectations

Multiple CONSTRAINT clauses can be stacked in a single CREATE statement using commas:

```sql
CREATE OR REFRESH STREAMING TABLE table_name(
  CONSTRAINT name1 EXPECT (condition1),
  CONSTRAINT name2 EXPECT (condition2) ON VIOLATION DROP ROW,
  CONSTRAINT name3 EXPECT (condition3) ON VIOLATION FAIL UPDATE
) AS SELECT ...
```

## Parameters

**constraint_name** (required)

- Unique identifier for the constraint within the dataset
- Should clearly communicate what is being validated
- Can be reused across different datasets

**condition** (required)

- SQL Boolean expression evaluated per record
- Must return true or false
- Can include SQL functions (e.g., year(), date(), CASE statements)
- Cannot contain Python functions or UDFs, external calls, or subqueries

## Usage Examples

### Basic Single Expectation

```sql
CREATE OR REFRESH STREAMING TABLE sales_data(
  CONSTRAINT valid_price EXPECT (price >= 0)
) AS
SELECT * FROM STREAM(raw_sales);
```

### Drop Invalid Records

```sql
CREATE OR REFRESH STREAMING TABLE customer_contacts(
  CONSTRAINT valid_email EXPECT (
    email IS NOT NULL AND email LIKE '%@%'
  ) ON VIOLATION DROP ROW
) AS
SELECT * FROM STREAM(raw_contacts);
```

### Fail on Critical Violations

```sql
CREATE OR REFRESH MATERIALIZED VIEW customer_master(
  CONSTRAINT required_id EXPECT (customer_id IS NOT NULL) ON VIOLATION FAIL UPDATE
) AS
SELECT * FROM raw_customers;
```

### Multiple Expectations

```sql
CREATE OR REFRESH STREAMING TABLE validated_customers(
  CONSTRAINT valid_age EXPECT (age >= 0 AND age <= 120),
  CONSTRAINT valid_country EXPECT (country_code IN ('US', 'CA', 'MX')),
  CONSTRAINT recent_date EXPECT (created_date >= '2020-01-01')
) AS
SELECT * FROM STREAM(raw_customers);
```

### Stacking Multiple Constraints with Different Actions

```sql
CREATE OR REFRESH STREAMING TABLE customers_clean
(
  CONSTRAINT valid_email EXPECT (email LIKE '%@%') ON VIOLATION DROP ROW,
  CONSTRAINT required_id EXPECT (id IS NOT NULL) ON VIOLATION FAIL UPDATE,
  CONSTRAINT valid_age EXPECT (age BETWEEN 0 AND 120)
)
COMMENT "Clean customer data with quality checks" AS
SELECT * FROM STREAM(raw_customers);
```

### With SQL Functions

```sql
CREATE OR REFRESH STREAMING TABLE transactions(
  CONSTRAINT valid_date EXPECT (year(transaction_date) >= 2020),
  CONSTRAINT non_negative_price EXPECT (price >= 0),
  CONSTRAINT valid_purchase_date EXPECT (transaction_date <= current_date())
) AS
SELECT * FROM STREAM(raw_transactions);
```

### Complex Business Logic

```sql
CREATE OR REFRESH MATERIALIZED VIEW active_subscriptions(
  CONSTRAINT valid_subscription_dates EXPECT (
    start_date <= end_date
    AND end_date <= current_date()
    AND start_date >= '2020-01-01'
  ) ON VIOLATION DROP ROW
) AS
SELECT * FROM subscriptions WHERE status = 'active';
```

### With Temporary Views

```sql
CREATE LIVE VIEW high_value_customers(
  CONSTRAINT valid_total EXPECT (total_purchases > 0)
)
COMMENT "Customers with total purchases over $1000" AS
SELECT
  customer_id,
  SUM(amount) AS total_purchases
FROM orders
GROUP BY customer_id
HAVING total_purchases > 1000;
```

## Monitoring

- View metrics in pipeline UI under the **Data quality** tab
- Query the event log for detailed analytics
- Metrics available for `warn` and `drop` actions
- Metrics unavailable if pipeline fails or no updates occur

## Best Practices

- Use unique, descriptive names for each constraint
- Apply `ON VIOLATION FAIL UPDATE` for critical business constraints
- Use `ON VIOLATION DROP ROW` for data cleansing operations
- Use default (warn) behavior for monitoring optional quality metrics
- Keep constraint logic simple
