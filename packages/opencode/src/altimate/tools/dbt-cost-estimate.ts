import z from "zod"
import { Tool } from "../../tool/tool"
import { dbtAdapterFor } from "./dbt-adapter-access"
import {
  bigqueryOnDemandRate,
  cleanRates,
  costHistoryInternals,
  costText,
  loadHistory,
  manifestPathFor,
  onDemandPrice,
  type CostConfig,
  type History,
} from "./dbt-cost-history"

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

/** Whether the SQL is a script (more than one statement, or EXECUTE IMMEDIATE): a dry run only sees its first statements. */
export function isScript(sql: string): boolean {
  // One pass over comments and quoted text together: a quote inside a comment, or a comment marker inside a quote, is not either.
  const bare = sql
    .replace(/--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`/g, " ")
    .replace(/;\s*$/, "")
  return bare.includes(";") || /\bexecute\s+immediate\b/i.test(bare)
}

/**
 * The byte count in a dry run's `bytes_processed`, which dbt-bigquery formats as text ("4.2 TiB",
 * "512.0 Bytes"), and the most it can be. The text carries one decimal, so a figure past a byte is
 * rounded: the true count is within half a tenth of its unit. Undefined for anything else, so a changed
 * format is reported, never read as a count.
 */
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

/** The only warehouse that is estimated. */
const ADAPTER = "bigquery"

function failure(title: string, message: string, extra: Record<string, unknown> = {}) {
  return { title: `dbt_cost_estimate: ${title}`, metadata: { success: false, error: message, ...extra }, output: message }
}

/** The pre-run scan figure for the compiled model or SQL: a BigQuery dry run. */
async function scanEstimate(adapter: any, args: { model?: string; sql?: string }, signal: AbortSignal) {
  let compiled: unknown
  try {
    // A model compiles by name, so its node context (`this`, config) is kept; SQL compiles inline.
    compiled = await untilAbort(
      () => (args.model ? adapter.unsafeCompileNode(args.model) : adapter.unsafeCompileQuery(args.sql!, undefined)),
      signal,
    )
  } catch (e) {
    if (signal.aborted) throw e
    return failure("compile failed", e instanceof Error ? e.message : String(e), { adapter: ADAPTER })
  }
  if (typeof compiled !== "string" || !compiled.trim()) {
    return failure("compile failed", "The query compiled to nothing.", { adapter: ADAPTER })
  }
  let display: unknown
  try {
    const integration = await untilAbort(async () => {
      const { dbtAdapterInternals } = await import("../native/connections/register")
      const read = dbtAdapterInternals.readConfig ?? (await import("../../../../dbt-tools/src/config")).read
      return ((await read()) as { dbtIntegration?: unknown } | null)?.dbtIntegration
    }, signal)
    const result = await untilAbort(() => adapter.validateSQLDryRun(forDryRun(compiled as string, integration)), signal)
    if (result == null) {
      return failure("dry run failed", "The dry run returned no estimate: dbt-core before 1.6 can't dry run.", { adapter: ADAPTER })
    }
    display = (result as { bytes_processed?: unknown }).bytes_processed
  } catch (e) {
    if (signal.aborted) throw e
    return failure("dry run failed", e instanceof Error ? e.message : String(e), { adapter: ADAPTER })
  }
  const parsed = parseBytesProcessed(display)
  if (!parsed) {
    return failure("unreadable estimate", `The dry run returned an amount this tool can't read: ${JSON.stringify(display)}.`, {
      adapter: ADAPTER,
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
      adapter: ADAPTER,
      ...(lower ? { bytes: parsed.bytes, lowerBound: true } : parsed),
      display: shown,
      ...(name && { model: name }),
    },
    output: `${name ? `${name} ` : "The query "}would process ${shown} ${
      lower
        ? "(a dry run can undercount a script or a zero estimate, so this is a lower bound, not a cap)."
        : `(bytes processed by the dry run, at most ${parsed.maxBytes}; BigQuery bills at least 10 MiB per query).`
    }`,
  }
}

/** The scan result with the cost put in front: what earlier runs cost, and on BigQuery on-demand what the SELECT would. */
function withCost(
  scan: { title: string; metadata: Record<string, unknown>; output: string },
  loaded: { cfg: CostConfig; history: History },
) {
  const { cfg, history } = loaded
  const cost = { ...history.cost, notes: [...history.cost.notes] }
  const meta = scan.metadata
  if (meta.success === true && typeof meta.bytes === "number") {
    if (history.capacity === true) {
      cost.notes.push("The project is on capacity pricing (slots): scanned bytes do not set the cost, so the dry run is not priced.")
      // With no priced run there is no cost to state a rate for, and the on-demand rate does not apply to a reservation.
      if (cost.basis === "none") cost.rate = null
    } else if (history.capacity === undefined) {
      // Neither the project's jobs nor the caller's own could say which pricing applies: a price would be a guess.
      const why = "BigQuery pricing mode could not be read (on-demand vs reservations)"
      if (cost.basis === "none") cost.unknownReason = cost.unknownReason ? `${cost.unknownReason} ${why}.` : why
      else cost.notes.push(`${why}, so the dry run is not priced.`)
    } else if (meta.lowerBound === true || typeof meta.maxBytes !== "number") {
      // A zero estimate is not a size (BigQuery reports 0 for a federated or external source); a script's dry run saw only its first statement.
      cost.notes.push(
        meta.bytes === 0
          ? "The dry run reported 0 bytes, which BigQuery also reports for sources it cannot size (federated and external tables), so it is not priced."
          : "The dry run covers only the first statement, so it is not priced.",
      )
    } else {
      const demand = bigqueryOnDemandRate(cfg)
      // Without a table count (SQL input, no manifest, an ambiguous name) or with none found, one table is assumed.
      const counted = history.tables
      const used = Math.max(1, counted ?? 1)
      // The count is a floor when it is unknown or a source may be a view, so the high figure is no ceiling.
      const open = counted === undefined || counted === 0 || Boolean(history.sources)
      const price = onDemandPrice({ maxBytes: meta.maxBytes, tables: used, usdPerTib: demand.rate.value })
      cost.selectOnly = open ? { ...price, perTable: onDemandPrice({ maxBytes: 0, tables: 1, usdPerTib: demand.rate.value }).low } : price
      if (!cost.rate) {
        cost.rate = demand.rate
        if (demand.note) cost.notes.push(demand.note)
      }
      const why =
        counted === undefined
          ? `: ${history.tablesReason ?? "the tables could not be counted"}, so at least one is assumed`
          : counted === 0
            ? ": none was found in the manifest, so one is assumed"
            : ""
      cost.notes.push(`The price covers the SELECT only, and each table it reads bills at least 10 MiB (${used} table${used === 1 ? "" : "s"} counted${why}).`)
      if (history.sources) cost.notes.push("A source that is a view in BigQuery bills 10 MiB more for each table it reads.")
    }
    if (history.materialized === "incremental")
      cost.notes.push(
        "This model is incremental: depending on its strategy (merge, delete+insert, insert_overwrite) a run can also write a temp table and read the target, which a scan figure for the SELECT leaves out.",
      )
  }
  if (cost.basis === "none" && cost.selectOnly !== undefined) {
    cost.basis = "dry_run"
    if (cost.unknownReason) cost.notes.unshift(cost.unknownReason)
    delete cost.unknownReason
  }
  return { ...scan, metadata: { ...meta, cost }, output: `${costText(cost)}\n${scan.output}` }
}

export const DbtCostEstimateTool = Tool.define("dbt_cost_estimate", {
  description:
    "Estimate what a BigQuery dbt model costs, and the bytes it or a SQL query would scan, without running it. BigQuery only: any other warehouse answers `supported: false` and nothing is compiled. The cost (`cost`, in the metadata and first in the text) is the warehouse's reported usage for the model's runs in the last 30 days (bytes billed or slot time from INFORMATION_SCHEMA.JOBS) priced at a stated rate, which can be a default or a configured rate, so it is an estimate and not an invoice amount; it is never invented when no history exists; only on-demand pricing prices the pre-run scan, as a range for the SELECT only; a `sql` input has no history. The scan figure comes from a dry run (`maxBytes` bounds it, or `lowerBound` marks a floor). Starts the dbt adapter (which runs `dbt deps`), so it needs write permission (`--allow-write` on `tool run` or the MCP server). The dry run never executes the final query, but compiling either input can render Jinja, and macros such as `run_query` can run real queries that are billed. Pass `model` (a model name, compiled as dbt would) or `sql` (may use Jinja).",
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
    // Every dbt integration refuses the dry run off BigQuery, so nothing is compiled for any other warehouse.
    if (type !== "bigquery") {
      const adapterName = type ?? "unknown"
      return {
        title: "dbt_cost_estimate: no estimate",
        metadata: { success: true, supported: false, adapter: adapterName },
        output: `No cost estimate: cost estimates are only available on BigQuery (this project uses ${adapterName}).`,
      }
    }
    const signal = ctx.abort
    // The Python bridge serialises adapter calls: the scan figure completes first, then the history is read
    // within its own deadline, which can never affect the figure already computed.
    const scan = await scanEstimate(adapter, args, signal)
    const cfg = cleanRates(await costHistoryInternals.readCostConfig())
    const { getDbtProjectRoot } = await import("../native/connections/register")
    const manifestPath = manifestPathFor(adapter, await getDbtProjectRoot().catch(() => undefined))
    const history = await loadHistory({ adapter, model: args.model, manifestPath, signal, cfg })
    return withCost(scan, { cfg, history })
  },
})
