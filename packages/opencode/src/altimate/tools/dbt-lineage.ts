import z from "zod"
import path from "path"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import type { DbtLineageResult } from "../native/types"

/** The structured result of dbt-integration's `getModelLineage` (version 1), relayed as is. */
export type ModelLineage = {
  version: number
  project: string
  dialect: string
  focus: { uniqueId: string; name: string; column?: string }
  nodes: {
    uniqueId: string
    name: string
    type: string
    materialization?: string
    direction: "focus" | "upstream" | "downstream"
    depth: number
    parents: string[]
    columns: { name: string; dataType?: string; isDocumentedOnly?: true }[]
  }[]
  columnLineage: {
    source: [string, string]
    target: [string, string]
    type: string
    viewsType: string
    viewsCode: string[]
  }[]
  confidence: string
  errors: string[]
  stats: Record<string, number>
}

export const DbtLineageTool = Tool.define("dbt_lineage", {
  description:
    "Column-level lineage for a dbt model: its upstream models, seeds and sources, its downstream models, their columns, and the column edges between them across every hop. Pass `column` to trace one column. Uses the project's dbt integration (compiles on demand, no `dbt compile` needed) and returns the result as structured content; without it, reads the compiled SQL in the manifest.",
  parameters: z.object({
    model: z.string().describe("Model name or unique_id (e.g. 'my_model' or 'model.project.my_model')"),
    column: z.string().optional().describe("Trace only this column of the model, upstream and downstream"),
    manifest_path: z
      .string()
      .optional()
      .describe(
        "manifest.json for the manifest-only fallback, read only when the dbt integration isn't available (default: the dbt project's target/manifest.json)",
      ),
    dialect: z.string().optional().describe("SQL dialect override for the manifest-only fallback"),
  }),
  async execute(args, ctx) {
    const viaAdapter = await fromAdapter(args.model, args.column, ctx.abort)
    if (viaAdapter.result) {
      const result = viaAdapter.result
      const what = result.focus.column ? `${result.focus.name}.${result.focus.column}` : result.focus.name
      return {
        title: `dbt Lineage: ${what} [${result.confidence}]`,
        metadata: {
          model_name: result.focus.name,
          confidence: result.confidence,
          structuredContent: result,
        },
        output: formatModelLineage(result),
      }
    }
    const notUsed = viaAdapter.reason ? `dbt integration not used: ${viaAdapter.reason}` : undefined
    const manifestPath = args.manifest_path ?? (await defaultManifestPath())
    ctx.abort.throwIfAborted()
    try {
      const result = await Dispatcher.call("dbt.lineage", {
        manifest_path: manifestPath,
        model: args.model,
        dialect: args.dialect,
      })
      if (notUsed) result.confidence_factors.push(notUsed)
      if (args.column) {
        result.confidence_factors.push(`tracing ${args.column} needs the dbt integration; this is the whole model's lineage`)
      }
      return {
        title: `dbt Lineage: ${result.model_name} [${result.confidence}]`,
        metadata: {
          model_name: result.model_name,
          confidence: result.confidence,
        },
        output: formatDbtLineage(result),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "dbt Lineage: ERROR",
        metadata: { model_name: args.model, confidence: "unknown", error: msg },
        output: `Failed: ${msg}${notUsed ? `\n(${notUsed})` : ""}`,
      }
    }
  },
})

/**
 * The lineage from the project's dbt adapter, which the tool starts in read-only mode too: it
 * compiles and reads column metadata, and runs no user SQL. `reason` says why it wasn't used.
 */
async function fromAdapter(
  model: string,
  column: string | undefined,
  signal: AbortSignal,
): Promise<{ result?: ModelLineage; reason?: string }> {
  try {
    const [{ getDbtAdapter }, { isReadOnlyCall }] = await Promise.all([
      import("../native/connections/register"),
      import("../mcp-server/read-only-calls"),
    ])
    // The imports yield: a call cancelled meanwhile starts nothing.
    signal.throwIfAborted()
    // A read-only call never starts or uses the dbt adapter (the doc comment above predates this):
    // starting it runs dbt deps and writes target/, and compiling renders Jinja, which can run SQL.
    if (isReadOnlyCall(signal)) return { reason: READ_ONLY_REASON }
    // Starting the adapter can take a while (dbt deps, a parse): a cancel doesn't wait for it, and
    // past the deadline the manifest answers. The start goes on, for the next call.
    let stop = () => {}
    let timer: ReturnType<typeof setTimeout> | undefined
    const waited = new Promise<never>((_, reject) => {
      stop = () => reject(signal.reason)
      signal.addEventListener("abort", stop, { once: true })
      const seconds = dbtLineageInternals.adapterStartTimeoutMs / 1000
      timer = setTimeout(
        () => reject(new Error(`the dbt adapter didn't start within ${seconds} s`)),
        dbtLineageInternals.adapterStartTimeoutMs,
      )
    })
    const adapter = await Promise.race([getDbtAdapter(), waited]).finally(() => {
      signal.removeEventListener("abort", stop)
      clearTimeout(timer)
    })
    if (!adapter) return { reason: "no dbt project here" }
    if (adapter.isInitialized?.() === false) return { reason: "the dbt adapter didn't load the project" }
    if (typeof adapter.getModelLineage !== "function") return { reason: "dbt-integration has no getModelLineage" }
    const params = { model, ...(column ? { column } : {}), upstreamDepth: LINEAGE_DEPTH, downstreamDepth: LINEAGE_DEPTH }
    const result: unknown = await adapter.getModelLineage(params, signal)
    // A lookup that finishes after a cancel doesn't answer.
    signal.throwIfAborted()
    if (!isModelLineage(result)) return { reason: "dbt-integration returned a lineage this tool can't read" }
    return { result }
  } catch (e) {
    // A cancelled call stops here rather than starting the manifest fallback.
    if (signal.aborted) throw e
    return { reason: e instanceof Error ? e.message : String(e) }
  }
}

/** Test seams. */
export const dbtLineageInternals = {
  /** How long a call waits for the dbt adapter to start before it answers from the manifest. */
  adapterStartTimeoutMs: 120_000,
}

/** Hops each way the adapter's lineage covers, which bounds the size of the structured result. */
const LINEAGE_DEPTH = 3

const READ_ONLY_REASON =
  "this session is read-only, and starting the dbt integration runs dbt deps and writes target/, and compiling can run SQL from macros"

/** Whether a value has the version-1 shape this tool relays and formats. */
export function isModelLineage(value: unknown): value is ModelLineage {
  const v = value as Partial<ModelLineage> | null
  return (
    typeof v === "object" &&
    v !== null &&
    v.version === 1 &&
    typeof v.project === "string" &&
    typeof v.dialect === "string" &&
    typeof v.confidence === "string" &&
    typeof v.stats === "object" &&
    v.stats !== null &&
    typeof v.focus?.uniqueId === "string" &&
    typeof v.focus?.name === "string" &&
    Array.isArray(v.nodes) &&
    v.nodes.every((n) => typeof n?.uniqueId === "string" && Array.isArray(n.columns)) &&
    Array.isArray(v.columnLineage) &&
    v.columnLineage.every((e) => Array.isArray(e?.source) && Array.isArray(e?.target) && Array.isArray(e?.viewsCode)) &&
    Array.isArray(v.errors)
  )
}

/** target/manifest.json in the project the dbt adapter finds, which may be above the working directory. */
async function defaultManifestPath(): Promise<string> {
  const { getDbtProjectRoot } = await import("../native/connections/register")
  return path.join((await getDbtProjectRoot()) ?? "", "target", "manifest.json")
}

const MAX_TEXT_EDGES = 200

/** A compact reading of the structured result, for clients that show the text. */
export function formatModelLineage(result: ModelLineage): string {
  const byId = new Map(result.nodes.map((n) => [n.uniqueId, n]))
  const label = (id: string) => byId.get(id)?.name ?? id
  const kind = (n: ModelLineage["nodes"][number]) => (n.type === "model" ? (n.materialization ?? "model") : n.type)
  const signedDepth = (id: string) => {
    const n = byId.get(id)
    if (!n) return 0
    return n.direction === "upstream" ? -n.depth : n.depth
  }
  const lines: string[] = []
  const focus = byId.get(result.focus.uniqueId)
  lines.push(
    `Model: ${result.focus.name} (${result.focus.uniqueId})${focus ? ` · ${kind(focus)}` : ""} · confidence ${result.confidence}`,
  )
  for (const direction of ["upstream", "downstream"] as const) {
    const nodes = result.nodes.filter((n) => n.direction === direction)
    lines.push("", `${direction === "upstream" ? "Upstream" : "Downstream"} (${nodes.length}):`)
    if (nodes.length === 0) lines.push("  none")
    for (const n of nodes) lines.push(`  ${"  ".repeat(Math.max(0, n.depth - 1))}${n.name} · ${kind(n)} · depth ${n.depth}`)
  }
  const edges = [...result.columnLineage].sort((a, b) => signedDepth(a.target[0]) - signedDepth(b.target[0]))
  lines.push(
    "",
    result.focus.column
      ? `Trace of ${result.focus.name}.${result.focus.column} (${edges.length} edges):`
      : `Column edges (${edges.length}):`,
  )
  for (const e of edges.slice(0, MAX_TEXT_EDGES)) {
    const code = e.viewsCode.length > 0 ? ` = ${e.viewsCode[e.viewsCode.length - 1]}` : ""
    lines.push(
      `  ${label(e.target[0])}.${e.target[1]} ← ${label(e.source[0])}.${e.source[1]}  [${e.type}, ${e.viewsType}]${code}`,
    )
  }
  if (edges.length > MAX_TEXT_EDGES) lines.push(`  … ${edges.length - MAX_TEXT_EDGES} more in the structured result`)
  const documentedOnly = result.nodes.flatMap((n) =>
    n.columns.filter((c) => c.isDocumentedOnly).map((c) => `${n.name}.${c.name}`),
  )
  if (documentedOnly.length > 0) lines.push("", `Documented but not in the relation: ${documentedOnly.join(", ")}`)
  if (result.errors.length > 0) lines.push("", `Notes: ${result.errors.join("; ")}`)
  return lines.join("\n")
}

function formatDbtLineage(result: DbtLineageResult): string {
  const lines: string[] = []

  lines.push(`Model: ${result.model_name ?? "unknown"}`)
  if (result.model_unique_id) lines.push(`ID: ${result.model_unique_id}`)
  lines.push("")

  if (result.confidence_factors.length > 0) {
    lines.push(`Confidence: ${result.confidence ?? "unknown"}`)
    lines.push(`  Note: ${result.confidence_factors.join("; ")}`)
    lines.push("")
  }

  const lineage = result.raw_lineage
  if (!lineage || Object.keys(lineage).length === 0) {
    lines.push("No lineage data returned.")
    if (!result.compiled_sql) {
      lines.push("Run `dbt compile` first to generate compiled SQL.")
    }
    return lines.join("\n")
  }

  // column_dict: output columns -> source columns mapping
  const columnDict = lineage.column_dict as Record<string, unknown> | undefined
  if (columnDict) {
    lines.push("Column Mappings:")
    for (const [target, sources] of Object.entries(columnDict)) {
      lines.push(`  ${target} ← ${JSON.stringify(sources)}`)
    }
    lines.push("")
  }

  // column_lineage: detailed edge list
  const edges = lineage.column_lineage as unknown[] | undefined
  if (edges?.length) {
    lines.push("Lineage Edges:")
    for (const edge of edges) {
      lines.push(`  ${JSON.stringify(edge)}`)
    }
  }

  if (!columnDict && !edges) {
    lines.push(JSON.stringify(lineage, null, 2))
  }

  return lines.join("\n")
}
