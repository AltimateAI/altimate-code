import z from "zod"
import { Tool } from "../../tool/tool"
import { dbtAdapterFor } from "./dbt-adapter-access"

/** The units dbt-bigquery's `format_bytes` writes, smallest first; each is 1024 times the one before. */
const UNITS = ["Bytes", "KiB", "MiB", "GiB", "TiB", "PiB"] as const

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
function untilAbort<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
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

export const DbtCostEstimateTool = Tool.define("dbt_cost_estimate", {
  description:
    "Estimate the bytes a dbt model or a SQL query would scan, from a warehouse dry run. Only BigQuery has a dry run: any other warehouse answers `supported: false` and nothing is compiled. Starts the dbt adapter, so it needs write permission (`--allow-write` on `tool run`). Pass `model` (a model name, compiled as dbt would) or `sql` (may use Jinja).",
  parameters: z.object({
    model: z.string().optional().describe("Model name to compile and estimate"),
    sql: z.string().optional().describe("SQL (may use Jinja) to compile and estimate"),
  }),
  async execute(args, ctx) {
    if (!args.model && !args.sql) return failure("nothing to estimate", "Pass a model name or SQL.")
    const access = await dbtAdapterFor(ctx)
    if (!access.adapter) return failure("not available", `No estimate: ${access.reason}.`, { refusal: access.refusal })
    const adapter = access.adapter
    const type: string | undefined = adapter.getAdapterType?.()
    // Every dbt-integration refuses the dry run off BigQuery, so nothing is compiled there.
    if (type !== "bigquery") {
      const adapterName = type ?? "unknown"
      return {
        title: "dbt_cost_estimate: no estimate",
        metadata: { success: true, supported: false, adapter: adapterName },
        output: `No cost estimate: dry runs are only available on BigQuery (this project uses ${adapterName}).`,
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
    let display: unknown
    try {
      const result = await untilAbort(() => adapter.validateSQLDryRun(compiled), signal)
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
    return {
      title: `dbt_cost_estimate: ${shown}`,
      metadata: { success: true, supported: true, adapter: type, ...parsed, display: shown, ...(name && { model: name }) },
      output: `${name ? `${name} ` : "The query "}would process ${shown} (at most ${parsed.maxBytes} bytes).`,
    }
  },
})
