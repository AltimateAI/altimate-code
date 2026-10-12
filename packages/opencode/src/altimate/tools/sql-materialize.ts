import z from "zod"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { normalizeMqlCommand, type Connector } from "@altimateai/drivers"
import { isQueryTimeoutError, QueryTimeoutError } from "@altimateai/drivers/types"
import { resolveQueryTimeout } from "@altimateai/drivers/query-timeout"
import { isResultByteLimitError, rowBytes } from "@altimateai/drivers/result-byte-limit"
import { Tool } from "../../tool/tool"
import * as Registry from "../native/connections/registry"
import { SCRATCH_NAME, withScratchConnection, isScratch } from "../native/connections/scratch"
import { classifyAndCheck, classifyMongoCommand } from "./sql-classify"
import { readSql } from "./sql-check"
import { lintSqlResult } from "./sql-result-lint"
import * as Precedence from "../workspace/precedence"

/** Default and hard ceilings, see the tool description. */
export const DEFAULT_MAX_ROWS = 2_000_000
export const HARD_MAX_ROWS = 20_000_000
/** Serialized row data, enforced while drivers consume rows (plus one row/client chunk in flight). */
export const DEFAULT_MAX_BYTES = 256 * 1024 * 1024
export const HARD_MAX_BYTES = 2 * 1024 * 1024 * 1024
const FALLBACK_MAX_ROWS = 200_000
const SAMPLE_ROWS = 1000
const JSONL_BUFFER_CHARS = 1_000_000

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/
const MONGO_TYPES = new Set(["mongodb", "mongo"])
const MONGO_READ_COMMANDS = new Set(["find", "aggregate", "countDocuments"])

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

/** Values arrive unpacked from the local-engine codec; preserve them in typed JSON columns. */
function jsonValue(v: unknown, type: ScratchType): unknown {
  if (v === null || v === undefined) return null
  if (type === "VARCHAR") return textValue(v)
  if (type === "TIMESTAMP") return v instanceof Date && !Number.isNaN(v.getTime()) ? v.toISOString() : null
  if (type === "BLOB") return Buffer.from(v as Uint8Array).toString("hex")
  if (typeof v === "bigint" || (typeof v === "number" && !Number.isFinite(v))) return String(v)
  return v
}

async function writeJsonRows(file: string, rows: unknown[][], types: ScratchType[]): Promise<number> {
  const handle = await fs.open(file, "wx", 0o600)
  // Positional field names avoid JSON key collisions and preserve arbitrary SQL column names.
  const keys = types.map((_, i) => `c${i}`)
  const record: Record<string, unknown> = {}
  let lines: string[] = []
  let chars = 0
  let maxObjectSize = 16 * 1024 * 1024
  try {
    for (const row of rows) {
      for (let c = 0; c < types.length; c++) record[keys[c]] = jsonValue(row[c], types[c])
      const line = JSON.stringify(record) + "\n"
      maxObjectSize = Math.max(maxObjectSize, Buffer.byteLength(line, "utf8"))
      lines.push(line)
      chars += line.length
      if (chars < JSONL_BUFFER_CHARS) continue
      await handle.writeFile(lines.join(""))
      lines = []
      chars = 0
    }
    if (lines.length) await handle.writeFile(lines.join(""))
    return maxObjectSize
  } finally {
    await handle.close()
  }
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${Math.ceil(bytes)} bytes`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(2)} KiB`
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : `${(bytes / 1024 ** 2).toFixed(2)} MiB`
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
  warnings?: string[]
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
    // Accept the native `{"find": "coll"}` shape as well as `{command, collection}`.
    cmd = cmd && typeof cmd === "object" ? normalizeMqlCommand(cmd) : cmd
    if (!cmd || !MONGO_READ_COMMANDS.has(cmd.command)) {
      throw new MaterializeError(
        `sql_materialize only reads from the source. MongoDB command "${cmd?.command}" is not allowed; use one of: ${[...MONGO_READ_COMMANDS].join(", ")}.`,
      )
    }
    if (classifyMongoCommand(JSON.stringify(cmd))?.queryType !== "read") {
      throw new MaterializeError(
        "sql_materialize only reads from the source; MongoDB write pipeline stages are not allowed.",
      )
    }
    return { mongo: true, sql: JSON.stringify(cmd) }
  }
  const { queryType, blocked } = classifyAndCheck(sql, Registry.canonicalType(type) ?? undefined)
  try {
    if (blocked || queryType !== "read") throw new Error("Not a read")
    return { mongo: false, sql: readSql(sql, Registry.canonicalType(type) ?? undefined) }
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

function boundedMongo(sql: string, limit: number): string {
  const cmd = JSON.parse(sql)
  if (cmd.command !== "aggregate" || !Array.isArray(cmd.pipeline)) return sql
  // An earlier $limit does not bound later expanding stages such as $unwind.
  return JSON.stringify({ ...cmd, pipeline: [...cmd.pipeline, { $limit: limit }] })
}

function mongoPreflightQueries(sql: string, maxRows: number) {
  const cmd = JSON.parse(sql)
  if (cmd.command === "find") {
    const limit = typeof cmd.limit === "number" && cmd.limit > 0 ? cmd.limit : Infinity
    return {
      count: JSON.stringify({ ...cmd, command: "countDocuments", limit: Math.min(limit, maxRows + 1) }),
      sample: JSON.stringify({ ...cmd, limit: Math.min(limit, SAMPLE_ROWS) }),
      emptyCountIsZero: false,
    }
  }
  if (cmd.command === "aggregate" && Array.isArray(cmd.pipeline)) {
    return {
      count: JSON.stringify({ ...cmd, pipeline: [...cmd.pipeline, { $limit: maxRows + 1 }, { $count: "n" }] }),
      sample: JSON.stringify({ ...cmd, pipeline: [...cmd.pipeline, { $limit: SAMPLE_ROWS }] }),
      // MongoDB's $count returns no document for an empty input.
      emptyCountIsZero: true,
    }
  }
  throw new Error(`Pre-flight count is unsupported for MongoDB command "${cmd.command}"`)
}

async function executeSource(source: Connector, input: MaterializeInput, sql: string, limit: number, maxBytes: number) {
  const config = Registry.getConfig(input.source_warehouse)
  const type = Registry.canonicalType(config?.type)
  const options = {
    queryTimeoutMs: input.query_timeout_ms,
    maxResultBytes: maxBytes,
    ...(type === "postgres" ? { readOnly: true } : {}),
  }
  const work = source.execute(sql, limit, undefined, options)
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

async function preflight(
  source: Connector,
  input: MaterializeInput,
  sql: string,
  maxRows: number,
  maxBytes: number,
  mongo: boolean,
) {
  const type = Registry.canonicalType(Registry.getConfig(input.source_warehouse)?.type)
  let count: number | undefined
  let estimatedBytes: number | undefined
  try {
    const probes = mongo ? mongoPreflightQueries(sql, maxRows) : undefined
    const alias = type === "oracle" ? "" : "AS "
    const from = `FROM (\n${sql}\n) ${alias}__m`
    const boundedCount =
      type === "sqlserver"
        ? `SELECT TOP (${maxRows + 1}) 1 AS __one ${from}`
        : type === "oracle"
          ? `SELECT 1 AS __one ${from} WHERE ROWNUM <= ${maxRows + 1}`
          : `SELECT 1 AS __one ${from} LIMIT ${maxRows + 1}`
    const result = await executeSource(
      source,
      input,
      probes?.count ?? `SELECT count(*) FROM (${boundedCount}) ${alias}__c`,
      // MongoDB caps pipeline stages against this limit before running $count.
      mongo ? maxRows + 1 : 1,
      maxBytes,
    )
    const emptyCount = probes?.emptyCountIsZero && result.rows.length === 0
    const value = emptyCount ? 0 : result.rows[0]?.[0]
    const n =
      typeof value === "number" || typeof value === "bigint" || (typeof value === "string" && value.trim())
        ? Number(value)
        : NaN
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || result.truncated || (!emptyCount && result.rows.length !== 1)) {
      throw new Error("The count query did not return a valid row count")
    }
    count = n
    if (count <= maxRows) {
      const sample = await executeSource(
        source,
        input,
        probes?.sample ?? boundedSql(sql, type, SAMPLE_ROWS),
        SAMPLE_ROWS,
        maxBytes,
      )
      if (count > 0 && sample.rows.length === 0) throw new Error("The sample query returned no rows")
      estimatedBytes = sample.rows.length
        ? count * (sample.rows.reduce((sum, row) => sum + rowBytes(row), 0) / sample.rows.length)
        : 0
    }
  } catch (e) {
    if (isQueryTimeoutError(e) || isResultByteLimitError(e)) throw e
    const cap = Math.min(maxRows, FALLBACK_MAX_ROWS)
    return {
      maxRows: cap,
      warnings: [
        `Pre-flight estimate unavailable (${e instanceof Error ? e.message : String(e)}); extraction row cap clamped to ${cap.toLocaleString("en-US")} rows. The byte cap is enforced during transfer.`,
      ],
    }
  }
  if (count !== undefined && (count > maxRows || (estimatedBytes ?? 0) > maxBytes)) {
    const rows = count > maxRows ? `more than ${maxRows.toLocaleString("en-US")}` : `about ${count.toLocaleString("en-US")}`
    const size = estimatedBytes === undefined ? "" : ` ≈ ${sizeLabel(estimatedBytes)}`
    const cap = count > maxRows ? `row cap of ${maxRows.toLocaleString("en-US")} rows` : `${sizeLabel(maxBytes)} bound`
    throw new MaterializeError(
      `The source query has ${rows} rows${size}, above the ${cap}; nothing was materialized. ` +
        `Aggregate or filter in the source query, select fewer columns, or raise max_rows (hard limit ${HARD_MAX_ROWS.toLocaleString("en-US")}) / max_bytes (hard limit 2 GiB).`,
    )
  }
  return { maxRows, warnings: [] }
}

export async function materialize(input: MaterializeInput): Promise<MaterializeResult> {
  const mode = input.mode ?? "create"
  const table = input.target_table
  if (typeof table !== "string" || !IDENTIFIER.test(table)) {
    throw new MaterializeError(
      `Invalid target_table "${table}": use letters, digits and underscores only, starting with a letter or underscore (max 63 characters). The table is created in the "${SCRATCH_NAME}" database; do not include a schema or database prefix.`,
    )
  }
  // Strict-schema callers send 0 for "not specified"; a zero cap would refuse every result.
  let maxRows = Math.min(Math.max(Math.floor(input.max_rows || DEFAULT_MAX_ROWS), 1), HARD_MAX_ROWS)
  const requestedBytes = input.max_bytes || Number(process.env["ALTIMATE_SCRATCH_MAX_BYTES"] || DEFAULT_MAX_BYTES)
  const maxBytes = Math.min(
    Math.max(Math.floor(Number.isFinite(requestedBytes) ? requestedBytes : DEFAULT_MAX_BYTES), 1),
    HARD_MAX_BYTES,
  )

  const { mongo, sql } = assertReadOnlySource(input.source_warehouse, input.sql)
  // Keep structural guards on all sources. PostgreSQL additionally executes each
  // source probe in a pinned READ ONLY transaction and rolls it back, so writing
  // UDFs fail at the database boundary and pg_notify cannot deliver notifications.
  // Resolve first so a configured warehouse using the reserved name fails explicitly.
  const source = await Registry.get(input.source_warehouse)
  if (!source.supportsResultByteLimit) {
    throw new MaterializeError(
      `Warehouse "${input.source_warehouse}" does not support bounded result transfer. ` +
        "sql_materialize requires a SQLite, DuckDB, PostgreSQL or MongoDB source that enforces max_bytes while reading rows.",
    )
  }
  await Registry.get(SCRATCH_NAME)
  const warnings: string[] = []
  return withScratchConnection(async (scratch, directory) => {
    const connection = isScratch(input.source_warehouse) ? scratch : source
    const guard = await preflight(connection, input, sql, maxRows, maxBytes, mongo)
    maxRows = guard.maxRows
    warnings.push(...guard.warnings)
    const type = Registry.canonicalType(Registry.getConfig(input.source_warehouse)?.type)
    const query = mongo ? boundedMongo(sql, maxRows + 1) : boundedSql(sql, type, maxRows + 1)
    const result = await executeSource(connection, input, query, maxRows + 1, maxBytes)

    if (result.rows.length > maxRows || result.truncated) {
      throw new MaterializeError(
        `The source query returned more than the row cap of ${maxRows.toLocaleString("en-US")} rows; nothing was materialized. ` +
          "Aggregate or filter in the source query, or raise max_rows (hard limit " +
          `${HARD_MAX_ROWS.toLocaleString("en-US")}).`,
      )
    }

    const names = uniqueColumnNames(result.columns)
    if (names.length === 0) {
      return { table, mode, rows: 0, total_rows: 0, columns: [], materialized: false, warnings }
    }

    let bytes = 0
    for (const row of result.rows) {
      bytes += rowBytes(row)
      if (bytes > maxBytes) {
        throw new MaterializeError(
          `The source result is about ${sizeLabel(bytes)}, above the ${sizeLabel(maxBytes)} bound; nothing was materialized. ` +
            "Select fewer columns, filter/aggregate in the source query, or raise max_bytes (hard limit 2 GiB).",
        )
      }
    }

    // Type inference (the drivers expose no column metadata, only names, so the type comes from the values:
    // integers stay BIGINT, any fractional value widens to DOUBLE, mixed kinds fall back to VARCHAR, an
    // all-NULL column is VARCHAR).
    const types: ScratchType[] = []
    for (let c = 0; c < names.length; c++) {
      let t: ScratchType | null = null
      for (const row of result.rows) {
        const v = row[c]
        if (t !== "VARCHAR") {
          const k = kindOf(v)
          if (k !== null) t = widen(t, k === "JSON" ? "VARCHAR" : k)
        }
      }
      types.push(t ?? "VARCHAR")
    }

    const run = (sql: string) => scratch.execute(sql, undefined, undefined, { noLimit: true })
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
    let loadDir: string | undefined
    try {
      let select: string | undefined
      if (result.rows.length) {
        loadDir = await fs.mkdtemp(path.join(directory, "materialize-"))
        if (process.platform !== "win32") await fs.chmod(loadDir, 0o700)
        const file = path.join(loadDir, "rows.jsonl")
        const maxObjectSize = await writeJsonRows(file, result.rows, types)
        const columns = types.map((t, c) => `'c${c}': '${t === "BLOB" ? "VARCHAR" : t}'`).join(", ")
        const values = types.map((t, c) => (t === "BLOB" ? `from_hex(c${c})` : `c${c}`)).join(", ")
        select = `SELECT ${values} FROM read_json(${quoteString(file)}, format = 'newline_delimited', columns = {${columns}}, maximum_object_size = ${maxObjectSize})`
      }
      await run("BEGIN TRANSACTION")
      began = true
      if (!(mode === "append" && exists)) {
        const defs = names.map((n, i) => `${quoteIdent(n)} ${types[i]}`).join(", ")
        await run(`CREATE ${mode === "replace" ? "OR REPLACE " : ""}TABLE ${q} (${defs})`)
      }
      const colList = insertNames.map(quoteIdent).join(", ")
      if (select) await run(`INSERT INTO ${q} (${colList}) ${select}`)
      await run("COMMIT")
      began = false
    } catch (e) {
      try {
        if (began) await run("ROLLBACK")
      } catch {
        // the transaction may already be gone
      }
      const message = e instanceof Error ? e.message : String(e)
      const detail = loadDir
        ? message.replaceAll(loadDir.replaceAll("'", "''"), "[materialize]").replaceAll(loadDir, "[materialize]")
        : message
      throw new MaterializeError(
        `Failed to write ${SCRATCH_NAME}.${table}: ${detail}${mode === "append" ? " (the append was rolled back)" : ""}`,
      )
    } finally {
      if (loadDir) await fs.rm(loadDir, { recursive: true, force: true }).catch(() => {})
    }

    const total = Number((await scratchRows(`SELECT count(*) FROM ${q}`))[0]?.[0] ?? result.rows.length)
    return {
      table,
      mode,
      rows: result.rows.length,
      total_rows: total,
      columns: finalColumns,
      materialized: true,
      warnings,
    }
  }).catch((e) => {
    if (isResultByteLimitError(e)) {
      throw new MaterializeError(
        `The source result is above the ${sizeLabel(maxBytes)} bound; transfer stopped and nothing was materialized. ` +
          "Select fewer columns, filter/aggregate in the source query, or raise max_bytes (hard limit 2 GiB).",
      )
    }
    if (!warnings.length || isQueryTimeoutError(e)) throw e
    throw new MaterializeError(`${warnings.join("\n")}\n${e instanceof Error ? e.message : String(e)}`)
  })
}

export const SqlMaterializeTool = Tool.define("sql_materialize", {
  description:
    "Run a read-only query on a SQLite, DuckDB, PostgreSQL or MongoDB warehouse and store ALL resulting rows as a table in `scratch`, a session-scoped ephemeral DuckDB database, " +
    "so data from different engines (e.g. a SQLite file and Postgres) can be joined in one SQL statement without copying rows through the conversation. " +
    'Then query it with sql_execute(warehouse: "scratch", ...). The only write target is scratch. ' +
    "Source queries are validated as reads and executed as a derived table. Modifying CTEs, SELECT INTO and known side-effect functions are refused; PostgreSQL also uses rolled-back read-only transactions. " +
    "Other source drivers are refused until they support byte-bounded transfer. " +
    `Caps default to ${DEFAULT_MAX_ROWS.toLocaleString("en-US")} rows / 256 MiB serialized row data, enforced during transfer (one row/client chunk may be in flight). \`source_warehouse\` may be \`scratch\` itself to derive a table. ` +
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
    max_bytes: z
      .number()
      .int()
      .min(0)
      .max(HARD_MAX_BYTES)
      .optional()
      .describe("Serialized row byte cap enforced during transfer (default 256 MiB, hard limit 2 GiB; 0 = default)"),
    query_timeout_ms: z
      .number()
      .int()
      .min(0)
      .max(3_600_000)
      .optional()
      .describe("Source query deadline; uses the common connection policy when omitted (0 disables it)"),
  }),
  async execute(args, ctx): Promise<{ title: string; metadata: Record<string, any>; output: string }> {
    const verdict = await Precedence.check(ctx.sessionID, "sql_execute", args.source_warehouse)
    if (verdict.redirect) return verdict.redirect
    try {
      const r = await materialize(args)
      const lint = await lintSqlResult(args.sql, args.source_warehouse, ctx.sessionID)
      const checks = lint ? "\n\n" + lint.output : ""
      const lintMetadata = lint ? { lint_rules: lint.rules } : {}
      const label = `${SCRATCH_NAME}.${r.table}`
      const warning = r.warnings?.length ? `Warning: ${r.warnings.join("\n")}\n` : ""
      if (!r.materialized) {
        return Precedence.annotate(verdict, {
          title: `Materialize ${label}: 0 rows`,
          metadata: { rowCount: 0, table: r.table, materialized: false, ...lintMetadata },
          output:
            warning +
            `The source query returned 0 rows and no column information, so ${label} was not created or changed.\n` +
            "Check the filter, or run the query with sql_execute to see why it is empty." +
            checks,
        })
      }
      const cols = r.columns.map((c) => `${c.name} ${c.type}`).join(", ")
      const rowsLine = r.mode === "append" ? `${r.rows} rows appended (${r.total_rows} total)` : `${r.rows} rows`
      return Precedence.annotate(verdict, {
        title: `Materialize ${label}: ${r.rows} rows`,
        metadata: {
          rowCount: r.rows,
          totalRows: r.total_rows,
          table: r.table,
          materialized: true,
          mode: r.mode,
          ...lintMetadata,
        },
        output:
          warning +
          `${label}: ${rowsLine}, ${r.columns.length} columns (${r.mode === "append" ? "append" : r.mode}).\n` +
          `Columns: ${cols}\n` +
          `Source: ${isScratch(args.source_warehouse) ? SCRATCH_NAME : args.source_warehouse}. SQL run:\n${args.sql}\n\n` +
          `Join it in scratch with sql_execute(warehouse: "${SCRATCH_NAME}", query: "SELECT ... FROM ${r.table} ...") ` +
          `(the table is also addressable as ${label}).` +
          checks,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return Precedence.annotate(verdict, {
        title: "Materialize: ERROR",
        metadata: { rowCount: 0, materialized: false, error: msg },
        output: `Failed to materialize: ${msg}`,
      })
    }
  },
})
