// Re-export types
export type { Connector, ConnectorResult, SchemaColumn, ConnectionConfig } from "./types"

// Re-export config normalization
export { normalizeConfig, sanitizeConnectionString } from "./normalize"

// Re-export interactive sign-in notices
export { onBrowserSignIn, redactSignInUrl } from "./sign-in"
export type { BrowserSignInNotice } from "./sign-in"

// Re-export reconnect events (a closed session reopened by the driver)
export { onReconnect } from "./reconnect-events"
export type { ReconnectEvent } from "./reconnect-events"

// Re-export file-backed store guards
export { allowsCreate, assertStoreExists, isLocalFilePath, requireStorePath } from "./file-store"

// Re-export driver connect functions
export { connect as connectPostgres } from "./postgres"
export { connect as connectSnowflake } from "./snowflake"
export { connect as connectBigquery } from "./bigquery"
export { connect as connectDatabricks } from "./databricks"
export { connect as connectRedshift } from "./redshift"
export { connect as connectMysql } from "./mysql"
export { connect as connectSqlserver } from "./sqlserver"
export { connect as connectOracle } from "./oracle"
export { connect as connectDuckdb } from "./duckdb"
export { connect as connectSqlite } from "./sqlite"
export { connect as connectMongodb } from "./mongodb"
export { connect as connectClickhouse } from "./clickhouse"
export { connect as connectTrino } from "./trino"
