Views in Spark Declarative Pipelines create virtual tables published to the Unity Catalog metastore. Unlike temporary views (which are private to the pipeline), views created with CREATE VIEW are accessible outside the pipeline and persist in the catalog.

**API Reference:**

**CREATE VIEW**
SQL statement to define a persistent view in Unity Catalog.

```sql
CREATE VIEW view_name
  [COMMENT view_comment]
  [TBLPROPERTIES (key = value [, ...])]
AS query
```

Parameters:

- `view_name` (identifier): Unique identifier within the catalog and schema
- `view_comment` (string): Optional description for the view
- `TBLPROPERTIES` (key-value pairs): Optional table properties
- `query` (SELECT statement): Query that defines the view's data (must be batch, not streaming)

**Common Patterns:**

**Pattern 1: Filtered view for reusable logic**

```sql
-- View with filtering logic published to catalog
CREATE VIEW valid_orders
COMMENT 'Orders with valid data for analysis'
AS SELECT *
FROM raw.orders
WHERE order_id IS NOT NULL
  AND customer_id IS NOT NULL
  AND order_date IS NOT NULL;

-- Multiple downstream tables can reference this view
CREATE MATERIALIZED VIEW orders_by_region
AS SELECT
  region,
  COUNT(*) AS order_count,
  SUM(amount) AS total_revenue
FROM valid_orders
GROUP BY region;
```

**Pattern 2: View with custom properties**

```sql
-- View with table properties for metadata
CREATE VIEW customer_summary
COMMENT 'Aggregated customer metrics'
TBLPROPERTIES (
  'quality' = 'silver',
  'owner' = 'analytics-team',
  'refresh_frequency' = 'daily'
)
AS SELECT
  customer_id,
  COUNT(DISTINCT order_id) AS total_orders,
  SUM(amount) AS lifetime_value,
  MAX(order_date) AS last_order_date
FROM valid_orders
GROUP BY customer_id;
```

**KEY RULES:**

- Views are virtual tables - not materialized, computed on demand when referenced
- Views are published to Unity Catalog and accessible outside the pipeline
- Views require Unity Catalog pipelines with default publishing mode
- Does not support explicit column definitions with COMMENT
- Cannot use `STREAM()` function - views must use batch queries only
- Cannot define expectations (CONSTRAINT clauses) on views
- Views require appropriate permissions: SELECT on source tables, CREATE TABLE on target schema
- For pipeline-private views, use `CREATE TEMPORARY VIEW` instead
- For materialized data persistence, use `CREATE MATERIALIZED VIEW` instead
