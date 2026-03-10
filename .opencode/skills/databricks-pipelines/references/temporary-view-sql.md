Temporary Views in Spark Declarative Pipelines create temporary logical datasets without persisting data to storage. Use views for intermediate transformations that drive downstream workloads but don't need materialization.

**API Reference:**

**CREATE TEMPORARY VIEW**
SQL statement to define a temporary view.

```sql
CREATE TEMPORARY VIEW view_name
  [(col_name [COMMENT col_comment] [, ...])]
  [COMMENT view_comment]
  [TBLPROPERTIES (key = value [, ...])]
AS query
```

Parameters:

- `view_name` (identifier): Name of the temporary view
- `col_name` (identifier): Optional column name specifications
- `col_comment` (string): Optional description for individual columns
- `view_comment` (string): Optional description for the view
- `TBLPROPERTIES` (key-value pairs): Optional table properties
- `query` (SELECT statement): Query that defines the view's data

**Common Patterns:**

**Pattern 1: Intermediate transformation layer**

```sql
-- View for shared filtering logic
CREATE TEMPORARY VIEW valid_events
AS SELECT * FROM raw.events
WHERE event_type IS NOT NULL
  AND timestamp IS NOT NULL;

-- Multiple tables consume the view
CREATE MATERIALIZED VIEW user_events
AS SELECT * FROM valid_events
WHERE event_type = 'user_action';

CREATE MATERIALIZED VIEW system_events
AS SELECT * FROM valid_events
WHERE event_type = 'system_event';
```

**Pattern 2: Views with streaming sources**

```sql
-- Temporary views work with streaming sources too
CREATE TEMPORARY VIEW streaming_events
AS SELECT * FROM STREAM(bronze.events)
WHERE event_id IS NOT NULL;

-- Downstream streaming table consuming the view
CREATE STREAMING TABLE filtered_stream
AS SELECT * FROM STREAM(streaming_events)
WHERE event_type = 'critical';
```

**KEY RULES:**

- Views are not materialized - they're computed on demand when referenced
- Views exist only during the pipeline execution lifetime and are private to the pipeline
- Reference views in downstream tables using `FROM view_name` or `FROM STREAM(view_name)` for streaming
- Views prevent code duplication when multiple downstream tables need the same transformation
- Temporary views work with both batch and streaming data sources (using `STREAM()` function)
- Views can share names with catalog objects; within the pipeline, references resolve to the temporary view

**IMPORTANT - Using Expectations with Temporary Views:**

`CREATE TEMPORARY VIEW` does not support CONSTRAINT clauses for expectations. If you need to include expectations (data quality constraints) with a temporary view, use `CREATE LIVE VIEW` syntax instead:

```sql
CREATE LIVE VIEW view_name(
  CONSTRAINT constraint_name EXPECT (condition) [ON VIOLATION DROP ROW | FAIL UPDATE]
)
AS query
```

`CREATE LIVE VIEW` is the older syntax for temporary views, retained specifically for this use case. Use `CREATE TEMPORARY VIEW` for views without expectations, and `CREATE LIVE VIEW` when you need to add CONSTRAINT clauses.

For detailed information on using expectations with temporary views, see the "expectations" API guide.
