import z from "zod"
import fs from "fs"
import path from "path"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import { loadRawManifest, detectDialect } from "../native/dbt/helpers"
import { projectRoot } from "../native/connections/registry"

export type RelationMatch = "exact" | "case_insensitive" | "partial" | "none"
export type RelationKind = "model" | "snapshot" | "seed" | "source"

export type RelationCandidate = {
  replaceWith: string
  kind: RelationKind
  name: string
  uniqueId: string
  relationName: string
  match: Exclude<RelationMatch, "none">
}

export type RelationMapping = {
  /** The table as written in the SQL, qualifiers included. */
  raw: string
  /** A `ref()` or `source()` call, or `raw` itself when nothing matched. */
  replaceWith: string
  match: RelationMatch
  /** Every manifest relation the table matched, best first. */
  candidates: RelationCandidate[]
}

type Relation = {
  kind: RelationKind
  name: string
  uniqueId: string
  relationName: string
  parts: string[]
  call: string
}

const RANK: Record<Exclude<RelationMatch, "none">, number> = { exact: 0, case_insensitive: 1, partial: 2 }
const KIND_RANK: Record<RelationKind, number> = { model: 0, snapshot: 1, seed: 2, source: 3 }

/**
 * Split a dotted name into its parts, honouring "double", `back` and [bracket] quotes. Dots inside
 * backticks split the name when `splitBacktickDots` is set: BigQuery reads `proj.ds.tbl` as a path.
 */
export function splitQualified(text: string, splitBacktickDots = false): string[] {
  const parts: string[] = []
  let cur = ""
  let i = 0
  const push = () => {
    parts.push(cur)
    cur = ""
  }
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch
      let j = i + 1
      let body = ""
      while (j < text.length) {
        if (text[j] === close) {
          if (text[j + 1] === close && close !== "]") {
            body += close
            j += 2
            continue
          }
          break
        }
        body += text[j++]
      }
      if (ch === "`" && splitBacktickDots) {
        const sub = body.split(".")
        cur += sub[0]
        for (const s of sub.slice(1)) {
          push()
          cur = s
        }
      } else cur += body
      i = j + 1
    } else if (ch === ".") {
      push()
      i++
    } else {
      cur += ch
      i++
    }
  }
  push()
  return parts
}

/** A table reference found in the SQL text: the text as written and its unquoted parts. */
type Reference = { raw: string; parts: string[] }

const IDENT_START = /[A-Za-z_$"`[]/
const RESERVED = new Set([
  "select",
  "from",
  "where",
  "join",
  "inner",
  "left",
  "right",
  "full",
  "outer",
  "cross",
  "natural",
  "lateral",
  "on",
  "using",
  "group",
  "order",
  "having",
  "limit",
  "offset",
  "union",
  "intersect",
  "except",
  "minus",
  "qualify",
  "window",
  "set",
  "when",
  "then",
  "else",
  "end",
  "as",
  "values",
  "returning",
  "fetch",
  "for",
  "pivot",
  "unpivot",
  "tablesample",
  "inner",
  "straight_join",
  "asof",
])

/** One identifier chain (`a.b.c`, each part quoted or not) starting at `i`; null when there is none. */
function readChain(sql: string, start: number): { raw: string; end: number } | null {
  let i = start
  const n = sql.length
  while (i < n) {
    const ch = sql[i]
    if (ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch
      i++
      while (i < n) {
        if (sql[i] === close) {
          if (sql[i + 1] === close && close !== "]") {
            i += 2
            continue
          }
          break
        }
        i++
      }
      if (i >= n) return null
      i++
    } else if (/[A-Za-z0-9_$\-]/.test(ch) && (i > start || /[A-Za-z_$]/.test(ch))) {
      while (i < n && /[A-Za-z0-9_$]/.test(sql[i])) i++
      // BigQuery project ids may contain hyphens (`my-proj.ds.tbl` unquoted).
      while (sql[i] === "-" && /[A-Za-z0-9_]/.test(sql[i + 1] ?? "")) {
        i++
        while (i < n && /[A-Za-z0-9_$]/.test(sql[i])) i++
      }
    } else return null
    if (sql[i] === ".") {
      i++
      continue
    }
    break
  }
  return i > start ? { raw: sql.slice(start, i), end: i } : null
}

/** Replace comments and string literals with spaces so the scan never reads inside them. */
function blank(sql: string): string {
  let out = ""
  let i = 0
  while (i < sql.length) {
    const two = sql.slice(i, i + 2)
    if (two === "--") {
      while (i < sql.length && sql[i] !== "\n") {
        out += " "
        i++
      }
    } else if (two === "/*") {
      const end = sql.indexOf("*/", i + 2)
      const stop = end < 0 ? sql.length : end + 2
      out += sql.slice(i, stop).replace(/[^\n]/g, " ")
      i = stop
    } else if (sql[i] === "'") {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === "\\") j += 2
        else if (sql[j] === "'") {
          if (sql[j + 1] === "'") j += 2
          else break
        } else j++
      }
      const stop = Math.min(j + 1, sql.length)
      out += sql.slice(i, stop).replace(/[^\n]/g, " ")
      i = stop
    } else if (sql[i] === '"' || sql[i] === "`") {
      // Keep quoted identifiers intact; skip over them so a quote inside one is not misread.
      const close = sql[i]
      let j = i + 1
      while (j < sql.length && sql[j] !== close) j++
      out += sql.slice(i, Math.min(j + 1, sql.length))
      i = Math.min(j + 1, sql.length)
    } else {
      out += sql[i]
      i++
    }
  }
  return out
}

function skipSpace(sql: string, i: number): number {
  while (i < sql.length && /\s/.test(sql[i])) i++
  return i
}

/**
 * The table references of FROM, JOIN, INTO and UPDATE clauses, in text order, written as in the SQL.
 * altimate-core's table list keeps only the last name part, so the schema and database a person wrote
 * are read back from the text here; the list decides which of these are real tables.
 */
export function scanTableReferences(sql: string, splitBacktickDots: boolean): Reference[] {
  const text = blank(sql)
  const found: Reference[] = []
  const re = /\b(from|join|into|update|using|table)\b/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    let i = skipSpace(text, m.index + m[0].length)
    for (;;) {
      if (!IDENT_START.test(text[i] ?? "")) break
      const chain = readChain(text, i)
      if (!chain) break
      i = skipSpace(text, chain.end)
      // A function call (`flatten(...)`, `unnest(...)`) is not a table.
      if (text[i] === "(") break
      if (!RESERVED.has(chain.raw.toLowerCase())) {
        found.push({ raw: chain.raw, parts: splitQualified(chain.raw, splitBacktickDots) })
      } else break
      // An alias, with or without AS, then a comma continues a FROM list.
      const asM = /^as\s+/i.exec(text.slice(i))
      if (asM) i = skipSpace(text, i + asM[0].length)
      const alias = readChain(text, i)
      if (alias && !alias.raw.includes(".") && !RESERVED.has(alias.raw.toLowerCase())) i = skipSpace(text, alias.end)
      else if (asM && alias) i = skipSpace(text, alias.end)
      if (text[i] === ",") {
        i = skipSpace(text, i + 1)
        continue
      }
      break
    }
  }
  return found
}

/** The model, snapshot, seed and source nodes of a manifest, each with its relation's name parts. */
export function manifestRelations(manifest: any): Relation[] {
  const rootProject: string | undefined = manifest?.metadata?.project_name
  const out: Relation[] = []
  const relationOf = (node: any): string | undefined => {
    if (typeof node?.relation_name === "string" && node.relation_name) return node.relation_name
    const db = node?.database
    const schema = node?.schema
    const name = node?.alias ?? node?.identifier ?? node?.name
    if (typeof schema === "string" && schema && typeof name === "string" && name) {
      return [db, schema, name].filter((p) => typeof p === "string" && p).join(".")
    }
    return undefined
  }
  const nodes: Record<string, any> = manifest?.nodes ?? {}
  for (const [uniqueId, node] of Object.entries(nodes)) {
    const kind = node?.resource_type
    if (kind !== "model" && kind !== "snapshot" && kind !== "seed") continue
    // Ephemeral models are inlined by dbt and have no relation to match.
    if (node?.config?.materialized === "ephemeral") continue
    const relationName = relationOf(node)
    if (!relationName || typeof node.name !== "string") continue
    const pkg =
      typeof node.package_name === "string" && rootProject && node.package_name !== rootProject
        ? node.package_name
        : undefined
    const call = pkg ? `{{ ref('${pkg}', '${node.name}') }}` : `{{ ref('${node.name}') }}`
    out.push({ kind, name: node.name, uniqueId, relationName, parts: splitQualified(relationName, true), call })
  }
  const sources: Record<string, any> = manifest?.sources ?? {}
  for (const [uniqueId, node] of Object.entries(sources)) {
    const relationName = relationOf(node)
    if (!relationName || typeof node?.source_name !== "string" || typeof node?.name !== "string") continue
    out.push({
      kind: "source",
      name: node.name,
      uniqueId,
      relationName,
      parts: splitQualified(relationName, true),
      call: `{{ source('${node.source_name}', '${node.name}') }}`,
    })
  }
  return out
}

/** How a table written as `parts` matches a relation, or null when it does not. */
export function matchParts(parts: string[], relation: string[]): Exclude<RelationMatch, "none"> | null {
  if (parts.length === 0 || parts.length > relation.length) return null
  const tail = relation.slice(relation.length - parts.length)
  const same = parts.every((p, i) => p === tail[i])
  const fold = parts.every((p, i) => p.toLowerCase() === tail[i].toLowerCase())
  if (parts.length < relation.length) return fold ? "partial" : null
  return same ? "exact" : fold ? "case_insensitive" : null
}

/** Map each table of `sql` to the manifest's ref() or source() call that builds it. */
export function mapRelations(tables: string[], sql: string, relations: Relation[], dialect: string): RelationMapping[] {
  const splitDots = dialect === "bigquery"
  const refs = scanTableReferences(sql, splitDots)
  // Reference list keyed by the written form, in text order; only tables altimate-core reported count.
  const wanted = new Set(tables)
  const entries: Reference[] = []
  const seen = new Set<string>()
  const add = (r: Reference) => {
    const key = r.parts.join("\u0000")
    if (seen.has(key)) return
    seen.add(key)
    entries.push(r)
  }
  const covered = new Set<string>()
  for (const r of refs) {
    const last = r.parts[r.parts.length - 1]
    const whole = r.parts.join(".")
    if (wanted.has(last) || wanted.has(whole)) {
      add(r)
      covered.add(wanted.has(last) ? last : whole)
    }
  }
  for (const t of tables) {
    if (covered.has(t)) continue
    add({ raw: t, parts: splitQualified(t, splitDots) })
  }
  return entries.map((entry) => {
    const hits: RelationCandidate[] = []
    for (const rel of relations) {
      const how = matchParts(entry.parts, rel.parts)
      if (!how) continue
      hits.push({
        replaceWith: rel.call,
        kind: rel.kind,
        name: rel.name,
        uniqueId: rel.uniqueId,
        relationName: rel.relationName,
        match: how,
      })
    }
    hits.sort(
      (a, b) =>
        RANK[a.match] - RANK[b.match] || KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.uniqueId.localeCompare(b.uniqueId),
    )
    const best = hits[0]
    return {
      raw: entry.raw,
      replaceWith: best ? best.replaceWith : entry.raw,
      match: best ? best.match : "none",
      candidates: hits,
    }
  })
}

export function formatMapping(rows: RelationMapping[]): string {
  if (rows.length === 0) return "No tables found in the SQL."
  const order: RelationMatch[] = ["none", "partial", "case_insensitive", "exact"]
  const lines: string[] = []
  for (const match of order) {
    for (const r of rows.filter((x) => x.match === match)) {
      const more = r.candidates.length > 1 ? ` (${r.candidates.length} candidates)` : ""
      lines.push(
        match === "none" ? `none: ${r.raw} -> no model or source` : `${match}: ${r.raw} -> ${r.replaceWith}${more}`,
      )
    }
  }
  return lines.join("\n")
}

type MapRelationsMetadata = {
  success: boolean
  mappings: RelationMapping[]
  error?: string
  dialect?: string
  manifest_path?: string
}

export const DbtMapRelationsTool = Tool.define("dbt_map_relations", {
  description:
    "Map the tables in a SQL query to dbt ref() and source() calls, from the project's manifest: each table is matched to the relation_name of a model, snapshot, seed or source. Returns, per table, the replacement, how it matched (exact, case_insensitive, partial, none) and the candidates. Read-only.",
  parameters: z.object({
    sql: z.string().describe("The raw SQL to map"),
    dialect: z.string().optional().describe("SQL dialect (default: the manifest's adapter)"),
    manifest_path: z
      .string()
      .optional()
      .describe("manifest.json to match against (default: the dbt project's target/manifest.json)"),
  }),
  async execute(args): Promise<{ title: string; metadata: MapRelationsMetadata; output: string }> {
    const fail = (msg: string) => ({
      title: "dbt Map Relations: ERROR",
      metadata: { success: false, error: msg, mappings: [] } as MapRelationsMetadata,
      output: msg,
    })
    try {
      const manifestPath = args.manifest_path ?? (await defaultManifestPath())
      const manifest = loadRawManifest(manifestPath)
      if (!manifest) return fail(`No manifest at ${manifestPath}. Run \`dbt parse\` or pass manifest_path.`)
      const dialect = args.dialect || detectDialect(manifest)
      const result = await Dispatcher.call("altimate_core.metadata", { sql: args.sql, dialect })
      const data = (result.data ?? {}) as Record<string, any>
      const error = result.error ?? data.error
      if (!result.success || error) return fail(`Could not read the tables of the SQL: ${error ?? "parse failed"}`)
      const tables: string[] = Array.isArray(data.tables)
        ? data.tables.filter((t: unknown) => typeof t === "string")
        : []
      const mappings = mapRelations(tables, args.sql, manifestRelations(manifest), dialect)
      const count = (m: RelationMatch) => mappings.filter((r) => r.match === m).length
      return {
        title: `dbt Map Relations: ${mappings.length} tables, ${count("none")} unmatched`,
        metadata: { success: true, dialect, manifest_path: manifestPath, mappings },
        output: formatMapping(mappings),
      }
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e))
    }
  },
})

async function defaultManifestPath(): Promise<string> {
  const { findProjectRoot } = await import("../../../../dbt-tools/src/config")
  const found = findProjectRoot(projectRoot())
  const root = found ?? (await (await import("../native/connections/register")).getDbtProjectRoot())
  let real = root ?? ""
  try {
    real = root ? fs.realpathSync(root) : ""
  } catch {}
  return path.join(real, "target", "manifest.json")
}
