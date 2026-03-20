/**
 * Schema cache — indexes warehouse metadata into SQLite for fast search.
 *
 * Uses bun:sqlite (built into the Bun runtime) to build a local FTS-ready
 * cache of warehouse schemas, tables, and columns.
 * Cache location: ~/.altimate-code/schema-cache.db
 */

import { Database } from "bun:sqlite"
import * as path from "path"
import * as os from "os"
import * as fs from "fs"
import type { Connector } from "@altimateai/drivers"
import type {
  SchemaIndexResult,
  SchemaSearchResult,
  SchemaCacheStatusResult,
  SchemaCacheWarehouseStatus,
  SchemaSearchTableResult,
  SchemaSearchColumnResult,
} from "../types"

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS warehouses (
    name TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    last_indexed TEXT,
    databases_count INTEGER DEFAULT 0,
    schemas_count INTEGER DEFAULT 0,
    tables_count INTEGER DEFAULT 0,
    columns_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tables_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    warehouse TEXT NOT NULL,
    database_name TEXT,
    schema_name TEXT NOT NULL,
    table_name TEXT NOT NULL,
    table_type TEXT DEFAULT 'TABLE',
    row_count INTEGER,
    comment TEXT,
    search_text TEXT NOT NULL,
    UNIQUE(warehouse, database_name, schema_name, table_name)
);

CREATE TABLE IF NOT EXISTS columns_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    warehouse TEXT NOT NULL,
    database_name TEXT,
    schema_name TEXT NOT NULL,
    table_name TEXT NOT NULL,
    column_name TEXT NOT NULL,
    data_type TEXT,
    nullable INTEGER DEFAULT 1,
    comment TEXT,
    search_text TEXT NOT NULL,
    UNIQUE(warehouse, database_name, schema_name, table_name, column_name)
);

CREATE INDEX IF NOT EXISTS idx_tables_search ON tables_cache(search_text);
CREATE INDEX IF NOT EXISTS idx_columns_search ON columns_cache(search_text);
CREATE INDEX IF NOT EXISTS idx_tables_warehouse ON tables_cache(warehouse);
CREATE INDEX IF NOT EXISTS idx_columns_warehouse ON columns_cache(warehouse);
CREATE INDEX IF NOT EXISTS idx_columns_table ON columns_cache(warehouse, schema_name, table_name, column_name);
`

// ---------------------------------------------------------------------------
// Stop words for search tokenization
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "the", "a", "an", "in", "on", "at", "to", "for", "of", "with",
  "about", "from", "that", "which", "where", "what", "how",
  "find", "show", "get", "list", "all", "any",
])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultCachePath(): string {
  const dir = path.join(os.homedir(), ".altimate-code")
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return path.join(dir, "schema-cache.db")
}

function makeSearchText(...parts: (string | null | undefined)[]): string {
  const tokens: string[] = []
  for (const p of parts) {
    if (p) {
      tokens.push(p.toLowerCase())
      if (p.includes("_")) {
        tokens.push(...p.toLowerCase().split("_"))
      }
    }
  }
  return tokens.join(" ")
}

function tokenizeQuery(query: string): string[] {
  const rawTokens = query.toLowerCase().match(/[a-zA-Z0-9_]+/g) || []
  const filtered = rawTokens.filter((t) => !STOP_WORDS.has(t))
  return filtered.length > 0 ? filtered : rawTokens.slice(0, 1)
}

// ---------------------------------------------------------------------------
// SchemaCache class
// ---------------------------------------------------------------------------

/** SQLite-backed schema metadata cache for fast warehouse search. */
export class SchemaCache {
  private db: Database
  private dbPath: string

  private constructor(db: Database, dbPath: string) {
    this.db = db
    this.dbPath = dbPath
  }

  /** Create a SchemaCache instance backed by a file on disk. */
  static create(dbPath?: string): SchemaCache {
    const resolvedPath = dbPath || defaultCachePath()
    const db = new Database(resolvedPath, { create: true })
    db.exec(CREATE_TABLES_SQL)
    return new SchemaCache(db, resolvedPath)
  }

  /** Create a SchemaCache with an in-memory database (for testing). */
  static createInMemory(): SchemaCache {
    const db = new Database(":memory:")
    db.exec(CREATE_TABLES_SQL)
    return new SchemaCache(db, ":memory:")
  }

  /**
   * Crawl a warehouse and index all schemas/tables/columns.
   */
  async indexWarehouse(
    warehouseName: string,
    warehouseType: string,
    connector: Connector,
  ): Promise<SchemaIndexResult> {
    const now = new Date().toISOString()

    // Clear existing data
    this.db.prepare("DELETE FROM columns_cache WHERE warehouse = ?").run(warehouseName)
    this.db.prepare("DELETE FROM tables_cache WHERE warehouse = ?").run(warehouseName)

    let totalSchemas = 0
    let totalTables = 0
    let totalColumns = 0
    const databaseName: string | null = null

    let schemas: string[] = []
    try {
      schemas = await connector.listSchemas()
    } catch {
      // ignore
    }

    const insertTable = this.db.prepare(
      `INSERT OR REPLACE INTO tables_cache
       (warehouse, database_name, schema_name, table_name, table_type, search_text)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )

    const insertColumn = this.db.prepare(
      `INSERT OR REPLACE INTO columns_cache
       (warehouse, database_name, schema_name, table_name, column_name, data_type, nullable, search_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )

    // Batch inserts per-table inside a transaction to avoid per-statement disk fsyncs.
    // The async connector calls (listTables, describeTable) run outside the transaction;
    // only the synchronous SQLite inserts are wrapped.
    const insertTableBatch = this.db.transaction(
      (tableArgs: any[], columnArgsBatch: any[][]) => {
        insertTable.run(...tableArgs)
        for (const colArgs of columnArgsBatch) {
          insertColumn.run(...colArgs)
        }
      },
    )

    for (const schemaName of schemas) {
      if (schemaName.toUpperCase() === "INFORMATION_SCHEMA") continue
      totalSchemas++

      let tables: Array<{ name: string; type: string }> = []
      try {
        tables = await connector.listTables(schemaName)
      } catch {
        continue
      }

      for (const tableInfo of tables) {
        totalTables++
        const searchText = makeSearchText(databaseName, schemaName, tableInfo.name, tableInfo.type)

        let columns: Array<{ name: string; data_type: string; nullable: boolean }> = []
        try {
          columns = await connector.describeTable(schemaName, tableInfo.name)
        } catch {
          // continue with empty columns
        }

        // Build column insert args
        const columnArgsBatch: any[][] = []
        for (const col of columns) {
          totalColumns++
          const colSearch = makeSearchText(
            databaseName, schemaName, tableInfo.name, col.name, col.data_type,
          )
          columnArgsBatch.push([
            warehouseName, databaseName, schemaName, tableInfo.name,
            col.name, col.data_type, col.nullable ? 1 : 0, colSearch,
          ])
        }

        // Insert table + all its columns in a single transaction
        insertTableBatch(
          [warehouseName, databaseName, schemaName, tableInfo.name, tableInfo.type, searchText],
          columnArgsBatch,
        )
      }
    }

    // Update warehouse summary
    this.db.prepare(
      `INSERT OR REPLACE INTO warehouses
       (name, type, last_indexed, databases_count, schemas_count, tables_count, columns_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      warehouseName, warehouseType, now,
      databaseName ? 1 : 0, totalSchemas, totalTables, totalColumns,
    )

    return {
      warehouse: warehouseName,
      type: warehouseType,
      schemas_indexed: totalSchemas,
      tables_indexed: totalTables,
      columns_indexed: totalColumns,
      timestamp: now,
    }
  }

  /**
   * Search indexed schema metadata using natural language-style queries.
   */
  search(
    query: string,
    warehouse?: string,
    limit: number = 20,
  ): SchemaSearchResult {
    const tokens = tokenizeQuery(query)
    if (tokens.length === 0) {
      return { tables: [], columns: [], query, match_count: 0 }
    }

    const whereClauses = tokens.map(() => "search_text LIKE ?")
    const searchParams = tokens.map((t) => `%${t}%`)
    const searchCondition = whereClauses.join(" OR ")

    const whFilter = warehouse ? " AND warehouse = ?" : ""
    const whParams = warehouse ? [warehouse] : []

    // Search tables
    const tableRows = this.db.prepare(
      `SELECT warehouse, database_name, schema_name, table_name, table_type, row_count
       FROM tables_cache
       WHERE ${searchCondition} ${whFilter}
       ORDER BY table_name
       LIMIT ?`,
    ).all(...searchParams, ...whParams, limit) as any[]

    const tables: SchemaSearchTableResult[] = tableRows.map((row) => {
      const fqnParts = [row.database_name, row.schema_name, row.table_name].filter(Boolean)
      return {
        warehouse: row.warehouse,
        database: row.database_name ?? undefined,
        schema_name: row.schema_name,
        name: row.table_name,
        type: row.table_type,
        row_count: row.row_count ?? undefined,
        fqn: fqnParts.join("."),
      }
    })

    // Search columns
    const colRows = this.db.prepare(
      `SELECT warehouse, database_name, schema_name, table_name, column_name, data_type, nullable
       FROM columns_cache
       WHERE ${searchCondition} ${whFilter}
       ORDER BY column_name
       LIMIT ?`,
    ).all(...searchParams, ...whParams, limit) as any[]

    const columns: SchemaSearchColumnResult[] = colRows.map((row) => {
      const fqnParts = [row.database_name, row.schema_name, row.table_name, row.column_name].filter(Boolean)
      return {
        warehouse: row.warehouse,
        database: row.database_name ?? undefined,
        schema_name: row.schema_name,
        table: row.table_name,
        name: row.column_name,
        data_type: row.data_type ?? undefined,
        nullable: Boolean(row.nullable),
        fqn: fqnParts.join("."),
      }
    })

    return {
      tables,
      columns,
      query,
      match_count: tables.length + columns.length,
    }
  }

  /**
   * Return status of all indexed warehouses.
   */
  cacheStatus(): SchemaCacheStatusResult {
    const rows = this.db.prepare("SELECT * FROM warehouses ORDER BY name").all() as any[]
    const warehouses: SchemaCacheWarehouseStatus[] = rows.map((row) => ({
      name: row.name,
      type: row.type,
      last_indexed: row.last_indexed ?? undefined,
      databases_count: row.databases_count,
      schemas_count: row.schemas_count,
      tables_count: row.tables_count,
      columns_count: row.columns_count,
    }))

    const totalTables = (this.db.prepare("SELECT COUNT(*) as cnt FROM tables_cache").get() as any).cnt
    const totalColumns = (this.db.prepare("SELECT COUNT(*) as cnt FROM columns_cache").get() as any).cnt

    return {
      warehouses,
      total_tables: totalTables,
      total_columns: totalColumns,
      cache_path: this.dbPath,
    }
  }

  /**
   * List all columns for a given warehouse (no search filter).
   * Used by PII detection to scan all cached columns.
   */
  listColumns(
    warehouse: string,
    limit: number = 10000,
  ): SchemaSearchColumnResult[] {
    const rows = this.db.prepare(
      `SELECT warehouse, database_name, schema_name, table_name, column_name, data_type, nullable
       FROM columns_cache
       WHERE warehouse = ?
       ORDER BY schema_name, table_name, column_name
       LIMIT ?`,
    ).all(warehouse, limit) as any[]

    return rows.map((row) => {
      const fqnParts = [row.database_name, row.schema_name, row.table_name, row.column_name].filter(Boolean)
      return {
        warehouse: row.warehouse,
        database: row.database_name ?? undefined,
        schema_name: row.schema_name,
        table: row.table_name,
        name: row.column_name,
        data_type: row.data_type ?? undefined,
        nullable: Boolean(row.nullable),
        fqn: fqnParts.join("."),
      }
    })
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      // ignore
    }
  }
}

// Singleton cache instance (lazy)
let _cache: SchemaCache | null = null

export async function getCache(): Promise<SchemaCache> {
  if (!_cache) {
    _cache = SchemaCache.create()
  }
  return _cache
}

export function resetCache(): void {
  if (_cache) {
    _cache.close()
    _cache = null
  }
}
