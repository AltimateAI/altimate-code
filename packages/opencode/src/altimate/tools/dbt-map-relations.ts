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
type Reference = { raw: string; parts: string[]; start?: number }

/** What the scan of a query found: its table references in text order, and the names its CTEs define. */
export type Scan = {
  refs: Reference[]
  /** By lower-cased name: whether the WITH is recursive, and the text offsets of each body that defines the name. */
  ctes: Map<string, { recursive: boolean; bodies: [number, number][] }>
}

// Dialects whose double quotes (and, for some, backslashes) belong to string literals.
const DOUBLE_QUOTE_STRING = new Set(["bigquery", "databricks", "spark", "mysql", "hive"])
const BACKSLASH_ESCAPE = new Set(["bigquery", "databricks", "spark", "mysql", "hive", "clickhouse", "snowflake"])
const DOLLAR_QUOTE = new Set(["snowflake", "postgres", "redshift", "duckdb"])
const BRACKET_QUOTE = new Set(["tsql", "sqlserver", "fabric", "synapse"])

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
  "straight_join",
  "asof",
  "with",
  "and",
  "or",
  "not",
  "is",
  "in",
])
// Clause words that start a list of tables. `from` inside these calls reads a column or a string instead.
const TABLE_KEYWORDS = new Set(["from", "join", "into", "update", "using"])
const FROM_INSIDE_CALL = new Set(["extract", "trim", "substring", "overlay", "position"])

type Token = { kind: "word" | "quoted" | "punct" | "other"; start: number; end: number; text: string }

/** The tokens of the SQL with comments and string literals dropped; a quoted name stays one token. */
function tokenize(sql: string, dialect: string): Token[] {
  const out: Token[] = []
  const n = sql.length
  let i = 0
  const doubleIsString = DOUBLE_QUOTE_STRING.has(dialect)
  const backslash = BACKSLASH_ESCAPE.has(dialect)
  const push = (kind: Token["kind"], start: number, end: number) =>
    out.push({ kind, start, end, text: sql.slice(start, end) })
  const skipString = (quote: string, from: number) => {
    let j = from
    while (j < n) {
      if (backslash && sql[j] === "\\") j += 2
      else if (sql[j] === quote) {
        if (sql[j + 1] === quote) j += 2
        else return j + 1
      } else j++
    }
    return n
  }
  const lastWord = () => {
    const last = out[out.length - 1]
    return last?.kind === "word" ? last.text.toLowerCase() : ""
  }
  while (i < n) {
    const ch = sql[i]
    const two = sql.slice(i, i + 2)
    if (/\s/.test(ch)) i++
    else if (two === "--") {
      while (i < n && sql[i] !== "\n") i++
    } else if (two === "/*") {
      const end = sql.indexOf("*/", i + 2)
      i = end < 0 ? n : end + 2
    } else if (ch === "'" || (ch === '"' && doubleIsString)) {
      const triple = dialect === "bigquery" && sql.startsWith(ch.repeat(3), i)
      if (triple) {
        const end = sql.indexOf(ch.repeat(3), i + 3)
        i = end < 0 ? n : end + 3
      } else i = skipString(ch, i + 1)
    } else if (
      ch === "$" &&
      DOLLAR_QUOTE.has(dialect) &&
      /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.test(sql.slice(i, i + 40))
    ) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 40))![0]
      const end = sql.indexOf(tag, i + tag.length)
      i = end < 0 ? n : end + tag.length
    } else if (ch === '"' || ch === "`" || (ch === "[" && BRACKET_QUOTE.has(dialect))) {
      const close = ch === "[" ? "]" : ch
      let j = i + 1
      while (j < n) {
        if (sql[j] === close) {
          if (sql[j + 1] === close && close !== "]") j += 2
          else break
        } else j++
      }
      const end = Math.min(j + 1, n)
      push("quoted", i, end)
      i = end
    } else if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j])) j++
      // BigQuery project ids may contain hyphens (`my-proj.ds.tbl` unquoted), but only where a table is named.
      if (dialect === "bigquery" && (TABLE_KEYWORDS.has(lastWord()) || out[out.length - 1]?.text === ",")) {
        while (sql[j] === "-" && /[A-Za-z0-9_]/.test(sql[j + 1] ?? "")) {
          j++
          while (j < n && /[A-Za-z0-9_$]/.test(sql[j])) j++
        }
      }
      push("word", i, j)
      i = j
    } else if (/[0-9]/.test(ch)) {
      let j = i + 1
      while (j < n && /[A-Za-z0-9_]/.test(sql[j])) j++
      push("other", i, j)
      i = j
    } else {
      push(/[.,()]/.test(ch) ? "punct" : "other", i, i + 1)
      i++
    }
  }
  return out
}

/** The name a quoted token or word holds: quotes removed, doubled quotes undone. */
function nameOf(token: Token, dialect: string): string[] {
  if (token.kind !== "quoted") return [token.text]
  const open = token.text[0]
  const close = open === "[" ? "]" : open
  const body = token.text.slice(1, token.text.endsWith(close) && token.text.length > 1 ? -1 : undefined)
  const name = close === "]" ? body : body.split(close + close).join(close)
  // BigQuery reads `proj.ds.tbl` in one pair of backticks as a path.
  return open === "`" && dialect === "bigquery" ? name.split(".") : [name]
}

/** Index of the token after the `)` that closes the `(` at `at`. */
function afterParens(tokens: Token[], at: number): number {
  let depth = 0
  for (let i = at; i < tokens.length; i++) {
    if (tokens[i].text === "(" && tokens[i].kind === "punct") depth++
    else if (tokens[i].text === ")" && tokens[i].kind === "punct" && --depth === 0) return i + 1
  }
  return tokens.length
}

const isPunct = (token: Token | undefined, text: string) => token?.kind === "punct" && token.text === text

/**
 * The table references of FROM, JOIN, INTO, UPDATE and USING clauses, in text order, written as in the SQL,
 * and the names the query's CTEs define. altimate-core's table list keeps only the last name part and leaves
 * out any table named like a CTE, so the schema and database a person wrote are read back from the text here.
 */
export function scanTableReferences(sql: string, dialect: string): Scan {
  const tokens = tokenize(sql, dialect)
  const refs: Reference[] = []
  const ctes: Scan["ctes"] = new Map()
  const calls: string[] = []

  // `name [(columns)] as [not] [materialized] (`, then `,` for the next CTE.
  const readCtes = (start: number) => {
    let i = start
    const recursive = tokens[i]?.text.toLowerCase() === "recursive"
    if (recursive) i++
    while (tokens[i] && (tokens[i].kind === "word" || tokens[i].kind === "quoted")) {
      const name = nameOf(tokens[i], dialect)[0].toLowerCase()
      let j = i + 1
      if (isPunct(tokens[j], "(")) j = afterParens(tokens, j)
      if (tokens[j]?.text.toLowerCase() !== "as") return
      j++
      if (tokens[j]?.text.toLowerCase() === "not") j++
      if (tokens[j]?.text.toLowerCase() === "materialized") j++
      if (!isPunct(tokens[j], "(")) return
      const open = tokens[j].start
      j = afterParens(tokens, j)
      const known = ctes.get(name) ?? { recursive, bodies: [] }
      known.bodies.push([open, tokens[j - 1].end])
      ctes.set(name, known)
      if (!isPunct(tokens[j], ",")) return
      i = j + 1
    }
  }

  const readList = (start: number, strict: boolean) => {
    let i = start
    for (;;) {
      if (isPunct(tokens[i], "(")) i = afterParens(tokens, i)
      else {
        const first = tokens[i]
        if (!first || (first.kind !== "word" && first.kind !== "quoted")) return
        if (first.kind === "word" && RESERVED.has(first.text.toLowerCase())) return
        const parts: string[] = [...nameOf(first, dialect)]
        let at = i
        while (isPunct(tokens[at + 1], ".") && ["word", "quoted"].includes(tokens[at + 2]?.kind ?? "")) {
          at += 2
          parts.push(...nameOf(tokens[at], dialect))
        }
        const last = tokens[at]
        i = at + 1
        if (isPunct(tokens[i], "(") && strict) i = afterParens(tokens, i)
        else refs.push({ raw: sql.slice(first.start, last.end), parts, start: first.start })
      }
      // An alias with or without AS, then its column list, then a comma continues a FROM list.
      if (tokens[i]?.text.toLowerCase() === "as") i++
      const alias = tokens[i]
      if (alias && (alias.kind === "quoted" || (alias.kind === "word" && !RESERVED.has(alias.text.toLowerCase())))) {
        i++
        if (isPunct(tokens[i], "(")) i = afterParens(tokens, i)
      }
      if (isPunct(tokens[i], ",")) i++
      else return
    }
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (isPunct(token, "(")) {
      const before = tokens[i - 1]
      calls.push(before?.kind === "word" ? before.text.toLowerCase() : "")
    } else if (isPunct(token, ")")) calls.pop()
    else if (token.kind === "word") {
      const word = token.text.toLowerCase()
      if (word === "with") readCtes(i + 1)
      else if (TABLE_KEYWORDS.has(word)) {
        if (
          word === "from" &&
          (FROM_INSIDE_CALL.has(calls[calls.length - 1] ?? "") || tokens[i - 1]?.text.toLowerCase() === "distinct")
        )
          continue
        // A name followed by "(" after FROM, JOIN or USING is a table function; after INTO or UPDATE it is a table.
        readList(
          word === "into" && tokens[i + 1]?.text.toLowerCase() === "table" ? i + 2 : i + 1,
          word === "from" || word === "join" || word === "using",
        )
      }
    }
  }
  // An outer list is read before the subquery inside it: put them back in text order.
  refs.sort((a, b) => a.start! - b.start!)
  return { refs, ctes }
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
    // Every version of a model shares its name; a bare ref() resolves to the latest one, so a version is named.
    const version =
      node.version === null || node.version === undefined || node.version === ""
        ? ""
        : `, v=${JSON.stringify(node.version)}`
    const call = pkg ? `{{ ref('${pkg}', '${node.name}'${version}) }}` : `{{ ref('${node.name}'${version}) }}`
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
  const { refs, ctes } = scanTableReferences(sql, dialect)
  // Only tables altimate-core reported count, plus qualified ones its list leaves out because a CTE shares their name.
  const wanted = new Set(tables.map((t) => t.toLowerCase()))
  const entries: Reference[] = []
  const seen = new Set<string>()
  const add = (r: Reference) => {
    const key = r.raw.replace(/\s+/g, " ")
    if (seen.has(key)) return
    seen.add(key)
    entries.push(r)
  }
  const covered = new Set<string>()
  for (const r of refs) {
    const last = r.parts[r.parts.length - 1]
    const whole = r.parts.join(".")
    const cte = ctes.get(last.toLowerCase())
    // A CTE's own name inside its own body is the real table unless the WITH is recursive.
    const inOwnBody = !!cte && !cte.recursive && cte.bodies.some(([from, to]) => r.start! >= from && r.start! < to)
    if (r.parts.length === 1 && cte && !inOwnBody) continue
    if (wanted.has(last.toLowerCase()) || wanted.has(whole.toLowerCase())) {
      add(r)
      covered.add((wanted.has(last.toLowerCase()) ? last : whole).toLowerCase())
    } else if (cte) add(r)
  }
  for (const t of tables) {
    if (covered.has(t.toLowerCase()) || ctes.has(t.toLowerCase())) continue
    add({ raw: t, parts: splitQualified(t, dialect === "bigquery") })
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
      if (!manifestPath) return fail("No dbt project found here. Run from a dbt project or pass manifest_path.")
      const manifest = loadRawManifest(manifestPath)
      if (!manifest) return fail(`No manifest at ${manifestPath}. Run \`dbt parse\` or pass manifest_path.`)
      const dialect = (args.dialect || detectDialect(manifest)).toLowerCase()
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

async function defaultManifestPath(): Promise<string | null> {
  const { findProjectRoot } = await import("../../../../dbt-tools/src/config")
  const found = findProjectRoot(projectRoot())
  const root = found ?? (await (await import("../native/connections/register")).getDbtProjectRoot())
  if (!root) return null
  let real = root
  try {
    real = fs.realpathSync(root)
  } catch {}
  return path.join(real, "target", "manifest.json")
}
