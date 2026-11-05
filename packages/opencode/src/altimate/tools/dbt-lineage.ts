import z from "zod"
import fs from "fs"
import path from "path"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import type { DbtLineageResult } from "../native/types"
import { loadRawManifest } from "../native/dbt/helpers"
import { lineageGraph } from "../native/dbt/graph"
import { projectRoot } from "../native/connections/registry"

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
    "Column-level lineage for a dbt model: its upstream models, seeds and sources, its downstream models, their columns, and the column edges between them. Pass `column` to trace one column. Where writes are allowed, uses the project's dbt integration (compiles on demand, no `dbt compile` needed; up to 3 hops each way) and returns the result as structured content; a read-only call, or one without the integration, reads the compiled SQL in the manifest and traces the model's own SQL.",
  parameters: z.object({
    model: z
      .string()
      .describe("Model name, unique_id or project-relative SQL path (e.g. 'my_model', 'model.project.my_model', 'models/my_model.sql'); a snapshot by name, unique_id or path"),
    column: z.string().optional().describe("Trace only this column of the model, upstream and downstream"),
    manifest_path: z
      .string()
      .optional()
      .describe(
        "manifest.json for the manifest answer, read on a read-only call or when the dbt integration isn't available, and for the graph (default: the dbt project's target/manifest.json)",
      ),
    dialect: z.string().optional().describe("SQL dialect override for the manifest-only fallback"),
    include_graph: z
      .boolean()
      .optional()
      .describe("Also return the model's graph from the manifest (everything upstream and downstream, up to 500 nodes each side; the exposures and tests are those of the model and its downstream, upstream tests are not included; graph.upTruncated / graph.truncated are set when a side is cut) in the metadata; for lineage viewers. Over MCP the graph is left out of the structured result: read it with `altimate tool run dbt_lineage --json`"),
  }),
  async execute(args, ctx) {
    // A call without write permission (MCP, `tool run`) and a plan-mode call are read-only. A subagent
    // started from plan mode runs under its own agent's permissions.
    const readOnly = ctx.extra?.forceReadOnly === true || ctx.agent === "plan"
    // Read once per call, and only when needed: it reads the dbt config.
    let project: ReturnType<typeof sessionProject> | undefined
    const session = () => (project ??= sessionProject())
    let viaAdapter = await fromAdapter(args.model, args.column, ctx.abort, readOnly, session)
    // The adapter answers for the project it found; a manifest named outside that project's folder
    // wins, so its graph and its lineage are never mixed with this one's.
    if (viaAdapter.result && args.manifest_path) {
      const outside = await manifestOutsideAdapterProject(args.manifest_path)
      if (outside) viaAdapter = { reason: outside }
    }
    if (viaAdapter.result) {
      const result = viaAdapter.result
      const what = result.focus.column ? `${result.focus.name}.${result.focus.column}` : result.focus.name
      // A lineage viewer also wants the manifest's graph: exposures and tests sit there, not here.
      const graph = args.include_graph ? manifestGraph(args.manifest_path ?? (await defaultManifestPath(session)), result.focus.uniqueId) : undefined
      return {
        title: `dbt Lineage: ${what} [${result.confidence}]`,
        metadata: {
          model_name: result.focus.name,
          model_unique_id: result.focus.uniqueId,
          confidence: result.confidence,
          structuredContent: result,
          ...(graph?.graph && { graph: graph.graph }),
          ...(graph?.error && { graph_error: graph.error }),
        },
        output: formatModelLineage(result),
      }
    }
    const notUsed = viaAdapter.reason ? `dbt integration not used: ${viaAdapter.reason}` : undefined
    const manifestPath = args.manifest_path ?? (await defaultManifestPath(session))
    ctx.abort.throwIfAborted()
    try {
      const result = await Dispatcher.call("dbt.lineage", {
        manifest_path: manifestPath,
        model: args.model,
        dialect: args.dialect,
        include_graph: args.include_graph,
      })
      if (notUsed) result.confidence_factors.push(notUsed)
      if (args.column) {
        result.confidence_factors.push(`tracing ${args.column} needs the dbt integration; this is the whole model's lineage`)
      }
      const lineage = result.raw_lineage as { column_dict?: Record<string, unknown>; column_lineage?: unknown[] }
      return {
        title: `dbt Lineage: ${result.model_name} [${result.confidence}]`,
        // The same lineage as the text, as data: callers (the MCP server's structured result, the
        // Claude Code plugin's lineage pane) read it here instead of parsing the text.
        metadata: {
          model_name: result.model_name,
          model_unique_id: result.model_unique_id ?? null,
          confidence: result.confidence,
          confidence_factors: result.confidence_factors,
          upstream: result.upstream ?? [],
          columns: lineage?.column_dict ?? {},
          edges: Array.isArray(lineage?.column_lineage) ? lineage.column_lineage : [],
          ...(result.graph && { graph: result.graph }),
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
 * Why a named manifest is not the adapter's project's, or undefined when it is: it must lie in that
 * project's folder (links resolved) with no other dbt_project.yml between (a nested project or an
 * installed package is another project). A manifest not written yet (an uncompiled project) is placed
 * by its path, its nearest existing folder's links resolved, so the project's own default path keeps
 * the adapter's answer; one with no dbt project above it at all (a default path resolved against
 * another folder) names no other project either. A link to a manifest not written yet is placed where
 * it points.
 */
async function manifestOutsideAdapterProject(manifestPath: string): Promise<string | undefined> {
  const { getDbtProjectRoot } = await import("../native/connections/register")
  const root = await getDbtProjectRoot()
  if (!root) return "the dbt adapter has no project root"
  // The path with its links resolved, the parts not written yet appended; a link to a missing file is
  // followed to where it points. `..` is collapsed first, as the manifest reader (loadRawManifest's
  // realpathSync) does, so this places the file that reader opens. Undefined past 64 links (a loop);
  // climbing to the nearest existing folder is not counted.
  const real = (p: string) => {
    const rest: string[] = []
    let at = path.resolve(p)
    for (let links = 0; links < 64; ) {
      try {
        return path.join(fs.realpathSync(at), ...rest)
      } catch {}
      let link: string | undefined
      try {
        if (fs.lstatSync(at).isSymbolicLink()) link = fs.readlinkSync(at)
      } catch {}
      if (link !== undefined) {
        links++
        // From the link's real folder, as the system resolves it: `..` climbs from there.
        at = path.resolve(fs.realpathSync(path.dirname(at)), link)
        continue
      }
      if (path.dirname(at) === at) return undefined
      rest.unshift(path.basename(at))
      at = path.dirname(at)
    }
    return undefined
  }
  const projectDir = real(root)
  const manifest = real(manifestPath)
  if (!projectDir || !manifest) return `the manifest ${manifestPath} cannot be placed`
  const inside = path.relative(projectDir, manifest)
  // Outside the project: the relative path climbs out (`..` as a whole segment, so `..data/` is inside).
  if (!inside || inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
    if (!fs.existsSync(manifest) && !projectAbove(manifest)) return undefined
    return `the manifest ${manifestPath} is not in the dbt project at ${root}`
  }
  // The manifest is inside, so walking up from it reaches the project folder itself.
  for (let dir = path.dirname(manifest); dir !== projectDir && dir !== path.dirname(dir); dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "dbt_project.yml"))) return `the manifest ${manifestPath} belongs to the dbt project at ${dir}`
  }
  return undefined
}

/** Whether a dbt_project.yml sits in any folder above a path. */
function projectAbove(file: string): boolean {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "dbt_project.yml"))) return true
    if (path.dirname(dir) === dir) return false
  }
}

/** The model's graph from the compiled manifest, or why there is none. */
function manifestGraph(manifestPath: string, uniqueId: string): { graph?: ReturnType<typeof lineageGraph>; error?: string } {
  try {
    const manifest = loadRawManifest(manifestPath)
    return manifest ? { graph: lineageGraph(manifest, uniqueId) } : { error: `no manifest at ${manifestPath}` }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * The lineage from the project's dbt adapter, used only where writes are allowed: starting it runs
 * dbt deps and writes target/, and it compiles and reads column metadata. A read-only call never
 * starts or uses it, nor does a session in a dbt project the adapter isn't set up for (another
 * project's, or none). `reason` says why it wasn't used.
 */
async function fromAdapter(
  model: string,
  column: string | undefined,
  signal: AbortSignal,
  readOnly: boolean,
  session: () => ReturnType<typeof sessionProject>,
): Promise<{ result?: ModelLineage; reason?: string }> {
  try {
    const { getDbtAdapter, getDbtProjectRoot } = await import("../native/connections/register")
    // The import yields: a call cancelled meanwhile starts nothing.
    signal.throwIfAborted()
    // A read-only call never starts or uses the dbt adapter: starting it runs dbt deps and writes
    // target/, and compiling renders Jinja, which can run SQL.
    // It answers from the manifest with no note: there's nothing for the user to fix.
    if (readOnly) return {}
    const project = await session()
    // Reading the dbt config yields too.
    signal.throwIfAborted()
    if (project?.other) {
      return {
        reason: project.root
          ? `the dbt adapter is set up for ${project.root}, not ${project.other}`
          : `the dbt adapter isn't set up for ${project.other}`,
      }
    }
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
    if (!adapter) {
      // No adapter also when the project exists but the adapter failed to start: say which.
      const root = await getDbtProjectRoot()
      const found = !!root && fs.existsSync(path.join(root, "dbt_project.yml"))
      return { reason: found ? "the dbt adapter didn't start" : "no dbt project here" }
    }
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
    !Array.isArray(v.stats) &&
    Object.values(v.stats).every((n) => Number.isFinite(n)) &&
    typeof v.focus?.uniqueId === "string" &&
    typeof v.focus?.name === "string" &&
    optional(v.focus.column, "string") &&
    Array.isArray(v.nodes) &&
    v.nodes.every(
      (n) =>
        typeof n?.uniqueId === "string" &&
        typeof n.name === "string" &&
        typeof n.type === "string" &&
        optional(n.materialization, "string") &&
        (n.direction === "focus" || n.direction === "upstream" || n.direction === "downstream") &&
        // Hops from the focus: at most what was asked for.
        Number.isInteger(n.depth) &&
        n.depth >= 0 &&
        n.depth <= LINEAGE_DEPTH &&
        Array.isArray(n.parents) &&
        n.parents.every((p) => typeof p === "string") &&
        Array.isArray(n.columns) &&
        n.columns.every(
          (c) =>
            typeof c?.name === "string" &&
            optional(c.dataType, "string") &&
            (c.isDocumentedOnly === undefined || c.isDocumentedOnly === true),
        ),
    ) &&
    Array.isArray(v.columnLineage) &&
    v.columnLineage.every(
      (e) =>
        isPair(e?.source) &&
        isPair(e?.target) &&
        typeof e.type === "string" &&
        typeof e.viewsType === "string" &&
        Array.isArray(e.viewsCode) &&
        e.viewsCode.every((code) => typeof code === "string"),
    ) &&
    Array.isArray(v.errors) &&
    v.errors.every((error) => typeof error === "string")
  )
}

/** An optional field: absent, or of the type. */
function optional(value: unknown, type: "string"): boolean {
  return value === undefined || typeof value === type
}

/** A [node id, column] pair, as the lineage's edges name each end. */
function isPair(value: unknown): value is [string, string] {
  return Array.isArray(value) && value.length === 2 && value.every((part) => typeof part === "string")
}

/**
 * target/manifest.json in the project the dbt adapter finds, which may be above the session's
 * directory, or in the session's own project when that is another one.
 */
async function defaultManifestPath(session: () => ReturnType<typeof sessionProject>): Promise<string> {
  const project = await session()
  const root = project ? (project.other ?? project.root) : await (await import("../native/connections/register")).getDbtProjectRoot()
  return path.join(root ?? "", "target", "manifest.json")
}

/**
 * The adapter's project root and, when the session's directory is in another dbt project, that one
 * (`other`, both links resolved): a dbt.json saved for one project, or a server started in one,
 * doesn't answer for a session in another. Undefined, the dbt config not read, when the session's
 * directory is in no dbt project: the adapter's own discovery (a dbt.json, or a walk up from the
 * process's working directory) decides then.
 */
async function sessionProject(): Promise<{ root?: string; other?: string } | undefined> {
  const { findProjectRoot } = await import("../../../../dbt-tools/src/config")
  const found = findProjectRoot(projectRoot())
  if (!found) return undefined
  const { getDbtProjectRoot } = await import("../native/connections/register")
  const root = await getDbtProjectRoot()
  const real = (p: string) => {
    try {
      return fs.realpathSync(p)
    } catch {
      return path.resolve(p)
    }
  }
  const here = real(found)
  // path.relative ignores case on win32.
  if (!root) return { other: here }
  return path.relative(real(root), here) ? { root: real(root), other: here } : { root }
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
