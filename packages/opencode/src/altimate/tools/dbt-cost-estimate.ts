import z from "zod"
import { Tool } from "../../tool/tool"
import { dbtAdapterFor } from "./dbt-adapter-access"

/**
 * Every dbt integration but the Python bridge writes the SQL into a `{{ validate_sql('...') }}` Jinja
 * argument, so a quote or backslash in it must be escaped or any filter on a string breaks the dry run.
 * The bridge, which a config without an integration also means, binds the SQL as a parameter and takes it as is.
 */
export function forDryRun(sql: string, integration: unknown): string {
  return integration == null || integration === "core" ? sql : sql.replace(/\\/g, "\\\\").replace(/'/g, "\\'")
}

/** The units dbt-bigquery's `format_bytes` writes, smallest first; each is 1024 times the one before. */
const UNITS = ["Bytes", "KiB", "MiB", "GiB", "TiB", "PiB"] as const

/**
 * The byte count in a dry run's `bytes_processed`, which dbt-bigquery formats as text ("4.2 TiB",
 * "512.0 Bytes"), and the most it can be. The text carries one decimal, so a figure past a byte is
 * rounded: the true count is within half a tenth of its unit. Undefined for anything else, so a changed
 * format is reported, never read as a count.
 */
/** Whether the SQL is a script (more than one statement, or EXECUTE IMMEDIATE): a dry run only sees its first statements. */
export function isScript(sql: string): boolean {
  // One pass over comments and quoted text together: a quote inside a comment, or a comment marker inside a quote, is not either.
  const bare = sql
    .replace(/--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`/g, " ")
    .replace(/;\s*$/, "")
  return bare.includes(";") || /\bexecute\s+immediate\b/i.test(bare)
}

export function parseBytesProcessed(display: unknown): { bytes: number; maxBytes: number } | undefined {
  if (typeof display === "number") {
    if (!Number.isFinite(display) || display < 0) return undefined
    const bytes = Math.round(display)
    return { bytes, maxBytes: bytes }
  }
  if (typeof display !== "string") return undefined
  const match = /^\s*(\d+(?:\.\d+)?)\s*(Bytes|KiB|MiB|GiB|TiB|PiB)\s*$/i.exec(display)
  if (!match) return undefined
  const unit = UNITS.findIndex((u) => u.toLowerCase() === match[2].toLowerCase())
  const scale = 1024 ** unit
  const bytes = Math.round(Number(match[1]) * scale)
  if (unit === 0) return { bytes, maxBytes: bytes }
  // Exact in integers: the shown figure is rounded to its last digit, so the true count is at most half
  // of that digit above it. A float product is off by whole bytes past a few TiB.
  const [whole, fraction = ""] = match[1].split(".")
  const digits = BigInt(whole + fraction)
  let upper = ((digits * 2n + 1n) * 1024n ** BigInt(unit) + 2n * 10n ** BigInt(fraction.length) - 1n) / (2n * 10n ** BigInt(fraction.length))
  // Python divides in floats, so a count within a float's last place of a tie is shown rounded down.
  upper += upper >> 50n
  let maxBytes = Number(upper)
  if (BigInt(Math.trunc(maxBytes)) < upper) maxBytes *= 1 + Number.EPSILON
  return { bytes, maxBytes: Math.max(bytes, maxBytes) }
}

/** Bytes in the units the BigQuery dry run writes them in: "4.2 TiB". */
export function formatBytes(bytes: number): string {
  let n = bytes
  let i = 0
  while (n >= 1024 && i < UNITS.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(1)} ${UNITS[i]}`
}

/** A scan estimate from the warehouse's query planner: what EXPLAIN says the query reads, without running it. */
export type PlanEstimate = { bytes: number; partitionsAssigned?: number; partitionsTotal?: number }

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined)

/**
 * The bytes Snowflake's `EXPLAIN USING JSON` says the query will scan: `GlobalStats.bytesAssigned`, the
 * micro-partitions left after compile-time pruning. Takes the `content` column as text or parsed JSON.
 * Undefined for anything without a readable `bytesAssigned`, so a changed format is reported, never read as a count.
 */
export function parseSnowflakeExplain(content: unknown): PlanEstimate | undefined {
  let plan = content
  if (typeof plan === "string") {
    try {
      plan = JSON.parse(plan)
    } catch {
      return undefined
    }
  }
  const stats = (plan as { GlobalStats?: Record<string, unknown> } | null)?.GlobalStats
  if (!stats || typeof stats !== "object") return undefined
  const bytes = count(stats.bytesAssigned)
  if (bytes === undefined) return undefined
  const partitionsAssigned = count(stats.partitionsAssigned)
  const partitionsTotal = count(stats.partitionsTotal)
  return {
    bytes: Math.round(bytes),
    ...(partitionsAssigned !== undefined && { partitionsAssigned }),
    ...(partitionsTotal !== undefined && { partitionsTotal }),
  }
}

/** Spark's `Utils.bytesToString` units, each 1024 times the one before; Spark 2 wrote "KB" for "KiB". */
const SPARK_UNITS: Record<string, number> = { B: 0, KIB: 1, MIB: 2, GIB: 3, TIB: 4, PIB: 5, EIB: 6, KB: 1, MB: 2, GB: 3, TB: 4, PB: 5, EB: 6 }
/**
 * A relation Spark has no size for is given `spark.sql.defaultSizeInBytes`, Long.MaxValue unless set ("8.0 EiB"):
 * a leaf at or past this is no size at all.
 */
const SPARK_NO_SIZE = 2 ** 62

/** The headers Spark writes between the sections of an EXPLAIN. */
const SPARK_SECTION = /^== (Parsed Logical Plan|Analyzed Logical Plan|Optimized Logical Plan|Physical Plan) ==\s*$/

/** A `sizeInBytes=` figure read back into bytes: "12.3 MiB", "16.0 B", or past a long "1.23E+21 B". */
function sparkBytes(figure: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?(?:E[+-]?\d+)?)\s*([A-Za-z]+)$/i.exec(figure.trim())
  if (!match) return undefined
  const unit = SPARK_UNITS[match[2].toUpperCase()]
  if (unit === undefined) return undefined
  const value = Number(match[1]) * 1024 ** unit
  return Number.isFinite(value) ? value : undefined
}

/**
 * The bytes Databricks' `EXPLAIN COST` says the query reads: the sum of `Statistics(sizeInBytes=…)` over the
 * leaves of the Optimized Logical Plan, the relations it scans. Their sizes are table (or file) sizes from the
 * catalog and the Delta log, before column pruning and runtime file skipping. `noStats` when a leaf carries no
 * size or Spark's default for a relation without statistics (with the relation's name when the leaf gives one);
 * undefined when there is no plan to read.
 */
export function parseDatabricksExplainCost(plan: unknown): PlanEstimate | { noStats: true; relation?: string } | undefined {
  if (typeof plan !== "string") return undefined
  const lines = plan.replace(/\r\n?/g, "\n").split("\n")
  const start = lines.findIndex((line) => /^\s*==\s*Optimized Logical Plan\s*==\s*$/i.test(line))
  if (start < 0) return undefined
  const nodes: { depth: number; text: string }[] = []
  for (const line of lines.slice(start + 1)) {
    // Only Spark's own section headers end the plan: a line of a multi-line node could look like one.
    if (SPARK_SECTION.test(line)) break
    if (!line.trim()) continue
    // Each level of the tree is three characters: ":  " or "   " for an ancestor, ":- " or "+- " for the node itself.
    const prefix = /^(?::  |   )*(?:[:+]- )?/.exec(line)![0]
    nodes.push({ depth: prefix.length / 3, text: line.slice(prefix.length) })
  }
  if (nodes.length === 0) return undefined
  let bytes = 0
  for (let i = 0; i < nodes.length; i++) {
    // A leaf is a node the next line does not go below.
    if (i + 1 < nodes.length && nodes[i + 1].depth > nodes[i].depth) continue
    // Only the suffix Spark appends to the node: a column can be named anything, "Statistics(sizeInBytes=…)" too.
    const figure = /, Statistics\(sizeInBytes=([^,()]+)(?:, [^()]*)?\)\s*$/.exec(nodes[i].text)?.[1]
    const size = figure === undefined ? undefined : sparkBytes(figure)
    if (size === undefined || size >= SPARK_NO_SIZE) {
      // "Relation main.sales.orders[…] parquet": the table's name, when the leaf is one.
      const relation = /^(?:Relation|HiveTableRelation|LogicalRelation)\s+\[?`?([A-Za-z0-9_.`]+?)`?[\[,\s]/.exec(nodes[i].text)?.[1]
      return relation ? { noStats: true, relation: relation.replace(/`/g, "") } : { noStats: true }
    }
    bytes += size
  }
  return { bytes: Math.round(bytes) }
}

/**
 * The warehouses with no dry run whose planner still says what a query reads, the EXPLAIN that asks it, and the
 * reader of its one row.
 */
const PLANNERS: Record<string, { owner: string; explain: string; read: (row: unknown) => PlanEstimate | { noStats: true; relation?: string } | undefined }> = {
  snowflake: { owner: "Snowflake's", explain: "EXPLAIN USING JSON", read: parseSnowflakeExplain },
  databricks: { owner: "Databricks'", explain: "EXPLAIN COST", read: parseDatabricksExplainCost },
}

/**
 * Inline Jinja that runs the EXPLAIN through dbt's own connection (`run_query`) while dbt compiles it, and
 * renders the first column of its answer as JSON. Compiling, not `dbt show`, since show wraps the query in a
 * limit, which an EXPLAIN can't take. dbt renders an inline query twice: at parse, where `execute` is false and
 * `run_query` returns nothing, the template renders `[]` and runs nothing. The SQL is written into a Jinja
 * string, so its quotes and backslashes are escaped.
 */
export function explainJinja(explain: string, sql: string): string {
  const statement = `${explain}\n${sql.replace(/[\s;]+$/, "")}`
  const literal = `'${statement.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`
  return `{%- if execute -%}{%- set altimate_plan = run_query(${literal}) -%}{{ tojson(altimate_plan.columns[0].values() | list) }}{%- else -%}[]{%- endif -%}`
}

/**
 * Whether the SQL may be more than one statement, as the warehouse's driver splits it: dbt-snowflake runs each
 * statement it splits off, so a second one after the EXPLAIN would run for real. One pass, left to right, that
 * reads only what it models exactly: single- and double-quoted text (a backslash escapes, as the Snowflake
 * connector's splitter reads it), backticks on Databricks, `--` and block comments. Anything else that could hide or fake a separator (Snowflake's `$$` text and `//` comments,
 * Databricks' raw strings and nested comments, an unclosed quote or comment, EXECUTE IMMEDIATE) counts as a
 * script, as does a semicolon with anything but whitespace after it: a doubt is no estimate, never a run.
 */
export function mayBeScript(sql: string, type: string): boolean {
  const databricks = type === "databricks"
  let code = ""
  let i = 0
  while (i < sql.length) {
    const c = sql[i]
    const two = sql.slice(i, i + 2)
    if (two === "--") {
      const end = sql.indexOf("\n", i)
      if (end < 0) break
      i = end + 1
      code += " "
      continue
    }
    if (two === "/*") {
      const end = sql.indexOf("*/", i + 2)
      // Databricks nests block comments, and an unclosed one hides the rest: neither is read.
      if (end < 0 || (databricks && sql.slice(i + 2, end).includes("/*"))) return true
      i = end + 2
      code += " "
      continue
    }
    if (two === "$$" || (!databricks && two === "//")) return true
    // Databricks raw strings (r'…', R"…") do not escape with a backslash: not read.
    if (databricks && /[rR]/.test(c) && /['"]/.test(sql[i + 1] ?? "") && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? "")) return true
    const close = c === "'" || c === '"' || (databricks && c === "`") ? c : null
    if (close) {
      // A backslash escapes in quotes, as the splitter has it (only before a quote or a backslash, which skipping the
      // next character always matches); Databricks' backticks take none.
      const escapes = c !== "`"
      let j = i + 1
      while (j < sql.length && sql[j] !== close) j += escapes && sql[j] === "\\" ? 2 : 1
      if (j >= sql.length) return true
      i = j + 1
      code += " "
      continue
    }
    code += c
    i++
  }
  const semicolon = code.indexOf(";")
  if (semicolon >= 0 && /[^\s;]/.test(code.slice(semicolon))) return true
  return /\bexecute\s+immediate\b/i.test(code)
}

/** Starts `start` and waits for it, but gives up as soon as the call is cancelled; a cancelled call starts nothing. */
export function untilAbort<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason)
    signal.addEventListener("abort", stop, { once: true })
    Promise.resolve()
      .then(() => (signal.aborted ? Promise.reject(signal.reason) : start()))
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", stop))
  })
}

function failure(title: string, message: string, extra: Record<string, unknown> = {}) {
  return { title: `dbt_cost_estimate: ${title}`, metadata: { success: false, error: message, ...extra }, output: message }
}

/** The planner's estimate of a compiled query on a warehouse with no dry run: an EXPLAIN, which compiles the query and runs none of it. */
async function explainEstimate(
  adapter: any,
  type: string,
  planner: (typeof PLANNERS)[string],
  compiled: string,
  model: string | undefined,
  signal: AbortSignal,
) {
  const extra = { adapter: type, source: "explain" }
  // Jinja turns every \r\n and lone \r in a string into \n: the check reads the SQL exactly as the driver will get it.
  const sql = compiled.replace(/\r\n?/g, "\n")
  if (mayBeScript(sql, type)) {
    return failure(
      "no estimate",
      `The query is more than one statement (or may be): ${planner.explain} takes one, and a second would run for real, so it is not estimated.`,
      extra,
    )
  }
  let row: unknown
  try {
    const rendered = await untilAbort(() => adapter.unsafeCompileQuery(explainJinja(planner.explain, sql), undefined), signal)
    const rows = typeof rendered === "string" ? JSON.parse(rendered.trim()) : undefined
    if (!Array.isArray(rows) || rows.length === 0) throw new Error(`${planner.explain} returned no plan`)
    row = rows[0]
  } catch (e) {
    if (signal.aborted) throw e
    return failure("explain failed", `${planner.owner} ${planner.explain} failed: ${e instanceof Error ? e.message : String(e)}`, extra)
  }
  const parsed = planner.read(row)
  if (parsed && "noStats" in parsed) {
    const table = parsed.relation ?? "<table>"
    return failure(
      "no estimate",
      `${planner.owner} planner has no size for ${parsed.relation ?? "a table this query reads"} (it shows Spark's default for a table without statistics). ANALYZE TABLE ${table} COMPUTE STATISTICS NOSCAN records its size from file metadata without reading the data; without NOSCAN, ANALYZE scans the whole table.`,
      extra,
    )
  }
  if (!parsed) {
    return failure("unreadable estimate", `${planner.owner} ${planner.explain} answered a plan this tool can't read.`, extra)
  }
  const shown = formatBytes(parsed.bytes)
  const partitions =
    parsed.partitionsAssigned !== undefined && parsed.partitionsTotal !== undefined
      ? `${parsed.partitionsAssigned} of ${parsed.partitionsTotal} partitions after pruning; `
      : ""
  const accuracy =
    type === "snowflake"
      ? `${partitions}an upper bound: runtime pruning can scan less, and a cached result none`
      : "table sizes before column pruning and file skipping, which usually read less; not a bound either way"
  return {
    title: `dbt_cost_estimate: ${shown}`,
    metadata: {
      success: true,
      supported: true,
      adapter: type,
      source: "explain",
      // Snowflake documents bytesAssigned as an upper bound; Spark's sizes are the planner's guess, either way.
      bound: type === "snowflake" ? "upper" : "estimate",
      bytes: parsed.bytes,
      display: shown,
      ...(parsed.partitionsAssigned !== undefined && { partitionsAssigned: parsed.partitionsAssigned }),
      ...(parsed.partitionsTotal !== undefined && { partitionsTotal: parsed.partitionsTotal }),
      ...(model && { model }),
    },
    output: `${model ? `${model} ` : "The query "}would scan about ${shown}, by ${planner.owner} plan estimate (${accuracy}).`,
  }
}

export const DbtCostEstimateTool = Tool.define("dbt_cost_estimate", {
  description:
    "Estimate the bytes a dbt model or a SQL query would scan, without running it. BigQuery answers from a dry run (`maxBytes` bounds it, or `lowerBound` marks a floor); Snowflake (`EXPLAIN USING JSON`, bytes left after pruning) and Databricks (`EXPLAIN COST`, the sizes of the tables it reads) answer from the planner (`source: \"explain\"`; `bound` is \"upper\" on Snowflake, \"estimate\" on Databricks), and none when Databricks has no table statistics. EXPLAIN compiles the query on the warehouse and scans no data: on Snowflake it needs no running warehouse (cloud-services time only); on Databricks it runs on the SQL warehouse or cluster the profile connects to, and starts it (billed while up) if it is stopped. A query that may be more than one statement is never EXPLAINed. Any other warehouse answers `supported: false` and nothing is compiled. Starts the dbt adapter (which runs `dbt deps`), so it needs write permission (`--allow-write` on `tool run` or the MCP server). The dry run never executes the final query, but compiling either input can render Jinja, and macros such as `run_query` can run real queries that are billed. Pass `model` (a model name, compiled as dbt would) or `sql` (may use Jinja).",
  parameters: z.object({
    model: z.string().optional().describe("Model name to compile and estimate"),
    sql: z.string().optional().describe("SQL (may use Jinja) to compile and estimate"),
  }),
  async execute(args, ctx) {
    if (!args.model && !args.sql) return failure("nothing to estimate", "Pass a model name or SQL.")
    if (args.model && args.sql) return failure("ambiguous input", "Pass a model name or SQL, not both.")
    const access = await dbtAdapterFor(ctx)
    if (!access.adapter) return failure("not available", `No estimate: ${access.reason}.`, { refusal: access.refusal })
    const adapter = access.adapter
    const type: string | undefined = adapter.getAdapterType?.()
    // Every dbt-integration refuses the dry run off BigQuery; elsewhere only a planner EXPLAIN tells the scan. Nothing is compiled for any other warehouse.
    const planner = type ? PLANNERS[type] : undefined
    if (type !== "bigquery" && !planner) {
      const adapterName = type ?? "unknown"
      return {
        title: "dbt_cost_estimate: no estimate",
        metadata: { success: true, supported: false, adapter: adapterName },
        output: `No cost estimate: scan estimates are only available on BigQuery, Snowflake and Databricks (this project uses ${adapterName}).`,
      }
    }
    const signal = ctx.abort
    let compiled: unknown
    try {
      // A model compiles by name, so its node context (`this`, config) is kept; SQL compiles inline.
      compiled = await untilAbort(
        () => (args.model ? adapter.unsafeCompileNode(args.model) : adapter.unsafeCompileQuery(args.sql!, undefined)),
        signal,
      )
    } catch (e) {
      if (signal.aborted) throw e
      return failure("compile failed", e instanceof Error ? e.message : String(e), { adapter: type })
    }
    if (typeof compiled !== "string" || !compiled.trim()) {
      return failure("compile failed", "The query compiled to nothing.", { adapter: type })
    }
    if (planner) return explainEstimate(adapter, type!, planner, compiled, args.model, signal)
    let display: unknown
    try {
      const integration = await untilAbort(async () => {
        const { dbtAdapterInternals } = await import("../native/connections/register")
        const read = dbtAdapterInternals.readConfig ?? (await import("../../../../dbt-tools/src/config")).read
        return ((await read()) as { dbtIntegration?: unknown } | null)?.dbtIntegration
      }, signal)
      const result = await untilAbort(() => adapter.validateSQLDryRun(forDryRun(compiled as string, integration)), signal)
      if (result == null) {
        return failure("dry run failed", "The dry run returned no estimate: dbt-core before 1.6 can't dry run.", { adapter: type })
      }
      display = (result as { bytes_processed?: unknown }).bytes_processed
    } catch (e) {
      if (signal.aborted) throw e
      return failure("dry run failed", e instanceof Error ? e.message : String(e), { adapter: type })
    }
    const parsed = parseBytesProcessed(display)
    if (!parsed) {
      return failure("unreadable estimate", `The dry run returned an amount this tool can't read: ${JSON.stringify(display)}.`, {
        adapter: type,
      })
    }
    const name = args.model
    const shown = typeof display === "number" ? `${parsed.bytes} Bytes` : String(display)
    // A dry run can report 0 for a query that still reads data (BigQuery federated sources), and it skips
    // what a script runs after its first statement or inside EXECUTE IMMEDIATE: those figures are lower
    // bounds and carry no upper bound.
    const zero = parsed.bytes === 0
    const lower = zero || isScript(compiled as string)
    return {
      title: `dbt_cost_estimate: ${shown}`,
      metadata: {
        success: true,
        supported: true,
        adapter: type,
        ...(lower ? { bytes: parsed.bytes, lowerBound: true } : parsed),
        display: shown,
        ...(name && { model: name }),
      },
      output: `${name ? `${name} ` : "The query "}would process ${shown} ${
        lower ? "(a dry run can undercount a script or a zero estimate, so this is a lower bound, not a cap)." : `(at most ${parsed.maxBytes} bytes).`
      }`,
    }
  },
})
