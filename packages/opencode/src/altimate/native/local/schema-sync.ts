/**
 * Sync remote warehouse schema to local DuckDB for offline testing.
 *
 * Ported from Python altimate_engine.local.schema_sync.
 */

import * as Registry from "../connections/registry"
import type {
  LocalSchemaSyncParams,
  LocalSchemaSyncResult,
} from "../types"

// ---------------------------------------------------------------------------
// Type mapping: remote types → DuckDB types
// ---------------------------------------------------------------------------

const TYPE_MAP: Record<string, string> = {
  INT: "INTEGER",
  INT4: "INTEGER",
  INT8: "BIGINT",
  BIGINT: "BIGINT",
  SMALLINT: "SMALLINT",
  TINYINT: "TINYINT",
  INTEGER: "INTEGER",
  FLOAT: "FLOAT",
  FLOAT4: "FLOAT",
  FLOAT8: "DOUBLE",
  DOUBLE: "DOUBLE",
  REAL: "FLOAT",
  DECIMAL: "DECIMAL",
  NUMERIC: "DECIMAL",
  NUMBER: "DECIMAL",
  BOOLEAN: "BOOLEAN",
  BOOL: "BOOLEAN",
  VARCHAR: "VARCHAR",
  CHAR: "VARCHAR",
  TEXT: "VARCHAR",
  STRING: "VARCHAR",
  NVARCHAR: "VARCHAR",
  NCHAR: "VARCHAR",
  DATE: "DATE",
  DATETIME: "TIMESTAMP",
  TIMESTAMP: "TIMESTAMP",
  TIMESTAMP_NTZ: "TIMESTAMP",
  TIMESTAMP_LTZ: "TIMESTAMPTZ",
  TIMESTAMP_TZ: "TIMESTAMPTZ",
  TIMESTAMPTZ: "TIMESTAMPTZ",
  TIME: "TIME",
  BINARY: "BLOB",
  VARBINARY: "BLOB",
  BLOB: "BLOB",
  BYTES: "BLOB",
  VARIANT: "JSON",
  OBJECT: "JSON",
  ARRAY: "JSON",
  JSON: "JSON",
  STRUCT: "JSON",
  MAP: "JSON",
  GEOGRAPHY: "VARCHAR",
  GEOMETRY: "VARCHAR",
  UUID: "UUID",
}

function mapType(remoteType: string): string {
  const rt = remoteType.toUpperCase().split("(")[0].trim()
  return TYPE_MAP[rt] || "VARCHAR"
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sync remote warehouse schema to a local DuckDB database.
 *
 * Creates empty stub tables matching the remote schema structure.
 */
export async function syncSchema(params: LocalSchemaSyncParams): Promise<LocalSchemaSyncResult> {
  const targetPath = params.target_path || ":memory:"
  const sampleRows = params.sample_rows || 0

  let remote
  try {
    remote = await Registry.get(params.warehouse)
  } catch {
    return {
      success: false,
      error: `Connection '${params.warehouse}' not found.`,
      tables_synced: 0,
      columns_synced: 0,
      schemas_synced: 0,
    }
  }

  // Dynamic import of DuckDB driver
  let localConnector: any
  try {
    const duckdbDriver = await import("@altimateai/drivers/duckdb")
    localConnector = await duckdbDriver.connect({ type: "duckdb", path: targetPath })
    await localConnector.connect()
  } catch {
    return {
      success: false,
      error: "DuckDB driver not available. Ensure duckdb is installed.",
      tables_synced: 0,
      columns_synced: 0,
      schemas_synced: 0,
    }
  }

  try {
    // Create metadata schema
    await localConnector.execute("CREATE SCHEMA IF NOT EXISTS _altimate_meta")

    // Get schemas to sync
    let targetSchemas: string[]
    if (params.schemas && params.schemas.length > 0) {
      targetSchemas = params.schemas
    } else {
      targetSchemas = await remote.listSchemas()
    }

    let tablesSynced = 0
    let columnsSynced = 0
    let tableCount = 0
    const errors: string[] = []

    for (const schemaName of targetSchemas) {
      try {
        await localConnector.execute(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`)
      } catch (e) {
        errors.push(`Failed to create schema ${schemaName}: ${e}`)
        continue
      }

      let tables: Array<{ name: string; type: string }>
      try {
        tables = await remote.listTables(schemaName)
      } catch (e) {
        errors.push(`Failed to list tables in ${schemaName}: ${e}`)
        continue
      }

      for (const tableInfo of tables) {
        if (params.limit !== undefined && tableCount >= params.limit) break

        let columns: Array<{ name: string; data_type: string; nullable: boolean }>
        try {
          columns = await remote.describeTable(schemaName, tableInfo.name)
        } catch (e) {
          errors.push(`Failed to describe ${schemaName}.${tableInfo.name}: ${e}`)
          continue
        }

        if (columns.length === 0) continue

        const colDefs = columns.map((col) => {
          const duckdbType = mapType(col.data_type)
          const nullable = col.nullable ? "" : " NOT NULL"
          return `"${col.name}" ${duckdbType}${nullable}`
        })

        const createSql = `CREATE TABLE IF NOT EXISTS "${schemaName}"."${tableInfo.name}" (${colDefs.join(", ")})`

        try {
          await localConnector.execute(createSql)
          tablesSynced++
          columnsSynced += columns.length
          tableCount++
        } catch (e) {
          errors.push(`Failed to create ${schemaName}.${tableInfo.name}: ${e}`)
        }
      }

      if (params.limit !== undefined && tableCount >= params.limit) break
    }

    // Record sync metadata
    try {
      await localConnector.execute(
        "CREATE TABLE IF NOT EXISTS _altimate_meta.sync_log (" +
        "warehouse VARCHAR, synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, " +
        "tables_synced INTEGER, columns_synced INTEGER)",
      )
      const { escapeSqlString } = await import("@altimateai/drivers")
      await localConnector.execute(
        `INSERT INTO _altimate_meta.sync_log (warehouse, tables_synced, columns_synced) ` +
        `VALUES ('${escapeSqlString(params.warehouse)}', ${Number(tablesSynced)}, ${Number(columnsSynced)})`,
      )
    } catch {
      // Non-fatal
    }

    return {
      success: true,
      warehouse: params.warehouse,
      target_path: targetPath,
      tables_synced: tablesSynced,
      columns_synced: columnsSynced,
      schemas_synced: targetSchemas.length,
      errors: errors.length > 0 ? errors : undefined,
    }
  } catch (e) {
    return {
      success: false,
      error: String(e),
      tables_synced: 0,
      columns_synced: 0,
      schemas_synced: 0,
    }
  } finally {
    try { await localConnector.close() } catch { /* ignore */ }
  }
}

// Exported for testing
export { mapType }
