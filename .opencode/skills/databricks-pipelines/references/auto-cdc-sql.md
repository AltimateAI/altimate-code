Auto CDC in Declarative Pipelines processes change data capture (CDC) events from streaming sources.

**API Reference:**

**CREATE FLOW ... AS AUTO CDC INTO**
Applies CDC operations (inserts, updates, deletes) from a streaming source to a target table. Supports SCD Type 1 (latest) and Type 2 (history). Must be used with a pre-created streaming table.

```sql
CREATE OR REFRESH STREAMING TABLE <target_table>;

CREATE FLOW <flow_name> AS AUTO CDC INTO <target_table>
FROM <source>
KEYS (<key1>, <key2>)
[IGNORE NULL UPDATES]
[APPLY AS DELETE WHEN <condition>]
[APPLY AS TRUNCATE WHEN <condition>]
SEQUENCE BY <sequence_column>
[COLUMNS {<column_list> | * EXCEPT (<except_column_list>)}]
[STORED AS {SCD TYPE 1 | SCD TYPE 2}]
[TRACK HISTORY ON {<column_list> | * EXCEPT (<except_column_list>)}]
```

Parameters:

- `target_table` (identifier): Target table name (must exist, create with `CREATE OR REFRESH STREAMING TABLE`). **Required.**
- `flow_name` (identifier): Identifier for the created flow. **Required.**
- `source` (identifier or expression): Streaming source with CDC events. Use `STREAM(<table_name>)` to read with streaming semantics. **Required.**
- `KEYS` (column list): Primary key columns for row identification. **Required.**
- `IGNORE NULL UPDATES` (optional): If specified, NULL values won't overwrite existing non-NULL values
- `APPLY AS DELETE WHEN` (optional): Condition identifying delete operations (e.g., `operation = 'DELETE'`)
- `APPLY AS TRUNCATE WHEN` (optional): Condition identifying truncate operations (supported only for SCD Type 1)
- `SEQUENCE BY` (column or struct): Column for ordering events (timestamp, version). **Required.** For multi-column sequencing, use `SEQUENCE BY STRUCT(timestamp_col, id_col)` to order by the first field first, then break ties with subsequent fields.
- `COLUMNS` (optional): Columns to include or exclude (use `column1, column2` or `* EXCEPT (column1, column2)`)
- `STORED AS` (optional): `SCD TYPE 1` for latest values (default), `SCD TYPE 2` for full history with `__START_AT`/`__END_AT` columns
- `TRACK HISTORY ON` (optional): For SCD Type 2, columns to track history for (others use Type 1)

**Common Patterns:**

**Pattern 1: Basic CDC flow from streaming source**

```sql
-- Step 1: Create target table
CREATE OR REFRESH STREAMING TABLE users;

-- Step 2: Define CDC flow using STREAM() for streaming semantics
CREATE FLOW user_flow AS AUTO CDC INTO users
FROM STREAM(user_changes)
KEYS (user_id)
SEQUENCE BY updated_at;
```

**Pattern 2: CDC with source filtering via temporary view**

```sql
-- Step 1: Create temporary view to filter/transform source data
CREATE OR REFRESH TEMPORARY VIEW filtered_changes AS
SELECT * FROM source_table WHERE status = 'active';

-- Step 2: Create target table
CREATE OR REFRESH STREAMING TABLE active_records;

-- Step 3: Define CDC flow reading from the temporary view
CREATE FLOW active_flow AS AUTO CDC INTO active_records
FROM STREAM(filtered_changes)
KEYS (record_id)
SEQUENCE BY updated_at;
```

**Pattern 3: CDC with explicit deletes**

```sql
CREATE OR REFRESH STREAMING TABLE orders;

CREATE FLOW order_flow AS AUTO CDC INTO orders
FROM STREAM(order_events)
KEYS (order_id)
IGNORE NULL UPDATES
APPLY AS DELETE WHEN operation = 'DELETE'
SEQUENCE BY event_timestamp;
```

**Pattern 4: SCD Type 2 (Historical tracking)**

```sql
CREATE OR REFRESH STREAMING TABLE customer_history;

CREATE FLOW customer_flow AS AUTO CDC INTO customer_history
FROM STREAM(customer_changes)
KEYS (customer_id)
SEQUENCE BY changed_at
STORED AS SCD TYPE 2;
-- Target will include __START_AT and __END_AT columns
```

**Pattern 5: Multi-column sequencing**

```sql
CREATE OR REFRESH STREAMING TABLE events;

CREATE FLOW event_flow AS AUTO CDC INTO events
FROM STREAM(event_changes)
KEYS (event_id)
SEQUENCE BY STRUCT(event_timestamp, event_id)
STORED AS SCD TYPE 1;
```

**Pattern 6: Selective column inclusion**

```sql
CREATE OR REFRESH STREAMING TABLE accounts;

CREATE FLOW account_flow AS AUTO CDC INTO accounts
FROM STREAM(account_changes)
KEYS (account_id)
SEQUENCE BY modified_at
COLUMNS account_id, balance, status
STORED AS SCD TYPE 1;
```

**Pattern 7: Selective column exclusion**

```sql
CREATE OR REFRESH STREAMING TABLE products;

CREATE FLOW product_flow AS AUTO CDC INTO products
FROM STREAM(product_changes)
KEYS (product_id)
SEQUENCE BY updated_at
COLUMNS * EXCEPT (internal_notes, temp_field);
```

**Pattern 8: SCD Type 2 with selective history tracking**

```sql
CREATE OR REFRESH STREAMING TABLE accounts;

CREATE FLOW account_flow AS AUTO CDC INTO accounts
FROM STREAM(account_changes)
KEYS (account_id)
IGNORE NULL UPDATES
SEQUENCE BY modified_at
STORED AS SCD TYPE 2
TRACK HISTORY ON balance, status;
-- Only balance and status changes create new history records
```

**Pattern 9: SCD Type 2 with history tracking exclusion**

```sql
CREATE OR REFRESH STREAMING TABLE accounts;

CREATE FLOW account_flow AS AUTO CDC INTO accounts
FROM STREAM(account_changes)
KEYS (account_id)
SEQUENCE BY modified_at
STORED AS SCD TYPE 2
TRACK HISTORY ON * EXCEPT (last_login, view_count);
-- Track history on all columns except last_login and view_count
```

**Pattern 10: Truncate support (SCD Type 1 only)**

```sql
CREATE OR REFRESH STREAMING TABLE inventory;

CREATE FLOW inventory_flow AS AUTO CDC INTO inventory
FROM STREAM(inventory_events)
KEYS (product_id)
APPLY AS TRUNCATE WHEN operation = 'TRUNCATE'
SEQUENCE BY event_timestamp
STORED AS SCD TYPE 1;
```

**KEY RULES:**

- Create target with `CREATE OR REFRESH STREAMING TABLE` before defining CDC flow
- `source` must be a streaming source for safe CDC change processing. Use `STREAM(<table_name>)` to read an existing table/view with streaming semantics
- The `STREAM()` function accepts ONLY a table/view identifier - NOT a subquery. Define source data as a separate streaming table or temporary view first, then reference it in the flow
- SCD Type 2 adds `__START_AT` and `__END_AT` columns for validity tracking
- When specifying the schema of the target table for SCD Type 2, you must also include the `__START_AT` and `__END_AT` columns with the same data type as the `SEQUENCE BY` field
- Legacy `APPLY CHANGES INTO` API is equivalent but deprecated - prefer `AUTO CDC INTO`
- `AUTO CDC FROM SNAPSHOT` is only available in Python, not in SQL. SQL only supports `AUTO CDC INTO` for processing CDC events from streaming sources.
