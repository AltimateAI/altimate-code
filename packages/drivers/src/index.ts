// Re-export types
export type { Connector, ConnectorResult, SchemaColumn, ConnectionConfig } from "./types"

// Re-export config normalization
export { normalizeConfig, sanitizeConnectionString } from "./normalize"

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
