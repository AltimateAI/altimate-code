// altimate_change - new file
//
// Shared fixtures for the workspace precedence suites. Extracted because
// `bindTo`'s `attachOutcome` shape is coupled to the attach module's SERVING
// allowlist: two hand-maintained copies break differently when that changes, and the
// one that is not updated goes on asserting against an outcome the code no longer
// produces. Same for the engine tool maps — they encode which capabilities each
// integration really materialises, which is the fact the whole module turns on.
import { precedenceInternals } from "../../../src/altimate/workspace/precedence"

/** The engine tools a workspace with a Snowflake connection materialises. Snowflake
 * is the only integration serving all three capabilities. */
export const SNOWFLAKE_TOOLS = {
  datamate_snowflake_execute_database_query: {},
  datamate_snowflake_get_query_explain_plan: {},
  datamate_snowflake_get_table_stats: {},
  datamate_snowflake_list_database_connections: {},
}

/** BigQuery and postgresql ship execute + list only — no explain, no table stats. */
export const BIGQUERY_TOOLS = {
  datamate_bigquery_execute_database_query: {},
  datamate_bigquery_list_database_connections: {},
}

/** Real local connections. Without them a served/local assertion would pass simply
 * because the connection is unknown, proving nothing. Includes the engine-less types
 * (duckdb, redshift) deliberately — they are the over-steering control. */
export const WAREHOUSE_CONFIGS = {
  local_snow: { type: "snowflake", account: "acct", user: "u" } as never,
  local_duck: { type: "duckdb", path: ":memory:" } as never,
  bq_conn: { type: "bigquery", project: "p" } as never,
  pg_conn: { type: "postgresql", host: "h" } as never,
  rs_conn: { type: "redshift", host: "h" } as never,
}

/** The `analyst` shape: permitted the native reads, denies everything it does not
 * name — so it can never reach a `datamate_*` key. */
export const ANALYST_RULESET = [
  { permission: "*", pattern: "*", action: "deny" as const },
  { permission: "sql_execute", pattern: "*", action: "allow" as const },
  { permission: "sql_explain", pattern: "*", action: "allow" as const },
  { permission: "schema_inspect", pattern: "*", action: "allow" as const },
]

export function bindTo(id = 42, name = "analytics") {
  precedenceInternals.binding = async () => ({ datamateId: id, datamateName: name })
  precedenceInternals.attributedTo = async () => String(id)
  precedenceInternals.attachOutcome = async () => ({ kind: "attached", available: 12, declared: 12, missing: [] })
}
