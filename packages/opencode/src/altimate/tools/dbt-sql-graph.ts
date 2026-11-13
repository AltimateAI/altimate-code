import z from "zod"
import crypto from "crypto"
import fs from "fs"
import path from "path"
import { Tool } from "../../tool/tool"
import {
  sqlLineage,
  type SqlLineageModelNode,
  type SqlLineageRequest,
  type SqlLineageResponse,
} from "../api/sql-lineage"
import { dbtAdapterFor } from "./dbt-adapter-access"

const FINAL_SELECT = "__final_select__"

export type SqlGraphNode = {
  name: string
  /** The backend's node type ("cte", "table", ...); a relation that maps to a dbt node carries its resource type ("model", "source", ...). */
  type: string
  nodeId?: string
  sql: string
  columns: { name: string; datatype?: string; expression?: string }[]
}

export type SqlGraph = { nodes: SqlGraphNode[]; edges: [string, string][] }

type ManifestNode = {
  unique_id: string
  name: string
  alias: string
  resource_type: string
  path?: string
  database: string
  schema: string
  columns: SqlLineageModelNode["columns"]
}
type ManifestSource = {
  name: string
  database: string
  schema: string
  tables: { name: string; identifier: string; path?: string; columns: SqlLineageModelNode["columns"] }[]
}

/** The slice of dbt-integration's adapter this tool uses. */
export type SqlGraphAdapter = {
  parseManifest(): Promise<
    | {
        nodeMetaMap: {
          lookupByUniqueId(id: string): ManifestNode | undefined
          lookupByBaseName(name: string): ManifestNode | undefined
        }
        sourceMetaMap: { get(name: string): ManifestSource | undefined }
      }
    | undefined
  >
  unsafeCompileQuery(query: string, originalModelName?: string): Promise<string | undefined>
  getNonEphemeralParents(keys: string[]): string[]
  getBulkSchemaFromDB(
    nodes: { unique_id: string; name: string; resource_type: string; table?: string }[],
    signal: AbortSignal,
  ): Promise<Record<string, { column: string; dtype: string }[]>>
  getAdapterType(): string
}

export type SqlGraphDeps = {
  fetchLineage: (req: SqlLineageRequest) => Promise<SqlLineageResponse>
  readFile: (file: string) => string
  /** The dbt project's root, to resolve a model's project-relative path. */
  projectRoot: string | undefined
}

/** A column name as the warehouse and the manifest agree on it: lower case unless quoted. */
function columnKey(name: string): string {
  return /^(["`]).*\1$/.test(name) ? name : name.toLowerCase()
}

/** The parent's manifest columns plus any the warehouse reports that the manifest lacks. */
export function mergeColumns(
  manifestColumns: SqlLineageModelNode["columns"],
  fromDb: { column: string; dtype: string }[] | undefined,
): SqlLineageModelNode["columns"] {
  const merged: SqlLineageModelNode["columns"] = {}
  for (const [k, v] of Object.entries(manifestColumns ?? {})) merged[columnKey(k)] = { ...v }
  for (const c of fromDb ?? []) {
    const key = columnKey(c.column)
    const existing = merged[key]
    if (existing) {
      existing.data_type = (existing.data_type || c.dtype)?.toLowerCase()
      continue
    }
    merged[key] = { name: key, data_type: c.dtype?.toLowerCase(), description: "", meta: {} }
  }
  return merged
}

/**
 * The backend names the model's own select `__final_select__`: name it after the model, tie each
 * relation node to the dbt node it stands for, and drop the layout positions the list doesn't use.
 */
export function remapSqlLineage(
  response: SqlLineageResponse,
  model: { name: string; uniqueId: string; resourceType: string },
  parents: { uniqueId: string; alias?: string; sourceTable?: string; resourceType: string }[],
): SqlGraph {
  const details = { ...response.details }
  const mapping: Record<string, { nodeId: string; type: string }> = {}
  for (const p of parents) {
    // A source's relation is its table name; any other node's, its alias.
    const wanted = (p.sourceTable ?? p.alias ?? "").toLowerCase()
    if (!wanted) continue
    const key = Object.keys(details).find((k) => details[k].type === "table" && k.toLowerCase() === wanted)
    if (key) mapping[key] = { nodeId: p.uniqueId, type: p.resourceType }
  }
  mapping[model.name] = { nodeId: model.uniqueId, type: model.resourceType }
  const edges = response.tableEdges.map(
    (edge) => edge.map((item) => (item === FINAL_SELECT ? model.name : item)) as [string, string],
  )
  if (details[FINAL_SELECT]) {
    details[model.name] = details[FINAL_SELECT]
    delete details[FINAL_SELECT]
  }
  const nodes: SqlGraphNode[] = Object.entries(details).map(([key, d]) => {
    const merged = { ...d, ...mapping[key] }
    return {
      name: key === model.name ? model.name : (merged.name ?? key),
      type: merged.type,
      ...(merged.nodeId ? { nodeId: merged.nodeId } : {}),
      sql: merged.sql ?? "",
      columns: merged.columns ?? [],
    }
  })
  return { nodes, edges }
}

/** Compile the model, read its parents' columns, ask the backend, and return the remapped graph. */
export async function buildSqlGraph(
  adapter: SqlGraphAdapter,
  model: string,
  deps: SqlGraphDeps,
  signal: AbortSignal,
): Promise<SqlGraph> {
  const manifest = await adapter.parseManifest()
  if (!manifest) throw new Error("the dbt manifest is not available")
  const node = manifest.nodeMetaMap.lookupByUniqueId(model) ?? manifest.nodeMetaMap.lookupByBaseName(model)
  if (!node) throw new Error(`no model named ${model} in the manifest`)
  if (!node.path) throw new Error(`${node.name} has no SQL file`)
  const file = path.isAbsolute(node.path) ? node.path : path.join(deps.projectRoot ?? "", node.path)
  const compiled = await adapter.unsafeCompileQuery(deps.readFile(file), node.name)
  if (!compiled) throw new Error(`unable to compile ${node.name}`)

  const parentIds = adapter.getNonEphemeralParents([node.unique_id])
  const requests: { unique_id: string; name: string; resource_type: string; table?: string }[] = []
  const infos: SqlLineageModelNode[] = []
  const parents: { uniqueId: string; alias?: string; sourceTable?: string; resourceType: string }[] = []
  for (const id of parentIds) {
    const parts = id.split(".")
    if (parts[0] === "source") {
      const source = manifest.sourceMetaMap.get(parts[2])
      const table = source?.tables.find((t) => t.name === parts[3])
      if (!source || !table) continue
      requests.push({ unique_id: id, name: source.name, resource_type: "source", table: table.name })
      infos.push({
        database: source.database,
        schema: source.schema,
        name: table.name,
        alias: table.identifier,
        uniqueId: id,
        columns: table.columns,
        path: table.path,
      })
      parents.push({ uniqueId: id, sourceTable: table.name, resourceType: "source" })
      continue
    }
    const parent = manifest.nodeMetaMap.lookupByUniqueId(id)
    if (!parent) continue
    requests.push({ unique_id: id, name: parent.name, resource_type: parent.resource_type })
    infos.push({
      database: parent.database,
      schema: parent.schema,
      name: parent.name,
      alias: parent.alias,
      uniqueId: id,
      columns: parent.columns,
      path: parent.path,
    })
    parents.push({ uniqueId: id, alias: parent.alias, resourceType: parent.resource_type })
  }
  // The warehouse metadata read: once per call, only for the parents.
  const fromDb = requests.length ? await adapter.getBulkSchemaFromDB(requests, signal) : {}
  signal.throwIfAborted()
  const hash = crypto.createHash("md5").update(compiled).digest("hex")
  const response = await deps.fetchLineage({
    compiled_sql: compiled,
    model_info: infos.map((n) => ({ model_node: { ...n, columns: mergeColumns(n.columns, fromDb[n.uniqueId]) } })),
    model_dialect: adapter.getAdapterType(),
    session_id: `altimate-code-${hash}`,
  })
  signal.throwIfAborted()
  return remapSqlLineage(
    response,
    { name: node.name, uniqueId: node.unique_id, resourceType: node.resource_type },
    parents,
  )
}

/** The graph as a list in dependency order: each node, its inputs, its column count. */
export function formatSqlGraph(model: string, graph: SqlGraph): string {
  const inputs = new Map<string, string[]>()
  for (const [from, to] of graph.edges) inputs.set(to, [...(inputs.get(to) ?? []), from])
  const lines = [`SQL graph for ${model}: ${graph.nodes.length} nodes, ${graph.edges.length} edges`]
  for (const n of graph.nodes) {
    const from = inputs.get(n.name)
    lines.push(
      `- ${n.name} (${n.type}${n.nodeId ? `, ${n.nodeId}` : ""}): ${n.columns.length} columns${from?.length ? `, from ${from.join(", ")}` : ""}`,
    )
  }
  return lines.join("\n")
}

export const DbtSqlGraphTool = Tool.define("dbt_sql_graph", {
  description:
    "The CTEs, joins and filters of a dbt model as a graph, from the Altimate backend: nodes with their SQL and columns, and the edges between them. Compiles the model with the project's dbt integration, reads its parent relations' columns from the warehouse's metadata, and sends the compiled SQL to the Altimate backend. Needs write permission (starts the dbt integration) and an Altimate key.",
  parameters: z.object({
    model: z.string().describe("Model name or unique_id (e.g. 'orders', 'model.shop.orders')"),
  }),
  async execute(args, ctx) {
    const access = await dbtAdapterFor(ctx)
    if (!access.adapter) {
      return {
        title: "dbt SQL graph: not available",
        metadata: { success: false, model: args.model, reason: access.reason },
        output: `Not available: ${access.reason}`,
      }
    }
    try {
      const { getDbtProjectRoot } = await import("../native/connections/register")
      const graph = await buildSqlGraph(
        access.adapter as SqlGraphAdapter,
        args.model,
        {
          fetchLineage: sqlLineage,
          readFile: (f) => fs.readFileSync(f, "utf8"),
          projectRoot: await getDbtProjectRoot(),
        },
        ctx.abort,
      )
      return {
        title: `dbt SQL graph: ${args.model} (${graph.nodes.length} nodes)`,
        metadata: { success: true, model: args.model, nodes: graph.nodes, edges: graph.edges },
        output: formatSqlGraph(args.model, graph),
      }
    } catch (e) {
      if (ctx.abort.aborted) throw e
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "dbt SQL graph: ERROR",
        metadata: { success: false, model: args.model, error: msg },
        output: `Failed: ${msg}`,
      }
    }
  },
})
