/**
 * Build the schema context the Rust core needs to resolve table/column
 * references when proving query equivalence.
 *
 * Without a schema the engine cannot resolve columns and equivalence is
 * undecidable (→ a conservative WARNING). Feeding it the manifest's model and
 * source columns is what moves equivalence from "could not decide" to a real
 * "provably equivalent / NOT equivalent" verdict on parseable (compiled) SQL.
 *
 * Format matches core.Schema.fromJson(): { tables: { <name>: { columns } }, version }.
 */

export interface SchemaContext {
  tables: Record<string, { columns: Array<{ name: string; type: string }>; primary_key?: string[] }>
  version: string
}

/** A manifest node with typed columns, as returned by the dbt.manifest RPC. */
export interface SchemaNode {
  name: string
  alias?: string
  schema_name?: string
  database?: string
  columns?: Array<{
    name: string
    data_type?: string
    type?: string
    /** dbt contract constraints, e.g. `[{ type: "primary_key" }]`. */
    constraints?: Array<{ type?: string }>
  }>
  /** Explicit primary key columns (model-level contract constraint). */
  primary_key?: string[]
}

/**
 * Derive a node's primary key for fan-out analysis (L037). Prefers an explicit
 * `primary_key`; otherwise collects columns carrying a `primary_key` contract
 * constraint. Returns undefined when none is declared (the lint then stays silent
 * — no false positives).
 */
function nodePrimaryKey(node: SchemaNode): string[] | undefined {
  if (node.primary_key?.length) return node.primary_key
  const pk = (node.columns ?? [])
    .filter((c) => c.name && (c.constraints ?? []).some((k) => /primary[_ ]?key/i.test(String(k?.type ?? ""))))
    .map((c) => c.name)
  return pk.length ? pk : undefined
}

/**
 * Build a schema context from manifest nodes (models, sources, seeds,
 * snapshots).
 *
 * dbt `ref()`/`source()` compile to fully-qualified relations
 * (`database.schema.identifier`), so keying only by the short name would leave
 * the engine unable to resolve columns in compiled SQL — falsely degrading
 * equivalence to undecidable. We therefore register EACH node under every
 * plausible relation key (bare, `schema.name`, `database.schema.name`, plus the
 * alias forms) so a qualified reference still hits. Returns undefined when no
 * node carries column metadata — the caller then treats equivalence as
 * undecidable rather than guessing.
 */
/**
 * Build a schema context from dbt's `catalog.json` (`dbt docs generate`). The
 * catalog carries the ACTUAL warehouse columns for every relation — unlike the
 * manifest, which only has columns documented in `schema.yml`. This completeness
 * is what makes column-lineage breakage and proven equivalence actually fire on
 * real projects (vs. silently returning nothing / degrading to undecidable).
 */
export async function buildCatalogSchemaContext(catalogPath: string): Promise<SchemaContext | undefined> {
  let parsed: any
  try {
    parsed = JSON.parse(await (await import("node:fs/promises")).readFile(catalogPath, "utf8"))
  } catch {
    return undefined
  }
  const nodes: SchemaNode[] = []
  for (const group of [parsed?.nodes, parsed?.sources]) {
    for (const node of Object.values<any>(group ?? {})) {
      const meta = node?.metadata ?? {}
      const columns = Object.values<any>(node?.columns ?? {})
        .filter((c) => c?.name)
        .map((c) => ({ name: String(c.name), data_type: String(c.type ?? "") }))
      if (!columns.length || !meta.name) continue
      nodes.push({ name: meta.name, schema_name: meta.schema, database: meta.database, columns })
    }
  }
  return buildReviewSchemaContext(nodes)
}

export function buildReviewSchemaContext(...nodeGroups: Array<SchemaNode[] | undefined>): SchemaContext | undefined {
  const tables: SchemaContext["tables"] = {}
  // Track which table identity (`db.schema.name`) owns each lookup key — bare
  // AND qualified. The same table seen across sources (manifest + catalog)
  // shares an identity and merges fine; if two DIFFERENT tables claim the same
  // key (a bare name shared across schemas, or a `schema.table` shared across
  // databases) it's ambiguous — drop that key so a lookup misses (safe degrade)
  // rather than silently winning the wrong table's metadata. A fully-qualified
  // `db.schema.name` key is unique to its identity, so it never goes ambiguous.
  const ownerById = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const group of nodeGroups) {
    for (const node of group ?? []) {
      if (!node.columns?.length) continue
      const columns = node.columns
        .filter((c) => c.name)
        .map((c) => ({ name: c.name, type: c.data_type ?? c.type ?? "" }))
      if (!columns.length) continue
      const primary_key = nodePrimaryKey(node)
      const record = primary_key ? { columns, primary_key } : { columns }
      const identity = `${node.database ?? ""}.${node.schema_name ?? ""}.${node.name ?? node.alias ?? ""}`

      const ids = new Set<string>()
      for (const base of [node.alias, node.name]) {
        if (!base) continue
        ids.add(base)
        if (node.schema_name) {
          ids.add(`${node.schema_name}.${base}`)
          if (node.database) ids.add(`${node.database}.${node.schema_name}.${base}`)
        }
      }
      for (const id of ids) {
        if (ambiguous.has(id)) continue
        const prev = ownerById.get(id)
        if (prev !== undefined && prev !== identity) {
          ambiguous.add(id)
          delete tables[id]
          continue
        }
        ownerById.set(id, identity)
        tables[id] = record
      }
    }
  }
  return Object.keys(tables).length ? { tables, version: "1" } : undefined
}
