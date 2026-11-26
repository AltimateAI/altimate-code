// altimate_change - new file
//
// The part of a dbt manifest's graph a lineage viewer draws for one model: everything upstream,
// everything downstream (with the tests counted as ids), and the links between them. Clients that
// cannot read a large manifest themselves (the Claude Code plugin reads files up to 4 MiB) get it
// from the CLI (`altimate tool run dbt_lineage --json` with include_graph); MCP carries no graph.

import { createHash } from "crypto"

export interface GraphNode {
  id: string
  name: string
  /** An exposure's label; null for other nodes. */
  label: string | null
  type: string
  path: string | null
  /**
   * The project-relative schema.yml that describes the node (dbt's patch_path without its `package://`), when there
   * is one in the project itself: a node of an installed package has none, its file being relative to that package.
   */
  yml?: string
  materialized: string | null
  /** database.schema.table, lower-cased. */
  relation: string | null
  columns: string[]
}

export interface LineageGraph {
  nodes: Record<string, GraphNode>
  parents: Record<string, string[]>
  children: Record<string, string[]>
  /** True when downstream stopped at the node limit. */
  truncated: boolean
  /** True when upstream stopped at the node limit. */
  upTruncated: boolean
}

const GROUPS = ["nodes", "sources", "exposures", "metrics", "semantic_models", "saved_queries", "unit_tests"] as const
/** Limits on each side; the target and test nodes come on top. A source-to-mart chain of a few hundred models fits. */
const MAX_DOWNSTREAM = 500
const MAX_UPSTREAM = 500

function lookup(manifest: any, id: string): any {
  for (const group of GROUPS) if (manifest[group]?.[id]) return manifest[group][id]
  return undefined
}

function relationOf(node: any): string | null {
  // A manifest that carries relation_name with null (ephemeral models, analyses, tests) has no relation.
  if (node && "relation_name" in node && !node.relation_name) return null
  if (typeof node?.relation_name === "string" && node.relation_name)
    return node.relation_name.replace(/[`"\[\]]/g, "").toLowerCase()
  const parts = [node?.database, node?.schema, node?.alias ?? node?.identifier ?? node?.name].filter(
    (part): part is string => typeof part === "string" && part !== "",
  )
  return parts.length === 3 ? parts.join(".").toLowerCase() : null
}

/** Whether a package is the manifest's root project: by `project_name`, or by `project_id`, the MD5 of that name. */
function isRootPackage(name: string, metadata: any): boolean {
  if (typeof metadata?.project_name === "string" && metadata.project_name) return name === metadata.project_name
  if (typeof metadata?.project_id === "string" && metadata.project_id)
    return createHash("md5").update(name).digest("hex") === metadata.project_id
  return false
}

/** The project-relative schema.yml path of a node's patch_path. A path of an installed package, or of a package
 * the manifest cannot tell is the root project, is relative to somewhere else and is left out. */
function ymlOf(node: any, metadata: any): string | undefined {
  if (typeof node?.patch_path !== "string") return undefined
  const scheme = /^([^:/]+):\/\//.exec(node.patch_path)
  // A path without the package prefix (older manifests) belongs to the node's own package.
  const owner = scheme ? scheme[1] : node?.package_name
  if (typeof owner !== "string" || !isRootPackage(owner, metadata)) return undefined
  return node.patch_path.slice(scheme?.[0].length ?? 0)
}

function nodeOf(id: string, node: any, metadata?: any): GraphNode {
  const yml = ymlOf(node, metadata)
  const type: string = node?.resource_type ?? id.split(".")[0] ?? "unknown"
  return {
    id,
    name: node?.name ?? id.split(".").pop() ?? id,
    label: type === "exposure" ? node?.label || node?.name || id : null,
    type,
    path: node?.original_file_path ?? null,
    ...(yml !== undefined ? { yml } : {}),
    materialized: node?.config?.materialized ?? null,
    relation: relationOf(node),
    columns: Object.entries<any>(node?.columns ?? {}).map(([key, col]) => String(col?.name ?? key)),
  }
}

function mapsOf(manifest: any): { parents: Record<string, string[]>; children: Record<string, string[]> } {
  if (manifest.parent_map && manifest.child_map) return { parents: manifest.parent_map, children: manifest.child_map }
  const parents: Record<string, string[]> = {}
  const children: Record<string, string[]> = {}
  for (const group of GROUPS) {
    for (const [id, node] of Object.entries<any>(manifest[group] ?? {})) {
      parents[id] = node?.depends_on?.nodes ?? []
      for (const parent of parents[id]) (children[parent] ??= []).push(id)
    }
  }
  return { parents, children }
}

export function lineageGraph(manifest: any, id: string): LineageGraph {
  const { parents, children } = mapsOf(manifest)
  const isTest = (one: string) =>
    ["test", "unit_test"].includes(lookup(manifest, one)?.resource_type ?? one.split(".")[0])
  const keep = new Set([id])
  // Breadth first, so a cut keeps the nearest nodes.
  const walk = (links: Record<string, string[]>, limit: number, seen = new Set([id])) => {
    const queue = [id]
    let count = 0
    while (queue.length) {
      for (const next of links[queue.shift()!] ?? []) {
        if (seen.has(next) || isTest(next)) continue
        if (count >= limit) return true
        seen.add(next)
        keep.add(next)
        count++
        queue.push(next)
      }
    }
    return false
  }
  const upTruncated = walk(parents, MAX_UPSTREAM)
  // Tests are counted for the target and what is downstream of it only; upstream ones would only add weight.
  const counted = new Set([id])
  const truncated = walk(children, MAX_DOWNSTREAM, counted)
  const graph: LineageGraph = { nodes: {}, parents: {}, children: {}, truncated, upTruncated }
  for (const one of keep) {
    graph.nodes[one] = nodeOf(one, lookup(manifest, one), manifest.metadata)
    graph.parents[one] = (parents[one] ?? []).filter((other) => keep.has(other))
    graph.children[one] = (children[one] ?? []).filter((other) => {
      if (keep.has(other)) return true
      if (!isTest(other) || !counted.has(one)) return false
      if (!graph.nodes[other]) {
        graph.nodes[other] = { ...nodeOf(other, lookup(manifest, other), manifest.metadata), type: "test" }
        graph.parents[other] = (parents[other] ?? []).filter((p) => keep.has(p))
        graph.children[other] = []
      }
      return true
    })
  }
  return graph
}
