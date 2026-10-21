import { absoluteFileUriPath, isLocalFilePath } from "@altimateai/drivers/file-store"
import type { ConnectionConfig } from "@altimateai/drivers/types"
import { Dispatcher } from "../native"
import * as Registry from "../native/connections/registry"
import { isScratch } from "../native/connections/scratch"
import { executeQuery } from "../native/query-execution"

/**
 * One-call catalog discovery for warehouse_list: tables with columns and a one-row sample, so a
 * client can start querying without separate schema_inspect round trips.
 *
 * Bounded by the data before any work: local engines only (remote warehouses run no queries here),
 * table/column/sample budgets shared across connections, one overall deadline checked before every
 * call (each call also has its own query timeout), and a byte cap on the rendered text. Samples run
 * only on SQLite and local DuckDB base tables, whose drivers enforce read-only at the database.
 */
const MAX_CONNECTIONS = 8
const MAX_SCHEMAS = 10
const TABLE_BUDGET = 40
const COLUMN_BUDGET = 30
const SAMPLE_BUDGET = 15
const MAX_COLUMNS_SHOWN = 40
const SAMPLE_CELL_CHARS = 40
const OUTPUT_BYTES = 8 * 1024
const NOTICE_RESERVE_BYTES = 256
const DEADLINE_MS = 4_000
const SAMPLE_TIMEOUT_MS = 1_000
const MONGO_SYSTEM_DATABASES = new Set(["admin", "config", "local"])
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])
const SAMPLED_ENGINES = new Set(["sqlite", "duckdb"])

interface DiscoveryContext {
  signal: AbortSignal
  sessionID: string
}

type Table = { schema: string; name: string; type: string; row_count?: number; row_count_estimated?: boolean }

/** Data on this machine: a local SQLite/DuckDB file (or memory), or a server on a loopback host or socket. */
export function isLocalConnection(config: ConnectionConfig | undefined): boolean {
  if (!config) return false
  const type = Registry.canonicalType(config.type) ?? ""
  if (type === "sqlite" || type === "duckdb") {
    const store = typeof config.path === "string" ? config.path : ""
    return store === ":memory:" || (store !== "" && (isLocalFilePath(store) || absoluteFileUriPath(store) !== undefined))
  }
  if (!["postgres", "mysql", "mongodb"].includes(type)) return false
  const url = [config.connection_string, config.uri, config.url].find((value) => typeof value === "string" && value)
  if (typeof url === "string") {
    try {
      const host = new URL(url).hostname
      return LOCAL_HOSTS.has(host.toLowerCase())
    } catch {
      return false
    }
  }
  const host = typeof config.host === "string" ? config.host.trim().toLowerCase() : ""
  // An absolute host path is a Unix socket on this machine.
  return LOCAL_HOSTS.has(host) || host.startsWith("/")
}

function rowsLabel(table: Table): string {
  if (table.row_count === undefined) return ""
  return ` (${table.row_count_estimated ? "~" : ""}${table.row_count} rows)`
}

function sampleCell(value: unknown): string {
  const text =
    value === null || value === undefined
      ? "NULL"
      : value instanceof Date
        ? value.toISOString()
        : typeof value === "object"
          ? (JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item)) ?? String(value))
          : String(value)
  const flat = text.replace(/\s+/g, " ")
  return flat.length > SAMPLE_CELL_CHARS ? `${flat.slice(0, SAMPLE_CELL_CHARS)}…` : flat
}

const quoteIdent = (id: string) => `"${id.replace(/"/g, '""')}"`

/** Renders local connections' tables; returns "" when nothing is discoverable. */
export async function discoverCatalog(warehouses: { name: string; type: string }[], context: DiscoveryContext): Promise<string> {
  const deadline = Date.now() + DEADLINE_MS
  const budget = { tables: TABLE_BUDGET, columns: COLUMN_BUDGET, samples: SAMPLE_BUDGET }
  const lines: string[] = []
  let bytes = 0
  let full = false
  let skipped = 0
  const push = (line: string) => {
    const size = Buffer.byteLength(line, "utf8") + 1
    // The two trailing notices are pushed unconditionally; keep room for them inside the cap.
    if (full || bytes + size > OUTPUT_BYTES - NOTICE_RESERVE_BYTES) {
      full = true
      return false
    }
    lines.push(line)
    bytes += size
    return true
  }
  const timeLeft = () => deadline - Date.now()
  let remote = 0
  for (const warehouse of warehouses.slice(0, MAX_CONNECTIONS)) {
    if (isScratch(warehouse.name)) continue
    const config = Registry.getConfig(warehouse.name)
    if (!isLocalConnection(config)) {
      remote++
      continue
    }
    if (full || timeLeft() <= 0) {
      skipped++
      continue
    }
    context.signal.throwIfAborted()
    const type = Registry.canonicalType(config?.type) ?? ""
    try {
      const tables = await listTables(warehouse.name, type, budget, context, timeLeft)
      if (!tables) {
        push(`${warehouse.name}: catalog too large to list here; use schema_inspect.`)
        continue
      }
      if (!tables.length) {
        push(`${warehouse.name}: no tables.`)
        continue
      }
      for (const table of tables) {
        if (full) break
        let line = `${warehouse.name}: ${table.schema}.${table.name}${rowsLabel(table)}`
        let names: string[] | undefined
        if (budget.columns > 0 && timeLeft() > 0) {
          budget.columns--
          context.signal.throwIfAborted()
          const inspected = await Dispatcher.call("schema.inspect", {
            table: table.name,
            schema_name: table.schema,
            warehouse: warehouse.name,
          }).catch(() => {
            context.signal.throwIfAborted()
            return undefined
          })
          const columns = inspected?.columns ?? []
          if (columns.length) {
            names = columns.map((column) => column.name)
            const shown = columns.slice(0, MAX_COLUMNS_SHOWN).map((column) => `${column.name} ${column.data_type}`)
            line += `: ${shown.join(", ")}${columns.length > shown.length ? `, +${columns.length - shown.length} more` : ""}`
          }
        }
        if (!push(line)) break
        if (names && SAMPLED_ENGINES.has(type) && table.type === "table" && budget.samples > 0 && timeLeft() > 0) {
          budget.samples--
          const sample = await sampleRow(warehouse.name, config!, table, names.length, context, timeLeft).catch(() => {
            context.signal.throwIfAborted()
            return undefined
          })
          if (sample) push(`  e.g. ${sample}`)
        }
      }
    } catch {
      context.signal.throwIfAborted()
      push(`${warehouse.name}: catalog unavailable here; use schema_inspect.`)
    }
  }
  const omitted = Math.max(0, warehouses.length - MAX_CONNECTIONS)
  if (full || skipped || omitted || timeLeft() <= 0) {
    lines.push("More tables or connections exist than shown; use schema_inspect for the rest.")
  }
  if (remote && lines.length) lines.push("Remote connections are not listed here; use schema_inspect.")
  return lines.join("\n")
}

const SUMMARY_BYTES = 1_200
const SUMMARY_DEADLINE_MS = 2_000

/**
 * A compact connection list for the MCP server instructions: one line per connection with its type and, for small
 * local catalogs, its table names. Bounded like discoverCatalog (local engines only, table budget, deadline) and by
 * SUMMARY_BYTES; a connection whose tables do not fit is listed by name only. No columns, samples or row counts.
 */
export async function catalogSummary(warehouses: { name: string; type: string }[], context: DiscoveryContext): Promise<string> {
  const deadline = Date.now() + SUMMARY_DEADLINE_MS
  const timeLeft = () => deadline - Date.now()
  const budget = { tables: TABLE_BUDGET, columns: 0, samples: 0 }
  const lines: string[] = []
  let bytes = 0
  const shown = warehouses.filter((warehouse) => !isScratch(warehouse.name)).slice(0, MAX_CONNECTIONS)
  for (const [index, warehouse] of shown.entries()) {
    const head = `- ${warehouse.name} (${warehouse.type})`
    // Keep room for a name-only line for every connection still to come.
    const reserve = shown.slice(index + 1).reduce((total, next) => total + next.name.length + next.type.length + 8, 0)
    let line = head
    const config = Registry.getConfig(warehouse.name)
    if (isLocalConnection(config) && timeLeft() > 0) {
      context.signal.throwIfAborted()
      const type = Registry.canonicalType(config?.type) ?? ""
      const tables = await listTables(warehouse.name, type, budget, context, timeLeft).catch(() => {
        context.signal.throwIfAborted()
        return undefined
      })
      if (tables?.length) {
        const names = tables.map((table) => (table.schema && table.schema !== "main" ? `${table.schema}.${table.name}` : table.name))
        const full = `${head}: ${names.join(", ")}`
        if (bytes + Buffer.byteLength(full, "utf8") + 1 + reserve <= SUMMARY_BYTES) line = full
      }
    }
    if (bytes + Buffer.byteLength(line, "utf8") + 1 > SUMMARY_BYTES) break
    lines.push(line)
    bytes += Buffer.byteLength(line, "utf8") + 1
  }
  if (lines.length < warehouses.filter((warehouse) => !isScratch(warehouse.name)).length) lines.push("- (more: warehouse_list)")
  return lines.join("\n")
}

/** The connection's tables in name order, or undefined when the catalog exceeds the remaining table budget. */
async function listTables(
  warehouse: string,
  type: string,
  budget: { tables: number },
  context: DiscoveryContext,
  timeLeft: () => number,
): Promise<Table[] | undefined> {
  const options = { signal: context.signal, sessionID: context.sessionID, forceReadOnly: true }
  let schemas: string[]
  if (type === "mongodb") {
    // Database names come from one call; per-database counts would cost a command each.
    const connector = await Registry.get(warehouse)
    schemas = (await connector.listSchemas()).filter((name) => !MONGO_SYSTEM_DATABASES.has(name)).sort()
  } else {
    const listing = await Dispatcher.call("schema.list", { warehouse }, options)
    const counted = listing.schemas ?? []
    if (listing.truncated || counted.some((schema) => schema.table_count === undefined)) return undefined
    if (counted.reduce((total, schema) => total + schema.table_count!, 0) > budget.tables) return undefined
    schemas = counted.filter((schema) => schema.table_count! > 0).map((schema) => schema.name)
  }
  if (schemas.length > MAX_SCHEMAS) return undefined
  const tables: Table[] = []
  for (const schema of schemas) {
    if (timeLeft() <= 0) return undefined
    context.signal.throwIfAborted()
    const listing = await Dispatcher.call("schema.list", { warehouse, schema_name: schema }, options)
    if (listing.truncated || tables.length + listing.tables.length > budget.tables) return undefined
    tables.push(...listing.tables)
  }
  budget.tables -= tables.length
  return tables
}

async function sampleRow(
  warehouse: string,
  config: ConnectionConfig,
  table: Table,
  width: number,
  context: DiscoveryContext,
  timeLeft: () => number,
): Promise<string | undefined> {
  const connector = await Registry.get(warehouse)
  const timeout = Math.max(1, Math.min(SAMPLE_TIMEOUT_MS, timeLeft()))
  const result = await executeQuery(
    config,
    { readOnly: true, queryTimeoutMs: timeout },
    { signal: context.signal, sessionID: context.sessionID, forceReadOnly: true },
    (options) =>
      connector.execute(`SELECT * FROM ${quoteIdent(table.schema)}.${quoteIdent(table.name)} LIMIT 1`, 1, undefined, options),
  )
  const row = result.rows[0]
  if (!row) return undefined
  return row.slice(0, Math.min(width, MAX_COLUMNS_SHOWN)).map(sampleCell).join(" | ")
}
