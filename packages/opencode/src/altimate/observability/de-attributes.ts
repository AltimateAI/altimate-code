/**
 * Data Engineering semantic conventions for trace attributes.
 *
 * These are well-known attribute keys that tools can optionally populate
 * on trace spans. All are strictly optional — traces are valid without them.
 *
 * Naming convention: `de.<domain>.<field>` (inspired by OTel semantic conventions).
 *
 * Usage in tool implementations:
 *   tracer.setSpanAttributes({
 *     [DE.SQL.QUERY_TEXT]: "SELECT ...",
 *     [DE.WAREHOUSE.BYTES_SCANNED]: 1_500_000,
 *   })
 */

// ---------------------------------------------------------------------------
// Warehouse cost & performance (Layer 1)
// ---------------------------------------------------------------------------

export const DE_WAREHOUSE = {
  /** Database system name: snowflake, bigquery, postgresql, databricks, redshift */
  SYSTEM: "de.warehouse.system",
  /** Total bytes scanned by the query */
  BYTES_SCANNED: "de.warehouse.bytes_scanned",
  /** Billable bytes (may differ from scanned — BigQuery rounds up) */
  BYTES_BILLED: "de.warehouse.bytes_billed",
  /** Snowflake credits consumed (estimated) */
  CREDITS_CONSUMED: "de.warehouse.credits_consumed",
  /** BigQuery slot-milliseconds */
  SLOT_MS: "de.warehouse.slot_ms",
  /** Databricks DBU consumed */
  DBU_CONSUMED: "de.warehouse.dbu_consumed",
  /** Redshift RPU-seconds */
  RPU_SECONDS: "de.warehouse.rpu_seconds",
  /** Partitions scanned */
  PARTITIONS_SCANNED: "de.warehouse.partitions_scanned",
  /** Total partitions available */
  PARTITIONS_TOTAL: "de.warehouse.partitions_total",
  /** Pruning efficiency ratio (0.0 = perfect, 1.0 = full scan) */
  PRUNING_RATIO: "de.warehouse.pruning_ratio",
  /** Memory spill to disk in bytes */
  SPILL_BYTES: "de.warehouse.spill_bytes",
  /** Estimated cost in USD for this query */
  ESTIMATED_COST_USD: "de.warehouse.estimated_cost_usd",
  /** Warehouse size (e.g., "X-Small", "Medium", "2X-Large") */
  WAREHOUSE_SIZE: "de.warehouse.warehouse_size",
  /** Query execution time in milliseconds */
  EXECUTION_TIME_MS: "de.warehouse.execution_time_ms",
  /** Query compilation time in milliseconds */
  COMPILATION_TIME_MS: "de.warehouse.compilation_time_ms",
  /** Time spent waiting in queue in milliseconds */
  QUEUE_TIME_MS: "de.warehouse.queue_time_ms",
  /** Total query time end-to-end in milliseconds (compile + queue + execute) */
  TOTAL_TIME_MS: "de.warehouse.total_time_ms",
  /** Rows returned by the query */
  ROWS_RETURNED: "de.warehouse.rows_returned",
  /** Rows affected (INSERT/UPDATE/DELETE) */
  ROWS_AFFECTED: "de.warehouse.rows_affected",
  /** Query ID from the warehouse (for linking to warehouse query history) */
  QUERY_ID: "de.warehouse.query_id",
  /** Whether the query hit a warehouse cache (Snowflake result cache, BQ cache) */
  CACHE_HIT: "de.warehouse.cache_hit",
} as const

// ---------------------------------------------------------------------------
// SQL quality & analysis (Layer 2)
// ---------------------------------------------------------------------------

export const DE_SQL = {
  /** The SQL query text */
  QUERY_TEXT: "de.sql.query_text",
  /** Low-cardinality query summary (e.g., "SELECT from orders JOIN users") */
  QUERY_SUMMARY: "de.sql.query_summary",
  /** SQL dialect: snowflake_sql, bigquery_sql, postgresql, etc. */
  DIALECT: "de.sql.dialect",
  /** Whether the SQL passed syntax validation */
  VALIDATION_VALID: "de.sql.validation.valid",
  /** Validation error message (if invalid) */
  VALIDATION_ERROR: "de.sql.validation.error",
  /** Number of type errors found */
  VALIDATION_TYPE_ERRORS: "de.sql.validation.type_errors",
  /** Input tables referenced by the query (JSON array of strings) */
  LINEAGE_INPUT_TABLES: "de.sql.lineage.input_tables",
  /** Output table written to */
  LINEAGE_OUTPUT_TABLE: "de.sql.lineage.output_table",
  /** Columns read (JSON array) */
  LINEAGE_COLUMNS_READ: "de.sql.lineage.columns_read",
  /** Columns written (JSON array) */
  LINEAGE_COLUMNS_WRITTEN: "de.sql.lineage.columns_written",
  /** Transformation type: IDENTITY, AGGREGATION, JOIN, FILTER, WINDOW */
  LINEAGE_TRANSFORMATION: "de.sql.lineage.transformation_type",
  /** Whether schema changes were detected */
  SCHEMA_CHANGES_DETECTED: "de.sql.schema_changes_detected",
  /** Details of schema changes (JSON) */
  SCHEMA_CHANGES_DETAILS: "de.sql.schema_changes_details",
} as const

// ---------------------------------------------------------------------------
// dbt operations (Layer 3)
// ---------------------------------------------------------------------------

export const DE_DBT = {
  /** dbt command: run, test, build, compile, seed, snapshot */
  COMMAND: "de.dbt.command",
  /** Model unique_id (e.g., model.my_project.stg_orders) */
  MODEL_UNIQUE_ID: "de.dbt.model.unique_id",
  /** Model short name */
  MODEL_NAME: "de.dbt.model.name",
  /** Materialization: table, view, incremental, ephemeral */
  MODEL_MATERIALIZATION: "de.dbt.model.materialization",
  /** Target schema */
  MODEL_SCHEMA: "de.dbt.model.schema",
  /** Target database */
  MODEL_DATABASE: "de.dbt.model.database",
  /** Execution status: success, error, skipped */
  MODEL_STATUS: "de.dbt.model.status",
  /** Execution time in seconds */
  MODEL_EXECUTION_TIME: "de.dbt.model.execution_time_s",
  /** Compilation time in seconds */
  MODEL_COMPILE_TIME: "de.dbt.model.compile_time_s",
  /** Rows affected by the model */
  MODEL_ROWS_AFFECTED: "de.dbt.model.rows_affected",
  /** Bytes processed */
  MODEL_BYTES_PROCESSED: "de.dbt.model.bytes_processed",
  /** Compiled SQL after Jinja rendering (opt-in, can be large) */
  MODEL_COMPILED_SQL: "de.dbt.model.compiled_sql",
  /** Error message if compilation/execution failed */
  MODEL_ERROR: "de.dbt.model.error",
  /** Test unique_id */
  TEST_UNIQUE_ID: "de.dbt.test.unique_id",
  /** Test short name */
  TEST_NAME: "de.dbt.test.name",
  /** Test status: pass, fail, warn, error */
  TEST_STATUS: "de.dbt.test.status",
  /** Number of test failures */
  TEST_FAILURES: "de.dbt.test.failures_count",
  /** Test execution time in seconds */
  TEST_EXECUTION_TIME: "de.dbt.test.execution_time_s",
  /** Source name for freshness check */
  SOURCE_NAME: "de.dbt.source.name",
  /** Freshness status: pass, warn, error */
  SOURCE_FRESHNESS_STATUS: "de.dbt.source.freshness_status",
  /** Max loaded_at timestamp from source */
  SOURCE_MAX_LOADED_AT: "de.dbt.source.max_loaded_at",
  /** Number of nodes selected in the DAG */
  DAG_NODES_SELECTED: "de.dbt.dag.nodes_selected",
  /** Number of nodes actually executed */
  DAG_NODES_EXECUTED: "de.dbt.dag.nodes_executed",
  /** Number of nodes skipped */
  DAG_NODES_SKIPPED: "de.dbt.dag.nodes_skipped",
  /** Whether Jinja rendering succeeded */
  JINJA_RENDER_SUCCESS: "de.dbt.jinja.render_success",
  /** Jinja rendering error message */
  JINJA_ERROR: "de.dbt.jinja.error",
} as const

// ---------------------------------------------------------------------------
// Data quality (Layer 4)
// ---------------------------------------------------------------------------

export const DE_QUALITY = {
  /** Row count of the result/table */
  ROW_COUNT: "de.quality.row_count",
  /** Change in row count from previous run */
  ROW_COUNT_DELTA: "de.quality.row_count_delta",
  /** Null percentage for critical columns (0.0-1.0) */
  NULL_PERCENTAGE: "de.quality.null_percentage",
  /** Uniqueness ratio (0.0-1.0, 1.0 = all unique) */
  UNIQUENESS_RATIO: "de.quality.uniqueness_ratio",
  /** Data freshness in hours */
  FRESHNESS_HOURS: "de.quality.freshness_hours",
  /** Whether schema drift was detected */
  SCHEMA_DRIFT: "de.quality.schema_drift_detected",
  /** Number of quality tests that passed */
  TESTS_PASSED: "de.quality.tests_passed",
  /** Number of quality tests that failed */
  TESTS_FAILED: "de.quality.tests_failed",
  /** Whether an anomaly was detected */
  ANOMALY_DETECTED: "de.quality.anomaly_detected",
  /** Type of anomaly: volume, freshness, distribution, schema */
  ANOMALY_TYPE: "de.quality.anomaly_type",
} as const

// ---------------------------------------------------------------------------
// Cost attribution (Layer 5)
// ---------------------------------------------------------------------------

export const DE_COST = {
  /** LLM input token cost in USD */
  LLM_INPUT_USD: "de.cost.llm_input_usd",
  /** LLM output token cost in USD */
  LLM_OUTPUT_USD: "de.cost.llm_output_usd",
  /** Total LLM cost in USD */
  LLM_TOTAL_USD: "de.cost.llm_total_usd",
  /** Warehouse compute cost in USD triggered by this operation */
  WAREHOUSE_COMPUTE_USD: "de.cost.warehouse_compute_usd",
  /** Storage cost delta from materializations */
  STORAGE_DELTA_USD: "de.cost.storage_delta_usd",
  /** Total cost across all categories */
  TOTAL_USD: "de.cost.total_usd",
  /** Cost attribution: user */
  ATTRIBUTION_USER: "de.cost.attribution.user",
  /** Cost attribution: team */
  ATTRIBUTION_TEAM: "de.cost.attribution.team",
  /** Cost attribution: project */
  ATTRIBUTION_PROJECT: "de.cost.attribution.project",
} as const

// ---------------------------------------------------------------------------
// Convenience namespace
// ---------------------------------------------------------------------------

/** All DE attribute key constants, organized by domain. */
export const DE = {
  WAREHOUSE: DE_WAREHOUSE,
  SQL: DE_SQL,
  DBT: DE_DBT,
  QUALITY: DE_QUALITY,
  COST: DE_COST,
} as const
