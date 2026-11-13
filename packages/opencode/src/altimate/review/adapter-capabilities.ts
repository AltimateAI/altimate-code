/**
 * Per-adapter behavior that review rules depend on. A rule whose correctness
 * differs by engine reads this table instead of hard-coding one engine, so it
 * fires where the behavior is real and stays silent elsewhere. Every entry
 * cites the engine's documentation. An adapter missing from the table gets the
 * generic (engine-agnostic) form of each rule only.
 *
 * Keys are the review's dialect names (see run.ts `ADAPTER_DIALECT`).
 */

export interface AdapterCapability {
  /** `int / int` returns an integer, dropping the fraction (7 / 2 = 3). */
  integerDivisionTruncates: boolean
  /**
   * Concurrent commits to one table conflict (Iceberg optimistic concurrency
   * with no retry in the adapter), so parallel microbatch batches and
   * overlapping backfills fail. Undefined = not established for this adapter.
   */
  concurrentCommitsConflict?: boolean
  /**
   * A `table` model with an enforced contract and `on_table_exists='replace'`
   * is replaced atomically. False = `create or replace` then `insert` as two
   * statements (readers see an empty table), and `on_table_exists='drop'`
   * leaves no table during the build. Undefined = not established.
   */
  contractTableReplaceAtomic?: boolean
  /** Documentation backing the entries above. */
  sources: string[]
}

export const ADAPTER_CAPABILITIES: Record<string, AdapterCapability> = {
  postgres: {
    integerDivisionTruncates: true,
    sources: ["https://www.postgresql.org/docs/current/functions-math.html"],
  },
  redshift: {
    integerDivisionTruncates: true,
    sources: ["https://docs.aws.amazon.com/redshift/latest/dg/r_numeric_computations201.html"],
  },
  trino: {
    integerDivisionTruncates: true,
    concurrentCommitsConflict: true,
    contractTableReplaceAtomic: false,
    sources: [
      "https://trino.io/docs/current/functions/math.html",
      "https://iceberg.apache.org/docs/latest/reliability/#concurrent-write-operations",
      // dbt-trino declares MicrobatchConcurrency: Full, so batches run in parallel by default.
      "https://github.com/starburstdata/dbt-trino/blob/master/dbt/adapters/trino/impl.py",
      // create_table_as with an enforced contract: `create or replace table` then `insert`;
      // on_table_exists='drop' drops the table before building it.
      "https://github.com/starburstdata/dbt-trino/blob/master/dbt/include/trino/macros/adapters.sql",
      "https://github.com/starburstdata/dbt-trino/blob/master/dbt/include/trino/macros/materializations/table.sql",
    ],
  },
  athena: {
    // Athena SQL runs on Trino; dbt-athena writes Iceberg tables with the same commit model.
    integerDivisionTruncates: true,
    concurrentCommitsConflict: true,
    sources: [
      "https://trino.io/docs/current/functions/math.html",
      "https://iceberg.apache.org/docs/latest/reliability/#concurrent-write-operations",
    ],
  },
  tsql: {
    integerDivisionTruncates: true,
    sources: ["https://learn.microsoft.com/en-us/sql/t-sql/language-elements/divide-transact-sql"],
  },
  fabric: {
    integerDivisionTruncates: true,
    sources: ["https://learn.microsoft.com/en-us/sql/t-sql/language-elements/divide-transact-sql"],
  },
  snowflake: {
    integerDivisionTruncates: false,
    sources: ["https://docs.snowflake.com/en/sql-reference/operators-arithmetic"],
  },
  bigquery: {
    integerDivisionTruncates: false,
    sources: ["https://cloud.google.com/bigquery/docs/reference/standard-sql/operators#arithmetic_operators"],
  },
  databricks: {
    integerDivisionTruncates: false,
    sources: ["https://docs.databricks.com/en/sql/language-manual/functions/slashsign.html"],
  },
  duckdb: {
    integerDivisionTruncates: false,
    sources: ["https://duckdb.org/docs/sql/functions/numeric"],
  },
  mysql: {
    integerDivisionTruncates: false,
    sources: ["https://dev.mysql.com/doc/refman/8.0/en/arithmetic-functions.html"],
  },
  oracle: {
    integerDivisionTruncates: false,
    sources: ["https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Arithmetic-Operators.html"],
  },
  clickhouse: {
    integerDivisionTruncates: false,
    sources: ["https://clickhouse.com/docs/en/sql-reference/functions/arithmetic-functions"],
  },
}

export function capabilityFor(dialect: string | undefined): AdapterCapability | undefined {
  return dialect ? ADAPTER_CAPABILITIES[dialect.toLowerCase()] : undefined
}

/** Display names of the engines where `int / int` truncates. */
export const TRUNCATING_DIVISION_ENGINES = "Postgres, Redshift, Trino/Athena and SQL Server"
