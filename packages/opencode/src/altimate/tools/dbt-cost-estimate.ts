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

/**
 * A plan with no size for a leaf: `relation` names it when the plan does, and `unread` marks a leaf that printed no
 * size this parser could read (as opposed to Spark's default size for a table without statistics).
 */
export type NoStats = { noStats: true; relation?: string; unread?: true }

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

/** Whether a node's text has more opening brackets than closing ones: its line continues on the next. */
function opensBracket(text: string): boolean {
  let open = 0
  for (const c of text) open += c === "(" || c === "[" ? 1 : c === ")" || c === "]" ? -1 : 0
  return open > 0
}

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
export function parseDatabricksExplainCost(plan: unknown): PlanEstimate | NoStats | undefined {
  if (typeof plan !== "string") return undefined
  const lines = plan.replace(/\r\n?/g, "\n").split("\n")
  const start = lines.findIndex((line) => /^\s*==\s*Optimized Logical Plan\s*==\s*$/i.test(line))
  if (start < 0) return undefined
  const nodes: { depth: number; text: string }[] = []
  for (const line of lines.slice(start + 1)) {
    // Only Spark's own section headers end the plan: a line of a multi-line node could look like one. A header
    // while the node above still has an open bracket is the rest of that node (a literal holding a line break).
    if (SPARK_SECTION.test(line) && !(nodes.length > 0 && opensBracket(nodes[nodes.length - 1].text))) break
    if (!line.trim()) continue
    // Each level of the tree is three characters: ":  " or "   " for an ancestor, ":- " or "+- " for the node itself.
    const prefix = /^(?::  |   )*(?:[:+]- )?/.exec(line)![0]
    // A tree has one root: a later line with no prefix is the rest of the node above it (a literal with a line break).
    if (!prefix && nodes.length > 0) {
      nodes[nodes.length - 1].text += `\n${line}`
      continue
    }
    nodes.push({ depth: prefix.length / 3, text: line.slice(prefix.length) })
  }
  if (nodes.length === 0) return undefined
  // A node has a child when a later node sits one level below it before the tree comes back up to its level. An inner
  // plan (a subquery) is printed two levels below, so a node holding one and no child is still a leaf.
  const hasChild = nodes.map(() => false)
  const open: number[] = []
  nodes.forEach((node, i) => {
    while (open.length > 0 && nodes[open[open.length - 1]].depth >= node.depth) open.pop()
    if (open.length > 0 && nodes[open[open.length - 1]].depth === node.depth - 1) hasChild[open[open.length - 1]] = true
    open.push(i)
  })
  let bytes = 0
  for (let i = 0; i < nodes.length; i++) {
    if (hasChild[i]) continue
    // Only the suffix Spark appends to the node: a column can be named anything, "Statistics(sizeInBytes=…)" too.
    const figure = /, Statistics\(sizeInBytes=([^,()]+)(?:, [^()]*)?\)\s*$/.exec(nodes[i].text)?.[1]
    const size = figure === undefined ? undefined : sparkBytes(figure)
    if (size === undefined || size >= SPARK_NO_SIZE) {
      // "Relation main.sales.orders[…] parquet": Spark prints the name unquoted, so only a plain one (letters, digits,
      // underscores, dots) right before the column list is surely the whole name; any other gives none.
      const relation = /^Relation ([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\[/.exec(nodes[i].text)?.[1]
      const unread = size === undefined ? { unread: true as const } : {}
      return { noStats: true, ...(relation && { relation }), ...unread }
    }
    bytes += size
  }
  return { bytes: Math.round(bytes) }
}

/**
 * Whether a Databricks query reads files rather than tables (read_files, cloud_files, a path such as json.`…`):
 * planning one can read the files to infer their schema. Read on the code `scanSql` leaves (comments and quoted text
 * as spaces, backtick-quoted names kept), with any spacing between a name and what follows. Anything the scanner
 * does not read counts.
 */
export function readsFiles(sql: string): boolean {
  const { script, code } = scanSql(sql, "databricks")
  if (script) return true
  // A function call, qualified or not (system.builtin.read_files).
  if (/(^|[^a-z0-9_])`?(read_files|cloud_files)`?\s*\(/i.test(code)) return true
  // A known format over any backtick-quoted name, unless the format word is the middle of a dotted name (main.json.`t`).
  // Where a relation goes cannot be told from a column without parsing (FROM (json.`x`), FROM`json`.`x`), so a
  // column qualified by an alias named like a format (json.`order-id`) is refused too: no estimate, never a missed read.
  const formats = "json|csv|parquet|avro|orc|text|binaryfile|xml|libsvm|image"
  if (new RegExp(`(?:(^|[^a-z0-9_.\`])(${formats})|(^|[^.\`])\`(${formats})\`)\\s*\\.\\s*\``, "i").test(code)) return true
  // Any backtick-quoted name that looks like a path ("/" or ":", as in s3://…, dbfs:/…, /Volumes/…), whatever the source
  // before it (a format, a provider class) or a doubled backtick inside it, unless it directly follows Delta's own
  // provider: a source over files can infer its schema from them.
  const rest = code.replace(/(^|[^a-z0-9_.`])`?delta`?\s*\.\s*`[^`]*`/gi, "$1 ")
  return /`[^`]*[/:][^`]*`/.test(rest)
}

/**
 * The warehouses with no dry run whose planner still says what a query reads, the EXPLAIN that asks it, and the
 * reader of its one row.
 */
const PLANNERS: Record<string, { owner: string; explain: string; read: (row: unknown) => PlanEstimate | NoStats | undefined }> = {
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
 * The SQL up to its first semicolon outside quotes and comments. Past one `mayBeScript` allows only whitespace,
 * semicolons and comments, which the driver would still split off and send as a statement of their own
 * (`select 1; /* a\nb *\/`, `select 1;; -- c`): none of it is sent. Read for SQL `mayBeScript` accepted, so the
 * quotes and comments it models are the only ones there are.
 */
export function firstStatement(sql: string, type: string): string {
  const databricks = type === "databricks"
  let i = 0
  while (i < sql.length) {
    const c = sql[i]
    const two = sql.slice(i, i + 2)
    if (two === "--") {
      const end = sql.indexOf("\n", i)
      if (end < 0) break
      i = end + 1
    } else if (two === "/*") {
      const end = sql.indexOf("*/", i + 2)
      if (end < 0) break
      i = end + 2
    } else if (c === "'" || c === '"' || (databricks && c === "`")) {
      let j = i + 1
      while (j < sql.length && sql[j] !== c) j += c !== "`" && sql[j] === "\\" ? 2 : 1
      i = j + 1
    } else if (c === ";") {
      return sql.slice(0, i)
    } else i++
  }
  return sql
}

/**
 * Whether the SQL may be more than one statement, as the warehouse's driver splits it: dbt-snowflake runs each
 * statement it splits off, so a second one after the EXPLAIN would run for real. One pass, left to right, that
 * reads only what it models exactly: single- and double-quoted text (a backslash escapes, as the Snowflake
 * connector's splitter reads it), backticks on Databricks, `--` and block comments. Anything else that could hide or
 * fake a separator (Snowflake's `$$` text, `//` comments and `!` commands at a line's start, raw strings, nested
 * comments, an unclosed quote or comment, EXECUTE IMMEDIATE) counts as a script, as does a semicolon with anything but whitespace after it: a doubt is no estimate, never a run.
 */
export function mayBeScript(input: string, type: string): boolean {
  return scanSql(input, type).script
}

/**
 * The one reading of the SQL both checks share: whether it may be a script (see `mayBeScript`), and its code with
 * comments and quoted text as spaces and Databricks' backtick-quoted names kept as written.
 */
export function scanSql(input: string, type: string): { script: boolean; code: string } {
  const script = { script: true, code: "" }
  // Read with the line breaks Jinja renders: every \r\n and lone \r is \n.
  const sql = input.replace(/\r\n?/g, "\n")
  const databricks = type === "databricks"
  // The Snowflake splitter yields a line starting with "!" as a command of its own, wherever it sits: never read.
  if (!databricks && /(^|\n)!/.test(sql)) return script
  let code = ""
  // Past a semicolon only whitespace and comments may follow: anything else, quoted or not, is a second statement.
  let ended = false
  let i = 0
  while (i < sql.length) {
    const c = sql[i]
    const two = sql.slice(i, i + 2)
    if (two === "--") {
      const end = sql.indexOf("\n", i)
      // Spark continues a line comment past a backslash at its end: not read.
      if (databricks && end >= 0 && sql[end - 1] === "\\") return script
      if (end < 0) break
      i = end + 1
      code += " "
      continue
    }
    if (two === "/*") {
      const end = sql.indexOf("*/", i + 2)
      // Databricks nests block comments, and an unclosed one hides the rest: neither is read, on either warehouse.
      // The closer's star counts too: in "/*/*/" an opener overlaps it.
      if (end < 0 || sql.slice(i + 2, end + 1).includes("/*")) return script
      i = end + 2
      code += " "
      continue
    }
    if (two === "$$" || (!databricks && two === "//")) return script
    // Databricks raw strings (r'…', R"…") do not escape with a backslash: not read.
    if (databricks && /[rR]/.test(c) && /['"]/.test(sql[i + 1] ?? "") && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? "")) return script
    if (ended && !/[\s;]/.test(c)) return script
    if (c === ";") ended = true
    const close = c === "'" || c === '"' || (databricks && c === "`") ? c : null
    if (close) {
      // A backslash escapes in quotes, as the splitter has it (only before a quote or a backslash, which skipping the
      // next character always matches); Databricks' backticks take none.
      const escapes = c !== "`"
      let j = i + 1
      while (j < sql.length && sql[j] !== close) j += escapes && sql[j] === "\\" ? 2 : 1
      if (j >= sql.length) return script
      // A backtick-quoted name is code; quoted text is not.
      code += c === "`" ? sql.slice(i, j + 1) : " "
      i = j + 1
      continue
    }
    code += c
    i++
  }
  return { script: /\bexecute\s+immediate\b/i.test(code), code }
}

/** Test seams. */
export const dbtCostEstimateInternals = {
  /** How long a call waits for a planner's EXPLAIN before it gives up; the plugin's own wait is 120 s. */
  explainTimeoutMs: 90_000,
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
  adapter: { unsafeCompileQuery(sql: string, model?: string): Promise<unknown> },
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
  // Databricks infers the schema of files a query reads directly by reading them, while it plans: an EXPLAIN would.
  if (type === "databricks" && readsFiles(sql)) {
    return failure(
      "no estimate",
      "The query reads files directly (read_files, cloud_files or a path such as json.`…`): Databricks infers their schema by reading them while it plans, so an EXPLAIN is not run for it.",
      extra,
    )
  }
  let row: unknown
  // The EXPLAIN is bounded like the dbt adapter's start: a call that outlasts the deadline stops waiting for it (the
  // adapter takes no signal, so the statement itself runs on) and a cancelled call stops at once.
  const deadline = new AbortController()
  const timer = setTimeout(
    () => deadline.abort(new Error(`${planner.explain} did not answer within ${dbtCostEstimateInternals.explainTimeoutMs / 1000} s`)),
    dbtCostEstimateInternals.explainTimeoutMs,
  )
  try {
    const rendered = await untilAbort(
      () => adapter.unsafeCompileQuery(explainJinja(planner.explain, firstStatement(sql, type)), undefined),
      AbortSignal.any([signal, deadline.signal]),
    )
    const rows = typeof rendered === "string" ? JSON.parse(rendered.trim()) : undefined
    if (!Array.isArray(rows) || rows.length === 0) throw new Error(`${planner.explain} returned no plan`)
    row = rows[0]
  } catch (e) {
    if (signal.aborted) throw e
    return failure("explain failed", `${planner.owner} ${planner.explain} failed: ${e instanceof Error ? e.message : String(e)}`, extra)
  } finally {
    clearTimeout(timer)
  }
  const parsed = planner.read(row)
  if (parsed && "noStats" in parsed) {
    const table = parsed.relation ?? "<table>"
    // A leaf that printed no readable size (rather than Spark's default) is not known to lack statistics: no advice.
    if (parsed.unread) {
      return failure(
        "no estimate",
        `${planner.owner} ${planner.explain} printed no size this tool can read for ${parsed.relation ?? "a table this query reads"}, so it is not estimated.`,
        extra,
      )
    }
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
  // Snowflake may give 0 for a source it cannot size when it compiles (an external table, a stage): not a cap.
  const unsized = type === "snowflake" && parsed.bytes === 0
  const accuracy = unsized
    ? "Snowflake also reports 0 for a source it cannot size at compile time, such as an external table or a stage, so this is not a cap"
    : type === "snowflake"
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
      bound: unsized ? "unknown" : type === "snowflake" ? "upper" : "estimate",
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
    "Estimate the bytes a dbt model or a SQL query would scan, without running it. BigQuery answers from a dry run (`maxBytes` bounds it, or `lowerBound` marks a floor); Snowflake (`EXPLAIN USING JSON`, bytes left after pruning) and Databricks (`EXPLAIN COST`, the sizes of the tables it reads) answer from the planner (`source: \"explain\"`; `bound` is \"upper\" on Snowflake (\"unknown\" when it reports 0, which it also does for a source it cannot size), \"estimate\" on Databricks), and none when Databricks has no table statistics. EXPLAIN compiles the query on the warehouse and scans no data: on Snowflake it needs no running warehouse (cloud-services time only); on Databricks it runs on the SQL warehouse or cluster the profile connects to, and starts it (billed while up) if it is stopped. A query that may be more than one statement is never EXPLAINed, nor on Databricks one that reads files directly (read_files, cloud_files, json.`path`), whose planning reads the files to infer a schema. Any other warehouse answers `supported: false` and nothing is compiled. Starts the dbt adapter (which runs `dbt deps`), so it needs write permission (`--allow-write` on `tool run` or the MCP server). The dry run never executes the final query, but compiling either input can render Jinja, and macros such as `run_query` can run real queries that are billed. Pass `model` (a model name, compiled as dbt would) or `sql` (may use Jinja).",
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
