import z from "zod"
import type { Connector } from "@altimateai/drivers"
import { QueryTimeoutError } from "@altimateai/drivers/types"
import { resolveQueryTimeout } from "@altimateai/drivers/query-timeout"
import { Tool } from "../../tool/tool"
import * as Registry from "../native/connections/registry"
import { SCRATCH_NAME, withScratchConnection, isScratch } from "../native/connections/scratch"
import { classifyAndCheck } from "./sql-classify"
import { readSql } from "./sql-check"

/** Default and hard ceilings, see the tool description. */
export const DEFAULT_MAX_ROWS = 2_000_000
export const HARD_MAX_ROWS = 20_000_000
/** Estimated in-memory size of the fetched rows. The drivers hand back fully materialised arrays. */
export const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024
const INSERT_BATCH_ROWS = 500
const INSERT_BATCH_CHARS = 1_000_000

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/
const MONGO_TYPES = new Set(["mongodb", "mongo"])
const MONGO_READ_COMMANDS = new Set(["find", "aggregate", "countDocuments", "distinct"])

export type ScratchType = "BOOLEAN" | "BIGINT" | "HUGEINT" | "DOUBLE" | "TIMESTAMP" | "BLOB" | "VARCHAR"

const INT64_MIN = -(2n ** 63n)
const INT64_MAX = 2n ** 63n - 1n
const INT128_MIN = -(2n ** 127n)
const INT128_MAX = 2n ** 127n - 1n

function kindOf(v: unknown): ScratchType | "JSON" | null {
  if (v === null || v === undefined) return null
  switch (typeof v) {
    case "boolean":
      return "BOOLEAN"
    case "bigint":
      if (v >= INT64_MIN && v <= INT64_MAX) return "BIGINT"
      return v >= INT128_MIN && v <= INT128_MAX ? "HUGEINT" : "VARCHAR"
    case "number":
      return Number.isSafeInteger(v) ? "BIGINT" : "DOUBLE"
    case "string":
      return "VARCHAR"
    case "object":
      if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : "TIMESTAMP"
      if (v instanceof Uint8Array) return "BLOB"
      return "JSON"
    default:
      return "VARCHAR"
  }
}

function widen(a: ScratchType | null, b: ScratchType): ScratchType {
  if (a === null || a === b) return b
  const numeric = new Set<ScratchType>(["BIGINT", "HUGEINT", "DOUBLE"])
  if (numeric.has(a) && numeric.has(b)) {
    if (a === "DOUBLE" || b === "DOUBLE") return "DOUBLE"
    return "HUGEINT"
  }
  return "VARCHAR"
}

const jsonText = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    typeof x === "bigint" ? x.toString() : x instanceof Uint8Array ? Buffer.from(x).toString("hex") : x,
  ) ?? String(v)

function quoteString(s: string): string {
  if (s.includes("\0")) throw new MaterializeError("NUL characters require a bound parameter, not a SQL literal.")
  return `'${s.replace(/'/g, "''")}'`
}

function textValue(v: unknown): string {
  if (typeof v === "string") return v
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString()
  if (typeof v === "object") return jsonText(v)
  return String(v)
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/** Render one value as a DuckDB literal for a column of the given type. */
export function literal(v: unknown, type: ScratchType): string {
  if (v === null || v === undefined) return "NULL"
  if (type === "VARCHAR") return quoteString(textValue(v))
  switch (type) {
    case "BOOLEAN":
      return v ? "TRUE" : "FALSE"
    case "BIGINT":
    case "HUGEINT":
      return typeof v === "bigint" ? v.toString() : String(v)
    case "DOUBLE":
      if (typeof v === "bigint") return v.toString()
      if (Number.isNaN(v as number)) return "'NaN'::DOUBLE"
      if (v === Infinity) return "'Infinity'::DOUBLE"
      if (v === -Infinity) return "'-Infinity'::DOUBLE"
      return String(v)
    case "TIMESTAMP":
      return v instanceof Date && !Number.isNaN(v.getTime())
        ? `TIMESTAMP '${v.toISOString().replace("Z", "")}'`
        : "NULL"
    case "BLOB":
      return `'${Array.from(v as Uint8Array, (b) => "\\x" + b.toString(16).padStart(2, "0")).join("")}'::BLOB`
  }
}

/** Rough in-memory size of one cell, for the byte bound. */
function cellBytes(v: unknown): number {
  if (v === null || v === undefined) return 1
  if (typeof v === "string") return v.length + 16
  if (typeof v === "object")
    return v instanceof Uint8Array ? v.byteLength + 16 : v instanceof Date ? 16 : jsonText(v).length + 16
  return 16
}

function uniqueColumnNames(raw: string[]): string[] {
  const seen = new Set<string>()
  return raw.map((name, i) => {
    let base = name && name.trim() ? name : `column_${i + 1}`
    let candidate = base
    let n = 2
    while (seen.has(candidate.toLowerCase())) candidate = `${base}_${n++}`
    seen.add(candidate.toLowerCase())
    return candidate
  })
}

export class MaterializeError extends Error {}

export interface MaterializeInput {
  source_warehouse: string
  sql: string
  target_table: string
  mode?: "create" | "replace" | "append"
  max_rows?: number
  max_bytes?: number
  query_timeout_ms?: number
}

export interface MaterializeResult {
  table: string
  mode: "create" | "replace" | "append"
  rows: number
  /** Total rows in the table after the operation (differs from `rows` on append). */
  total_rows: number
  columns: { name: string; type: string }[]
  materialized: boolean
}

/** Refuse anything but a read on the source; returns the mongo flag. */
function assertReadOnlySource(warehouse: string, sql: string): { mongo: boolean; sql: string } {
  const type = (Registry.getConfig(warehouse)?.type ?? "").toLowerCase()
  if (MONGO_TYPES.has(type)) {
    let cmd: any
    try {
      cmd = JSON.parse(sql)
    } catch {
      throw new MaterializeError(
        'A MongoDB source query must be a JSON command, e.g. {"command":"find","collection":"c"}.',
      )
    }
    if (!cmd || !MONGO_READ_COMMANDS.has(cmd.command)) {
      throw new MaterializeError(
        `sql_materialize only reads from the source. MongoDB command "${cmd?.command}" is not allowed; use one of: ${[...MONGO_READ_COMMANDS].join(", ")}.`,
      )
    }
    return { mongo: true, sql }
  }
  const { queryType, blocked } = classifyAndCheck(sql)
  try {
    if (blocked || queryType !== "read") throw new Error("Not a read")
    return { mongo: false, sql: readSql(sql) }
  } catch {
    throw new MaterializeError(
      "sql_materialize only reads from the source warehouse: use a single read-only SELECT (or WITH ... SELECT), " +
        "without modifying CTEs, SELECT INTO or side-effect functions. Its only write target is the scratch database.",
    )
  }
}

/** Bound the result even when the source SQL already contains a LIMIT in a subquery or comment. */
function boundedSql(sql: string, type: string | null, limit: number): string {
  if (type === "sqlserver") return `SELECT TOP (${limit}) * FROM (\n${sql}\n) AS __sql_materialize_source`
  if (type === "oracle") return `SELECT * FROM (\n${sql}\n) WHERE ROWNUM <= ${limit}`
  return `SELECT * FROM (\n${sql}\n) AS __sql_materialize_source LIMIT ${limit}`
}

async function extract(source: Connector, input: MaterializeInput, sql: string, maxRows: number, mongo: boolean) {
  const config = Registry.getConfig(input.source_warehouse)
  const type = Registry.canonicalType(config?.type)
  const options = { queryTimeoutMs: input.query_timeout_ms }
  const work = source.execute(mongo ? sql : boundedSql(sql, type, maxRows + 1), maxRows + 1, undefined, options)
  // Local engines own queue admission and cancellation. An outer timer would abandon
  // queued work that could subsequently execute, so only remote engines get a fallback.
  const deadline = resolveQueryTimeout(config, options).ms
  if (deadline === undefined || type === "sqlite" || type === "duckdb") return work
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new QueryTimeoutError({ engine: type ?? "database", timeoutMs: deadline, cancelled: false })),
          deadline + 5_000,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function materialize(input: MaterializeInput): Promise<MaterializeResult> {
  const mode = input.mode ?? "create"
  const table = input.target_table
  if (typeof table !== "string" || !IDENTIFIER.test(table)) {
    throw new MaterializeError(
      `Invalid target_table "${table}": use letters, digits and underscores only, starting with a letter or underscore (max 63 characters). The table is created in the "${SCRATCH_NAME}" database; do not include a schema or database prefix.`,
    )
  }
  const maxRows = Math.min(Math.max(Math.floor(input.max_rows ?? DEFAULT_MAX_ROWS), 1), HARD_MAX_ROWS)
  const maxBytes = input.max_bytes ?? Number(process.env["ALTIMATE_SCRATCH_MAX_BYTES"] || DEFAULT_MAX_BYTES)

  const { mongo, sql } = assertReadOnlySource(input.source_warehouse, input.sql)
  // The read-only boundary for SQL sources is structural, not transactional: `readSql` rejects
  // modifying statements, SELECT INTO and known side-effect functions lexically, and
  // `boundedSql` runs the statement as a derived table. PostgreSQL rejects a data-modifying
  // CTE anywhere but the top level and `SELECT ... INTO` inside a subquery, so a pinned
  // read-only transaction is not required to keep the source unmodified.
  // Resolve first so a configured warehouse using the reserved name fails explicitly.
  const source = await Registry.get(input.source_warehouse)
  await Registry.get(SCRATCH_NAME)
  return withScratchConnection(async (scratch) => {
    const result = await extract(isScratch(input.source_warehouse) ? scratch : source, input, sql, maxRows, mongo)

    if (result.rows.length > maxRows || result.truncated) {
      throw new MaterializeError(
        `The source query returned more than the row cap of ${maxRows.toLocaleString("en-US")} rows; nothing was materialized. ` +
          "Aggregate or filter in the source query, or raise max_rows (hard limit " +
          `${HARD_MAX_ROWS.toLocaleString("en-US")}).`,
      )
    }

    const names = uniqueColumnNames(result.columns)
    if (names.length === 0) {
      return { table, mode, rows: 0, total_rows: 0, columns: [], materialized: false }
    }

    // Type inference (the drivers expose no column metadata, only names, so the type comes from the values:
    // integers stay BIGINT, any fractional value widens to DOUBLE, mixed kinds fall back to VARCHAR, an
    // all-NULL column is VARCHAR) and the byte bound share one pass over the data.
    const types: ScratchType[] = []
    let bytes = 0
    for (let c = 0; c < names.length; c++) {
      let t: ScratchType | null = null
      for (const row of result.rows) {
        const v = row[c]
        bytes += cellBytes(v)
        if (t !== "VARCHAR") {
          const k = kindOf(v)
          if (k !== null) t = widen(t, k === "JSON" ? "VARCHAR" : k)
        }
      }
      types.push(t ?? "VARCHAR")
      if (bytes > maxBytes) {
        throw new MaterializeError(
          `The source result is about ${Math.round(bytes / 1_048_576)} MiB, above the ${Math.round(maxBytes / 1_048_576)} MiB bound; nothing was materialized. Select fewer columns or filter/aggregate in the source query.`,
        )
      }
    }

    const run = (sql: string, binds?: string[]) => scratch.execute(sql, undefined, binds, { noLimit: true })
    const scratchRows = async (sql: string) => (await run(sql)).rows
    const q = quoteIdent(table)
    const existing = await scratchRows(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_catalog = '${SCRATCH_NAME}' AND table_schema = 'main' AND table_name = ${quoteString(table)} ORDER BY ordinal_position`,
    )
    const exists = existing.length > 0

    if (mode === "create" && exists) {
      throw new MaterializeError(
        `${SCRATCH_NAME}.${table} already exists. Use mode "replace" to overwrite it or "append" to add rows.`,
      )
    }

    let insertNames = names
    let finalColumns = names.map((n, i) => ({ name: n, type: types[i] as string }))
    if (mode === "append" && exists) {
      const have = new Map(
        existing.map((r) => [String(r[0]).toLowerCase(), { name: String(r[0]), type: String(r[1]) }]),
      )
      const missing = names.filter((n) => !have.has(n.toLowerCase()))
      if (missing.length) {
        throw new MaterializeError(
          `Cannot append to ${SCRATCH_NAME}.${table}: it has no column(s) ${missing.join(", ")}. Existing columns: ${[...have.values()].map((c) => c.name).join(", ")}.`,
        )
      }
      insertNames = names.map((n) => have.get(n.toLowerCase())!.name)
      finalColumns = existing.map((r) => ({ name: String(r[0]), type: String(r[1]) }))
    }

    let began = false
    try {
      await run("BEGIN TRANSACTION")
      began = true
      if (!(mode === "append" && exists)) {
        const defs = names.map((n, i) => `${quoteIdent(n)} ${types[i]}`).join(", ")
        await run(`CREATE ${mode === "replace" ? "OR REPLACE " : ""}TABLE ${q} (${defs})`)
      }
      const colList = insertNames.map(quoteIdent).join(", ")
      let batch: string[] = []
      let binds: string[] = []
      let chars = 0
      const flush = async () => {
        if (!batch.length) return
        await run(`INSERT INTO ${q} (${colList}) VALUES ${batch.join(", ")}`, binds)
        batch = []
        binds = []
        chars = 0
      }
      for (const row of result.rows) {
        const tuple = `(${types
          .map((t, c) => {
            const value = row[c]
            // Bind text losslessly, including NUL. Keep typed literals for other
            // values: the legacy DuckDB binding does not safely bind native bigint.
            if (t === "VARCHAR" && value !== null && value !== undefined) {
              const text = textValue(value)
              binds.push(text)
              chars += text.length
              return "?"
            }
            return literal(value, t)
          })
          .join(", ")})`
        batch.push(tuple)
        chars += tuple.length
        if (batch.length >= INSERT_BATCH_ROWS || chars >= INSERT_BATCH_CHARS) await flush()
      }
      await flush()
      await run("COMMIT")
      began = false
    } catch (e) {
      try {
        if (began) await run("ROLLBACK")
      } catch {
        // the transaction may already be gone
      }
      throw new MaterializeError(
        `Failed to write ${SCRATCH_NAME}.${table}: ${e instanceof Error ? e.message : String(e)}${mode === "append" ? " (the append was rolled back)" : ""}`,
      )
    }

    const total = Number((await scratchRows(`SELECT count(*) FROM ${q}`))[0]?.[0] ?? result.rows.length)
    return { table, mode, rows: result.rows.length, total_rows: total, columns: finalColumns, materialized: true }
  })
}

export const SqlMaterializeTool = Tool.define("sql_materialize", {
  description:
    "Run a read-only query on any warehouse and store ALL resulting rows as a table in `scratch`, a session-scoped in-memory DuckDB database, " +
    "so data from different engines (e.g. a SQLite file and Postgres) can be joined in one SQL statement without copying rows through the conversation. " +
    'Then query it with sql_execute(warehouse: "scratch", ...). The only write target is scratch. ' +
    "Source queries are validated as reads and executed as a derived table, so modifying CTEs, SELECT INTO and side-effect functions are refused. " +
    "SQL Server source queries must be valid inside a derived table (use a view for CTE queries). " +
    `Row cap defaults to ${DEFAULT_MAX_ROWS.toLocaleString("en-US")}. \`source_warehouse\` may be \`scratch\` itself to derive a table. ` +
    "For MongoDB sources pass a JSON find/aggregate command as `sql`.",
  parameters: z.object({
    source_warehouse: z.string().describe("Warehouse to read from (a name from warehouse_list, or `scratch`)"),
    sql: z.string().describe("Read-only SELECT to run on the source warehouse; every row it returns is stored"),
    target_table: z
      .string()
      .describe("Table to create in scratch: letters, digits, underscores; no schema or database prefix"),
    mode: z
      .enum(["create", "replace", "append"])
      .optional()
      .default("create")
      .describe(
        "create: fail if the table exists (default); replace: overwrite it; append: add rows to it (created if missing)",
      ),
    max_rows: z.number().optional().describe(`Row cap (default ${DEFAULT_MAX_ROWS}, hard limit ${HARD_MAX_ROWS})`),
    query_timeout_ms: z
      .number()
      .int()
      .min(0)
      .max(3_600_000)
      .optional()
      .describe("Source query deadline; uses the common connection policy when omitted (0 disables it)"),
  }),
  async execute(args): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
    try {
      const r = await materialize(args)
      const label = `${SCRATCH_NAME}.${r.table}`
      if (!r.materialized) {
        return {
          title: `Materialize ${label}: 0 rows`,
          metadata: { rowCount: 0, table: r.table, materialized: false },
          output:
            `The source query returned 0 rows and no column information, so ${label} was not created or changed.\n` +
            "Check the filter, or run the query with sql_execute to see why it is empty.",
        }
      }
      const cols = r.columns.map((c) => `${c.name} ${c.type}`).join(", ")
      const rowsLine = r.mode === "append" ? `${r.rows} rows appended (${r.total_rows} total)` : `${r.rows} rows`
      return {
        title: `Materialize ${label}: ${r.rows} rows`,
        metadata: { rowCount: r.rows, totalRows: r.total_rows, table: r.table, materialized: true, mode: r.mode },
        output:
          `${label}: ${rowsLine}, ${r.columns.length} columns (${r.mode === "append" ? "append" : r.mode}).\n` +
          `Columns: ${cols}\n` +
          `Source: ${isScratch(args.source_warehouse) ? SCRATCH_NAME : args.source_warehouse}. SQL run:\n${args.sql}\n\n` +
          `Join it in scratch with sql_execute(warehouse: "${SCRATCH_NAME}", query: "SELECT ... FROM ${r.table} ...") ` +
          `(the table is also addressable as ${label}).`,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Materialize: ERROR",
        metadata: { rowCount: 0, materialized: false, error: msg },
        output: `Failed to materialize: ${msg}`,
      }
    }
  },
})
