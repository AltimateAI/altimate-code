// altimate_change - new file
//
// Which downstream models read a column, and which exposures (dashboards) sit on them. Each
// downstream model's (or snapshot's) compiled SQL is traced with dbtLineage, in dependency order, so
// a column that is renamed or carried through an intermediate model is still followed. What the
// lineage engine cannot settle is reported as such: models it could not trace (no compiled SQL, or
// SQL it could not parse), models that name the column only outside their select list (where the
// engine reports no edge), and models that read it through a table name several parents share.
import { loadRawManifest, findModel } from "./helpers"
import { dbtLineage } from "./lineage"

export interface ColumnReachModel {
  name: string
  unique_id: string
  /** Its output columns that come from the traced column. */
  columns: string[]
}

export interface ColumnReachUnsure {
  name: string
  unique_id: string
  /** Why: no compiled SQL or a parse error, a mention outside the select list, an ambiguous table name, or an unsettled parent. */
  reason: string
}

export interface ColumnReachExposure {
  /** Identifies the exposure across packages that reuse a name. */
  unique_id: string
  name: string
  /** The exposure's label when it has one, else its name. */
  label: string
  type: string
}

export interface ColumnReach {
  /** Models whose output columns certainly come from the column. */
  models: ColumnReachModel[]
  /**
   * Models that may read it: they name it outside their select list (or a column of that name
   * another parent shares), read it through a table name more than one parent shares, or sit
   * downstream of a model that could not be traced or read it ambiguously.
   */
  uncertain: ColumnReachUnsure[]
  /** Downstream models that could not be traced (no compiled SQL, or SQL the engine could not parse). */
  untraced: ColumnReachUnsure[]
  /** Exposures on the model or on any model that certainly reads the column. */
  exposures: ColumnReachExposure[]
  /** Exposures on models that may read it or could not be traced (and on none of the certain readers). */
  uncertain_exposures: ColumnReachExposure[]
  /** True when the walk stopped at the model limit before covering everything downstream. */
  truncated: boolean
}

const MAX_MODELS = 300
const TRACED = new Set(["model", "snapshot"])

/** "db"."schema"."orders"."amount" → { parts: ["db","schema","orders"], column: "amount" }, lower-cased. */
function splitSource(source: unknown): { parts: string[]; column: string; exact: string } | null {
  const text =
    typeof source === "string" ? source : typeof (source as any)?.source === "string" ? (source as any).source : null
  if (!text) return null
  // Split on dots outside quotes: "a"."net.amount" is table a, column net.amount.
  const raw = [...text.matchAll(/"([^"]*)"|`([^`]*)`|\[([^\]]*)\]|([^."`\[\]]+)/g)].map(
    (m) => m[1] ?? m[2] ?? m[3] ?? m[4] ?? "",
  )
  if (raw.length < 2) return null
  // `exact` keeps the column's case, for parents that document two columns differing only by case.
  return {
    parts: raw.slice(0, -1).map((part) => part.toLowerCase()),
    column: raw.at(-1)!.toLowerCase(),
    exact: raw.at(-1)!,
  }
}

/** The ways a parent's relation can be written in a child's compiled SQL, most qualified first. */
function relationKeys(node: any): string[] {
  const table = [node?.alias, node?.identifier, node?.name].filter(
    (v): v is string => typeof v === "string" && v !== "",
  )
  const schema = typeof node?.schema === "string" ? node.schema : null
  const database = typeof node?.database === "string" ? node.database : null
  const keys = new Set<string>()
  for (const name of table) {
    if (database && schema) keys.add(`${database}.${schema}.${name}`.toLowerCase())
    if (schema) keys.add(`${schema}.${name}`.toLowerCase())
    keys.add(name.toLowerCase())
  }
  return [...keys]
}

/**
 * The parents an edge's source table names, matched at the qualification the edge carries: a
 * qualified name that matches no parent names none (it is some other relation), and a bare name
 * more than one parent answers to names them all.
 */
export function parentsNamed(parts: string[], parents: string[], lookup: (id: string) => any): string[] {
  const key = parts.slice(-3).join(".")
  return parents.filter((parent) => relationKeys(lookup(parent)).includes(key))
}

/** Whether a node documents more than one column with this name once case is ignored ("revenue" and "Revenue"). */
function caseCollides(node: any, lower: string): boolean {
  const names = new Set(Object.entries<any>(node?.columns ?? {}).map(([key, col]) => String(col?.name ?? key)))
  return [...names].filter((name) => name.toLowerCase() === lower).length > 1
}

/** Column names the manifest documents for a node, lower-cased. */
function documentedColumns(node: any): Set<string> {
  return new Set(Object.entries<any>(node?.columns ?? {}).map(([key, col]) => String(col?.name ?? key).toLowerCase()))
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * SQL with comments blanked and string literals (quoted or dollar-quoted) emptied, in one pass so
 * none can swallow another.
 */
function stripSql(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'|\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$|--[^\r\n]*|\/\*[\s\S]*?\*\//g, (match) =>
    match.startsWith("'") || match.startsWith("$") ? "''" : " ",
  )
}

/**
 * Whether the SQL selects `*` or `t.*` in any form (DISTINCT ON, TOP n, AS STRUCT, multi-part or
 * quoted qualifiers, EXCLUDE/EXCEPT/REPLACE/RENAME modifiers). Every `*` counts except count(*) and
 * multiplication, which has an operand on both sides that is not a keyword ending the projection.
 */
export function selectsStar(sql: string): boolean {
  const code = stripSql(sql)
  const ends = /^(from|exclude|except|replace|rename|ilike|columns)\b/i
  for (let at = code.indexOf("*"); at !== -1; at = code.indexOf("*", at + 1)) {
    const before = code.slice(0, at).trimEnd()
    const after = code.slice(at + 1).trimStart()
    const prev = before.at(-1) ?? ""
    const next = after[0] ?? ""
    // count(*) reads no column; hash(*), object_construct(*), struct(*) read them all.
    if (prev === "(" && next === ")" && /\bcount(?:_big|_if)?\s*\($/i.test(before)) continue
    if (prev === "." || next === "" || next === "," || next === ")" || ends.test(after)) return true
    const operand = /[\w"'`\])]/
    // A sign on the right operand (`revenue * -1`) belongs to it.
    const right = after.replace(/^[+-]\s*/, "")[0] ?? ""
    if (operand.test(prev) && (operand.test(right) || right === "(" || /\d/.test(right))) {
      // An operand before the `*` that is itself a keyword (SELECT, DISTINCT, ALL, STRUCT) is no operand.
      if (/\b(select|distinct|all|struct)$/i.test(before)) return true
      continue
    }
    return true
  }
  return false
}

/**
 * Whether compiled SQL names the column anywhere but as an output alias, comments and string
 * literals aside. Used only to mark a model as one that may read the column.
 */
function namesColumn(sql: string, column: string): boolean {
  const code = stripSql(sql)
  const name = escapeRegExp(column)
  const ident = new RegExp(`(^|[^A-Za-z0-9_$])("${name}"|${name})(?![A-Za-z0-9_$])`, "gi")
  for (const match of code.matchAll(ident)) {
    const before = code.slice(0, match.index! + match[1]!.length)
    if (/\bas\s*`?$/i.test(before)) continue
    return true
  }
  return false
}

/**
 * Whether the SQL may have a NATURAL JOIN, whose join columns the lineage engine reports no edge for.
 * Read from the raw SQL: the words inside a string, comment or quoted name count too, which only adds
 * doubt (a comment mentioning one marks the model uncertain), while masking quotes would let a dialect's
 * quoting rules hide a real join. Comments between the keywords are read as gaps.
 * Limit: a parent's whole row passed as a value (`to_json(o)`) is not seen; telling a row source from
 * a column needs the engine's parse, not a pattern.
 */
// Between the keywords: whitespace, or a comment (`--`, `#` or `//` to the line's end, `/* … */` to its
// first `*/`). Limit: a nested Postgres comment between them is not read as one.
const GAP = String.raw`(?:\s|(?:--|#|\/\/)[^\r\n]*[\r\n]|\/\*(?:[^*]|\*(?!\/))*\*\/)+`
// The join's modifiers in any dialect: LEFT/RIGHT/FULL/INNER/CROSS, OUTER, Spark's SEMI/ANTI, Snowflake's DIRECTED.
const NATURAL = new RegExp(
  String.raw`^natural${GAP}(?:(?:left|right|full|inner|cross|outer|semi|anti|directed)${GAP}){0,4}join\b`,
  "i",
)
// How far past a `natural` the rest of the join is looked for, and how many are looked at: past that
// many the SQL may well have one, which only adds doubt. An unclosed `/*` makes each check read to the
// window's end, so the window is what keeps crafted input cheap.
// Limit: more than 10,000 characters of comments between the keywords hide the join.
const NATURAL_WINDOW = 10_000
const MAX_NATURALS = 100
export function joinsNaturally(sql: string): boolean {
  let seen = 0
  for (const match of sql.matchAll(/(?<![\w$])natural(?![\w$])/gi)) {
    if (++seen > MAX_NATURALS || NATURAL.test(sql.slice(match.index!, match.index! + NATURAL_WINDOW))) return true
  }
  return false
}

// `IDENTIFIER (`, comments allowed before and inside the parenthesis, then its string or bind variable.
const IDENTIFIER_CALL = new RegExp(String.raw`^identifier(?:${GAP})?\((?:${GAP})?(?:'((?:[^']|'')*)'|([$:?]))`, "i")

/**
 * Whether the SQL names one of `columns` through Snowflake's `IDENTIFIER('…')`, or passes it a bind
 * variable (`IDENTIFIER($col)`): the lineage engine reads the argument as a string, so it reports no
 * edge for the column. Bounded like joinsNaturally: each `identifier` is read in a window, and past
 * 100 of them the SQL counts as naming it.
 */
export function namesThroughIdentifier(sql: string, columns: string[]): boolean {
  const wanted = new Set(columns.map((one) => one.toLowerCase()))
  let seen = 0
  for (const match of sql.matchAll(/(?<![\w$])identifier(?![\w$])/gi)) {
    if (++seen > MAX_NATURALS) return true
    const call = IDENTIFIER_CALL.exec(sql.slice(match.index!, match.index! + NATURAL_WINDOW))
    if (!call) continue
    if (call[2]) return true
    const name = call[1]!.replace(/''/g, "'").split(".").pop()!.trim().replace(/^"|"$/g, "")
    if (wanted.has(name.toLowerCase())) return true
  }
  return false
}

function childMapOf(manifest: any): Record<string, string[]> {
  if (manifest.child_map) return manifest.child_map
  const children: Record<string, string[]> = {}
  for (const group of [manifest.nodes, manifest.exposures]) {
    for (const [id, node] of Object.entries<any>(group ?? {})) {
      for (const parent of node?.depends_on?.nodes ?? []) (children[parent] ??= []).push(id)
    }
  }
  return children
}

export function columnReach(manifestPath: string, model: string, column: string, dialect?: string): ColumnReach {
  const manifest = loadRawManifest(manifestPath)
  if (!manifest) throw new Error(`Manifest not found at ${manifestPath}`)
  const nodes: Record<string, any> = manifest.nodes ?? {}
  const lookup = (id: string) => nodes[id] ?? manifest.sources?.[id]
  const target = findModel(nodes, model)
  if (!target) throw new Error(`Model '${model}' not found in manifest`)
  const targetId: string = target.unique_id ?? Object.keys(nodes).find((id) => nodes[id] === target)
  const children = childMapOf(manifest)

  // Everything downstream, then a topological order over it, so each node is traced after all its
  // traced parents.
  const downstream = new Set<string>()
  const queue = [targetId]
  while (queue.length) {
    for (const child of children[queue.shift()!] ?? []) {
      if (downstream.has(child) || !TRACED.has(nodes[child]?.resource_type)) continue
      downstream.add(child)
      queue.push(child)
    }
  }
  const pending = new Map<string, number>()
  for (const id of downstream) {
    const parents: string[] = nodes[id]?.depends_on?.nodes ?? []
    pending.set(id, parents.filter((p) => downstream.has(p)).length)
  }
  const ready = [...downstream].filter((id) => pending.get(id) === 0)
  const order: string[] = []
  while (ready.length) {
    const id = ready.shift()!
    order.push(id)
    for (const child of children[id] ?? []) {
      if (!pending.has(child)) continue
      const left = pending.get(child)! - 1
      pending.set(child, left)
      if (left === 0) ready.push(child)
    }
  }

  const column0 = column.toLowerCase()
  // Columns certainly carried from the traced column, per node.
  const tracked = new Map<string, Set<string>>([[targetId, new Set([column0])]])
  // The same columns with their case kept: consulted only where a parent's names differ by case alone.
  // The target's own spelling comes from the manifest: the caller's when documented as typed, else
  // the one spelling matching ignoring case, else the caller's. Two documented spellings that only
  // case tells apart, neither typed as given, leave the column unsettled: no reader of either is certain.
  const spellings = Object.entries<any>(target.columns ?? {}).map(([key, col]) => String(col?.name ?? key))
  const matches = spellings.filter((name) => name.toLowerCase() === column0)
  const exact = spellings.includes(column)
  const unsettled = !exact && matches.length > 1
  let spelled: string[] = [column]
  if (unsettled) spelled = []
  else if (!exact && matches.length > 0) spelled = matches
  const trackedExact = new Map<string, Set<string>>([[targetId, new Set(spelled)]])
  const carries = (parent: string, source: { column: string; exact: string }) =>
    !!tracked.get(parent)?.has(source.column) &&
    (!caseCollides(lookup(parent), source.column) || !!trackedExact.get(parent)?.has(source.exact))
  // Nodes whose outputs are unknown (untraced, or read through an ambiguous name): their children
  // may read the column too. A node that only filters on it was traced and carries nothing on.
  const unsure = new Set<string>(unsettled ? [targetId] : [])
  const reached: ColumnReachModel[] = []
  const uncertain: ColumnReachUnsure[] = []
  const untraced: ColumnReachUnsure[] = []
  let truncated = false
  let traced = 0
  const entry = (id: string, reason: string) => ({ name: nodes[id]?.name ?? id, unique_id: id, reason })

  for (const id of order) {
    const allParents: string[] = nodes[id]?.depends_on?.nodes ?? []
    const parents = allParents.filter((p) => tracked.has(p))
    const fromUnsure = allParents.some((p) => unsure.has(p))
    if (parents.length === 0 && !fromUnsure) continue
    if (traced++ >= MAX_MODELS) {
      truncated = true
      break
    }

    const result = dbtLineage({ manifest_path: manifestPath, model: id, dialect })
    const lineage = result.raw_lineage as any
    // dbtLineage rates a model low when the engine threw or answered SQL it cannot parse (`errors`, no edges).
    if (result.confidence === "low") {
      untraced.push(entry(id, result.confidence_factors[0] ?? "the lineage engine could not trace it"))
      unsure.add(id)
      continue
    }
    const edges: { source: unknown; target: string; lineage_type?: string }[] = lineage?.column_lineage?.length
      ? lineage.column_lineage
      : Object.entries<any>(lineage?.column_dict ?? {}).flatMap(([out, sources]) =>
          (Array.isArray(sources) ? sources : [sources]).map((source) => ({
            source,
            target: out,
            lineage_type: "direct",
          })),
        )
    // Errors beside some edges: the engine traced only part of the SQL.
    const partial = Array.isArray(lineage?.errors) && lineage.errors.length > 0

    // Two parents with the same table name share one entry in the engine's schema, so its edges
    // cannot say which one is read; a `select *` from a parent whose schema does not list the
    // column cannot be expanded to it. Both are possible reads with unknown outputs.
    const sqlText: string = nodes[id]?.compiled_code || nodes[id]?.compiled_sql || ""
    const bareName = (p: string) => {
      const node = lookup(p)
      return String(node?.alias || node?.identifier || node?.name || p).toLowerCase()
    }
    const collides = parents.some((p) => allParents.some((other) => other !== p && bareName(other) === bareName(p)))
    const wildcard =
      selectsStar(sqlText) &&
      parents.some((p) => [...tracked.get(p)!].some((col) => !documentedColumns(lookup(p)).has(col)))
    if (collides || wildcard) {
      unsure.add(id)
      uncertain.push(
        entry(
          id,
          collides
            ? "reads a parent whose table name another parent shares"
            : "selects * from a parent whose schema.yml does not list the column",
        ),
      )
      continue
    }

    const carried = new Set<string>()
    const carriedExact = new Set<string>()
    let reads = false
    let ambiguous = false
    for (const edge of edges) {
      const source = splitSource(edge.source)
      if (!source) continue
      const candidates = parentsNamed(source.parts, allParents, lookup)
      if (!candidates.some((p) => carries(p, source))) continue
      // A bare table name that more than one parent answers to cannot say which one is read.
      if (candidates.length > 1) {
        ambiguous = true
        continue
      }
      reads = true
      if (edge.lineage_type !== "indirect" && typeof edge.target === "string") {
        carried.add(edge.target.toLowerCase())
        carriedExact.add(edge.target)
      }
    }
    // The engine has no schema for the tables inside an inlined ephemeral parent, so it reports no
    // edge through it: unknown, not unread, even when another parent's edges are traced.
    const viaEphemeral = parents.some((p) => lookup(p)?.config?.materialized === "ephemeral")
    const natural = joinsNaturally(sqlText)
    // The column named as a string the engine cannot trace: its outputs are unknown, like a NATURAL JOIN's.
    const viaIdentifier = namesThroughIdentifier(
      sqlText,
      parents.flatMap((parent) => [...tracked.get(parent)!]),
    )
    const opaque = natural || viaIdentifier
    if (reads) {
      tracked.set(id, carried)
      trackedExact.set(id, carriedExact)
      // Outputs fed by an unsettled or ephemeral parent, or read through an ambiguous name, stay unsettled.
      // A NATURAL JOIN beside the column may join on it, or carry it on in another output.
      if (ambiguous || fromUnsure || viaEphemeral || partial || opaque) unsure.add(id)
      reached.push({ name: nodes[id]?.name ?? id, unique_id: id, columns: [...carried].sort() })
      continue
    }

    if (partial) {
      unsure.add(id)
      uncertain.push(entry(id, "the lineage engine traced only part of its SQL"))
      continue
    }
    if (viaEphemeral) {
      unsure.add(id)
      uncertain.push(entry(id, "reads an ephemeral parent, inlined as a CTE the lineage engine cannot trace through"))
      continue
    }
    const named = parents.flatMap((parent) => [...tracked.get(parent)!].filter((col) => namesColumn(sqlText, col)))
    // No edge at all while the SQL names the column (a PIVOT, say) is the engine not seeing through
    // it, so its outputs are unknown. SQL that never names it (`select 1`, `count(*)`) reads nothing and
    // falls through. Below an unsure parent it is already reported as uncertain.
    if (edges.length === 0 && !fromUnsure && named.length > 0) {
      uncertain.push(entry(id, "names it, but the lineage engine found no column edges in its SQL"))
      unsure.add(id)
      continue
    }
    // A NATURAL JOIN may join on the column with no edge the engine can report.
    if (!fromUnsure && !ambiguous && named.length === 0 && opaque) {
      unsure.add(id)
      uncertain.push(
        entry(
          id,
          viaIdentifier
            ? "names it through IDENTIFIER(), which the lineage engine cannot trace"
            : "uses a NATURAL JOIN, whose join columns the lineage engine cannot trace",
        ),
      )
      continue
    }
    const shared = named.some(
      (col) => allParents.filter((other) => documentedColumns(lookup(other)).has(col)).length > 1,
    )
    if (ambiguous || named.length > 0 || fromUnsure) {
      if (ambiguous || fromUnsure || opaque) unsure.add(id)
      uncertain.push(
        entry(
          id,
          ambiguous
            ? "reads it through a table name more than one parent shares"
            : named.length > 0
              ? shared
                ? "names it outside its select list, or names another parent's column of the same name"
                : "names it only outside its select list (WHERE, JOIN, GROUP BY or HAVING)"
              : "is downstream of a model that could not be traced or reads it ambiguously",
        ),
      )
    }
  }

  // An unsettled spelling leaves the target's own dashboards uncertain too: which column they read is unknown.
  const reachedIds = new Set([...(unsettled ? [] : [targetId]), ...reached.map((m) => m.unique_id)])
  const certain = exposuresOn(manifestPath, reachedIds)
  const unsureIds = [...uncertain, ...untraced].map((m) => m.unique_id)
  const maybe = exposuresOn(manifestPath, unsettled ? [targetId, ...unsureIds] : unsureIds).filter(
    (e) => !certain.some((c) => c.unique_id === e.unique_id),
  )
  return { models: reached, uncertain, untraced, exposures: certain, uncertain_exposures: maybe, truncated }
}

/** Exposures that depend on any of the given unique_ids, read from the raw manifest. */
export function exposuresOn(manifestPath: string, ids: Iterable<string>): ColumnReachExposure[] {
  const manifest = loadRawManifest(manifestPath)
  const wanted = new Set(ids)
  // A metric reads its semantic model, which reads a model: whatever depends on one depends on the others.
  const layers = [
    ...Object.entries<any>(manifest?.semantic_models ?? {}),
    ...Object.entries<any>(manifest?.metrics ?? {}),
  ]
  for (let grew = true; grew; ) {
    grew = false
    for (const [id, node] of layers) {
      if (wanted.has(id) || !(node?.depends_on?.nodes ?? []).some((dep: string) => wanted.has(dep))) continue
      wanted.add(id)
      grew = true
    }
  }
  return Object.entries<any>(manifest?.exposures ?? {})
    .filter(([, node]) => (node?.depends_on?.nodes ?? []).some((dep: string) => wanted.has(dep)))
    .map(([id, node]) => ({
      unique_id: id,
      name: node?.name ?? id,
      label: node?.label || node?.name || id,
      type: node?.type ?? "exposure",
    }))
}
