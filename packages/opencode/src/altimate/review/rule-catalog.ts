import { type Finding, type Severity, type ReviewCategory, makeFinding } from "./finding"
import { type ChangedFile, fileKind } from "./diff-filter"
import { type Rubric, clampSeverity, exclusionReason } from "./rubric"
import path from "node:path"

/**
 * Declarative rule catalog for dbt/SQL PR review.
 *
 * Each rule is a self-contained, self-verifying scenario: a match pattern over
 * the change (added/removed lines or the new SQL) PLUS a positive `example`
 * (which MUST fire) and a `counter` (which must NOT). The catalog is therefore
 * both the detector set and its test corpus — adding a real-world use-case is a
 * single data entry, which is how this scales to hundreds of checks while
 * staying high-precision.
 *
 * These complement the programmatic detectors in dbt-patterns.ts (which need
 * cross-line logic). Rules here are line/SQL-pattern based.
 *
 * Sources: SQLFluff rule set, dbt best-practice guides, BigQuery/Snowflake/
 * Redshift/Databricks anti-pattern docs, r/dataengineering, dbt-core issues.
 */

export type RuleKind = "model_sql" | "schema_yml" | "snapshot" | "any"

export interface RuleExample {
  add?: string // text treated as added (+) lines
  remove?: string // text treated as removed (-) lines
  newSql?: string // overrides the whole-file SQL (defaults to add)
  path?: string // overrides the file path (for pathGlob rules)
}

export interface Rule {
  id: string
  category: ReviewCategory
  severity: Severity
  title: string
  body: string
  /** at least one match condition; all present conditions must hold (AND). */
  added?: RegExp
  removed?: RegExp
  newSql?: RegExp
  absentNewSql?: RegExp
  /** drop a candidate added-line match if it ALSO matches this (false-positive guard). */
  unless?: RegExp
  kind?: RuleKind
  pathGlob?: RegExp
  /**
   * Cross-engine portability advice: dropped for a project on one known
   * engine only when that engine is listed in `worksOn` (dialect names as
   * `run.ts` maps them: `postgres`, `tsql`, `databricks`, ...). An engine
   * missing from it, or a rule with no `worksOn`, keeps the advice: it may be
   * a real error on that engine.
   */
  portability?: { worksOn?: string[] }
  /** Column-token pattern (first capture group is the column name) collected on
   *  every line `added` matches — every token, not just the first — and kept on
   *  `evidence.result.columns` / `items` so the orchestrator can reconcile each
   *  column (and its `AS` alias) with the base. */
  capturesColumns?: RegExp
  example: RuleExample
  counter?: RuleExample
}

function modelName(p: string): string {
  return path.basename(p).replace(/\.(sql|py)$/i, "")
}

function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/\{#[\s\S]*?#\}/g, " ")
}

/**
 * Blank out single-quoted SQL string-literal CONTENTS (keeping the quotes) so a
 * regex detector can't be tripped by punctuation inside a literal — e.g. the
 * `/` in `'n/a'` must not read as division, a `,` in `'a,b'` must not read as a
 * comma join, and `'passport'` must not read as a column. Detectors that
 * legitimately inspect literal content (leading wildcard, hardcoded date) must
 * NOT use this. Handles doubled-quote escapes.
 */
export function stripLiterals(s: string): string {
  return s.replace(/'(?:[^']|'')*'/g, "''")
}

export interface RuleInput {
  file: ChangedFile
  newSql: string
  added: string[]
  removed: string[]
}

/** True when the rule matches the change. */
export function ruleMatches(rule: Rule, input: RuleInput): boolean {
  const kind = fileKind(input.file)
  const wantKind = rule.kind ?? "model_sql"
  if (wantKind !== "any" && kind !== wantKind) return false
  if (rule.pathGlob && !rule.pathGlob.test(input.file.path)) return false

  // Relevance gate: a rule only fires when its signal is in THE DIFF, never on
  // an unrelated edit to a matching file. added/removed are diff-anchored by
  // construction; a `newSql` (whole-file) condition must also appear in the
  // changed lines to count as relevant. `absentNewSql` is a whole-file guard.
  const diffText = stripComments([...input.added, ...input.removed].join("\n"))
  let relevant = false
  if (rule.added) {
    const hit = input.added.some((l) => {
      const s = stripComments(l)
      return rule.added!.test(s) && !(rule.unless && rule.unless.test(s))
    })
    if (!hit) return false
    relevant = true
  }
  if (rule.removed) {
    if (!input.removed.some((l) => rule.removed!.test(stripComments(l)))) return false
    relevant = true
  }
  if (rule.newSql) {
    if (!rule.newSql.test(stripComments(input.newSql))) return false
    if (rule.newSql.test(diffText)) relevant = true
  }
  if (rule.absentNewSql) {
    if (rule.absentNewSql.test(stripComments(input.newSql))) return false
  }
  return relevant
}

/** A column token found in a select item, with the item's `AS` alias (the
 *  output name) when it has one, and the trimmed line it came from. */
export interface SelectItemColumn {
  column: string
  alias?: string
  line: string
}

/** Split on commas outside parentheses (one entry per select item). Callers
 *  blank string literals first (`stripLiterals`), so a comma inside one never splits. */
function topLevelItems(s: string): string[] {
  const items: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++
    else if (s[i] === ")") depth = Math.max(0, depth - 1)
    else if (s[i] === "," && depth === 0) {
      items.push(s.slice(start, i))
      start = i + 1
    }
  }
  items.push(s.slice(start))
  return items
}

/**
 * Every column token `tokenRe` finds on a select line (all of them, not just
 * the first), each paired with its item's `AS` alias. The pair matters because
 * PII detection reports OUTPUT names: `c.ssn as tax_ref` exposes `tax_ref`.
 * Tokens inside single-quoted literals are ignored.
 */
export function selectItemColumns(line: string, tokenRe: RegExp): SelectItemColumn[] {
  const global = new RegExp(tokenRe.source, tokenRe.flags.includes("g") ? tokenRe.flags : `${tokenRe.flags}g`)
  const out: SelectItemColumn[] = []
  const seen = new Set<string>()
  // Literals are blanked first: their contents are neither column tokens nor
  // item separators (`email || ',' || phone_number as contact` is one item).
  // Clause text (`from ssn_vault`, `where …`) is not a select list.
  for (const item of topLevelItems(selectListText(stripLiterals(stripComments(line))))) {
    // The alias as the select-list parser reads it: with or without `AS`,
    // quoted (`as "Tax Ref"` → `tax ref`), after any parenthesised expression.
    const alias = itemAlias(item)
    for (const m of item.matchAll(global)) {
      const column = m[1]?.toLowerCase()
      if (!column || seen.has(`${column} ${alias ?? ""}`)) continue
      seen.add(`${column} ${alias ?? ""}`)
      out.push({ column, alias, line: line.trim() })
    }
  }
  return out
}

// One identifier segment: bare, double-quoted or backtick-quoted.
const SEGMENT = String.raw`(?:[A-Za-z_][\w$]*|"[^"]+"|` + "`[^`]+`)"
// A column reference, optionally table-qualified (`c.ssn`, `"c"."ssn"`); group 1 is
// the qualifier's last segment (the table or its alias), group 2 the column.
const COLUMN_REF = String.raw`(?:(?:${SEGMENT}\s*\.\s*)*(${SEGMENT})\s*\.\s*)?(${SEGMENT})`
// Select-item expressions that expose a column RAW: a bare reference, or one only
// cast to a type (`cast(c.ssn as varchar)`, `c.ssn::varchar(20)`).
const RAW_COLUMN_EXPRS = [
  new RegExp(String.raw`^${COLUMN_REF}$`, "i"),
  new RegExp(String.raw`^cast\s*\(\s*${COLUMN_REF}\s+as\s+[\w\s(),]+\)$`, "i"),
  new RegExp(String.raw`^${COLUMN_REF}\s*::\s*\w+(?:\s*\([\d\s,]*\))?$`, "i"),
]
const EXPLICIT_ALIAS = new RegExp(String.raw`^([\s\S]*\S)\s+as\s+(${SEGMENT})$`, "i")
// `expr name`: the expression must end in an identifier, quote or `)`, not an operator.
const IMPLICIT_ALIAS = new RegExp(String.raw`^([\s\S]*[\w$"\x60)\]])\s+(${SEGMENT})$`, "i")
// Trailing words that end an expression rather than name it (`case … end`, `x is null`).
const NOT_AN_ALIAS = new Set(
  "end null true false and or not is in then else when case like ilike between asc desc over filter within as distinct all".split(
    " ",
  ),
)
// Words that end a select list at its own nesting level.
const SELECT_LIST_END =
  /^(from|where|group|order|limit|qualify|having|union|intersect|except|minus|window|into|fetch|offset)\b/i

/** The `group` at `at` is the `within group (…)` of an ordered-set aggregate.
 *  Any run of whitespace (a masked comment is one) may separate the words. */
const withinGroup = (sql: string, at: number) => {
  if (!/^group$/i.test(sql.slice(at, at + 5))) return false
  let after = at + 5
  while (/\s/.test(sql[after] ?? "")) after++
  if (sql[after] !== "(") return false
  let before = at
  while (before > 0 && /\s/.test(sql[before - 1])) before--
  return before < at && /(?:^|[^\w$."`])within$/i.test(sql.slice(Math.max(0, before - 7), before))
}

/** `line` with everything outside a select list blanked: from a clause keyword
 *  (`from`, `where`, …) at a query's own level up to the next `select`. A
 *  keyword inside a call (`extract(day from d)`) does not count. */
function selectListText(line: string): string {
  // Per open parenthesis: whether it opens a subquery, and the outer mode.
  const stack: Array<{ query: boolean; listing: boolean }> = []
  let listing = true
  let query = true
  let out = ""
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === "(") {
      stack.push({ query, listing })
      query = /^\s*select\b/i.test(line.slice(i + 1, i + 40))
      if (query) listing = false
    } else if (c === ")") {
      const outer = stack.pop()
      if (outer) ({ query, listing } = outer)
    } else if (query && !isWordChar(line[i - 1])) {
      if (/^select\b/i.test(line.slice(i, i + 7))) listing = true
      else if (SELECT_LIST_END.test(line.slice(i, i + 10)) && !withinGroup(line, i)) listing = false
    }
    out += listing || c === "(" || c === ")" ? c : c === "\n" ? c : " "
  }
  return out
}

const unquote = (s: string) => s.replace(/^["`]|["`]$/g, "").toLowerCase()

/** Scope key of the model's outermost query. No identifier unquotes to it, so a
 *  CTE named `final` (the dbt style guide's last CTE) keeps its own scope. */
export const ROOT_SCOPE = "\u0000root"

/** One item of a select list, located in its query scope. */
export interface SelectItem {
  /** Output name: the alias (with or without `AS`) or a bare column's own name. */
  name?: string
  /** The column the item exposes RAW (bare or qualified reference, or only cast). */
  rawColumn?: string
  /** The qualifier of `rawColumn` (`c` in `c.ssn`): a FROM/JOIN alias or table name. */
  rawQualifier?: string
  /** Whitespace-normalised item text, for comparing one item across base and head. */
  text: string
  /** As `text`, with string-literal contents kept: `regexp_replace(ssn, '\\d', '*')`
   *  and `regexp_replace(ssn, '^$', '*')` differ here. */
  exact: string
  /** For an item that is not a raw column, every column reference its expression
   *  reads (outside `over (…)`, `filter (…)` and `within group (…)`). */
  reads?: Array<{ qualifier?: string; column: string }>
  /** The item is a constant (literals, numbers, `null`/`true`/`false`, casts of them). */
  constant?: boolean
  /** `ROOT_SCOPE` for the outermost query, the CTE name for a CTE body, and for a
   *  nested query `<parent>><alias>` or, without one, `<parent>>sub<n>`. */
  scope: string
  /** Which `UNION`/`INTERSECT`/`EXCEPT` branch of its scope (0 for the first select). */
  branch: number
  /** Position in its select list. */
  position: number
  /** 1-based first and last source lines the item spans. */
  startLine: number
  endLine: number
}

/**
 * Blank comments, Jinja tags and string-literal contents to spaces, and Jinja
 * expressions to `_`, keeping every offset and newline in place so positions
 * still map to source lines. One left-to-right pass, so `--` inside a literal or
 * a double-quoted identifier, or a quote inside a comment, is not misread.
 */
function maskSql(sql: string, keepLiterals = false): string {
  return sql.replace(/\{#[\s\S]*?#\}|\{%[\s\S]*?%\}|\{\{[\s\S]*?\}\}|\/\*[\s\S]*?\*\/|--[^\n]*|'(?:[^']|'')*'|"(?:[^"]|"")*"/g, (m) => {
    if (m.startsWith('"')) return m
    if (m.startsWith("{{")) return m.replace(/[^\n]/g, "_")
    if (m.startsWith("'")) return keepLiterals ? m : `'${m.slice(1, -1).replace(/[^\n]/g, " ")}'`
    return m.replace(/[^\n]/g, " ")
  })
}

const isWordChar = (c: string | undefined) => !!c && /[\w$."`]/.test(c)

// Whitespace and dot spacing collapse only outside string literals, whose
// spacing can change what an expression does (`'[0-9] *'` vs `'[0-9]  *'`).
const NORMALIZE_STEPS: Array<[RegExp, (group?: string) => string]> = [
  [/'(?:[^']|'')*'|\s+/g, () => " "],
  [/'(?:[^']|'')*'|\(\s+/g, () => "("],
  [/'(?:[^']|'')*'|\s+([),])/g, (close) => close!],
  [/'(?:[^']|'')*'|\s*\.\s*/g, () => "."],
]
const normalizeItem = (raw: string) =>
  NORMALIZE_STEPS.reduce(
    (s, [re, to]) => s.replace(re, (m: string, group?: string) => (m.startsWith("'") ? m : to(group))),
    raw,
  ).trim()

// Words in an expression that are syntax, never a column.
const EXPR_KEYWORDS = new Set(
  "and or not is null true false case when then else end as in like ilike rlike regexp similar escape between distinct all any some exists over partition by order asc desc nulls filter within group interval from for collate both leading trailing using separator cast try_cast".split(
    " ",
  ),
)
// A typed literal (`date '2024-01-01'`, `timestamp '…'`, `interval '1 day'`,
// BigQuery `interval 1 day`): its type and unit words are part of the constant,
// not columns.
const TYPED_LITERAL =
  /(?<![\w$."`])(?:(?:date|time|timestamp(?:_[nlt]tz|tz)?|datetime)\s*'(?:[^']|'')*'|interval\s*(?:'(?:[^']|'')*'|[+-]?\d+(?:\.\d+)?)(?:\s+(?:year|quarter|month|week|day|hour|minute|second|millisecond|microsecond)s?\b)?)/gi
const COLUMN_TOKEN = new RegExp(String.raw`(?<![\w$."\x60])${COLUMN_REF}(?![\w$"\x60])(\s*\()?`, "gi")

/** The column references an expression reads, from masked SQL: function names,
 *  keywords, cast/`::` target types and the clauses that only partition, order
 *  or filter rows (`over (…)`, `filter (…)`, `within group (…)` right after a
 *  call's `)`) are skipped. A word that is only sometimes a keyword (`first`,
 *  `time`, `row`) counts as a column unless it is in its keyword phrase. */
function columnReads(expr: string): Array<{ qualifier?: string; column: string }> {
  let e = expr.replace(TYPED_LITERAL, " ").replace(/'(?:[^']|'')*'/g, " ")
  // `f(…) over (…)` / `filter (…)` / `within group (…)`: cut each clause to its
  // `)`. `filter(arr, x -> …)` without a call before it is an array function.
  const clause = /\)\s*(?:over|filter|within\s+group)\s*\(/i
  for (let m = clause.exec(e); m; m = clause.exec(e)) {
    const open = m.index + m[0].length - 1
    e = e.slice(0, m.index + 1) + " " + e.slice(closingParen(e, open) + 1)
  }
  e = e
    .replace(/\bnulls\s+(?:first|last)\b|\bat\s+time\s+zone\b|\b(?:respect|ignore)\s+nulls\b/gi, " ")
    .replace(/::\s*\w+(?:\s*\([\d\s,]*\))?/g, " ")
    .replace(/\bas\s+\w+(?:\s+\w+)*?(?:\s*\([\d\s,]*\))?\s*(?=\))/gi, " ")
  const out: Array<{ qualifier?: string; column: string }> = []
  for (const m of e.matchAll(COLUMN_TOKEN)) {
    if (m[3]) continue // a function call
    const column = unquote(m[2])
    // A bare keyword is syntax; a quoted or qualified one is a column.
    if (!m[1] && !/^["\x60]/.test(m[2]) && EXPR_KEYWORDS.has(column)) continue
    out.push(m[1] ? { qualifier: unquote(m[1]), column } : { column })
  }
  return out
}

/** A select item's expression and its alias (`AS` or implicit), if any. */
function splitAlias(text: string): { expr: string; alias?: string } {
  const explicit = EXPLICIT_ALIAS.exec(text)
  if (explicit) return { expr: explicit[1], alias: explicit[2] }
  const implicit = IMPLICIT_ALIAS.exec(text)
  if (implicit && !NOT_AN_ALIAS.has(unquote(implicit[2]))) return { expr: implicit[1], alias: implicit[2] }
  return { expr: text }
}

/** A select item's output alias, unquoted and lowercased, when it has one. */
function itemAlias(item: string): string | undefined {
  const { alias } = splitAlias(normalizeItem(item))
  return alias ? unquote(alias) : undefined
}

/** Only literals, numbers, `null`/`true`/`false` and casts of them. */
function isConstant(expr: string): boolean {
  const rest = expr
    .replace(TYPED_LITERAL, " ")
    .replace(/'(?:[^']|'')*'/g, " ")
    .replace(/::\s*\w+(?:\s*\([\d\s,]*\))?/g, " ")
    .replace(/\bas\s+\w+(?:\s+\w+)*?(?:\s*\([\d\s,]*\))?\s*(?=\))/gi, " ")
    .replace(/\b(?:null|true|false|cast)\b/gi, " ")
  return /^[\s\d.+\-*/(),]*$/.test(rest)
}

function describeItem(
  raw: string,
): Pick<SelectItem, "name" | "rawColumn" | "rawQualifier" | "text" | "reads" | "constant"> {
  const text = normalizeItem(raw)
  const { expr, alias } = splitAlias(text)
  const matched = RAW_COLUMN_EXPRS.map((re) => re.exec(expr)).find(Boolean)
  // A bare `null` / `true` / `false` (or a cast of one) is a constant, not a column.
  const ref = matched && !matched[1] && /^(?:null|true|false)$/i.test(matched[2]) ? undefined : matched
  const rawColumn = ref ? unquote(ref[2]) : undefined
  const rawQualifier = ref?.[1] ? unquote(ref[1]) : undefined
  const name = alias ? unquote(alias) : rawColumn
  if (ref) return { name, rawColumn, rawQualifier, text }
  return { name, text, reads: columnReads(expr), constant: isConstant(expr) }
}

// Words that end a FROM clause's table list at its own nesting level.
const FROM_LIST_END = /^(where|group|order|limit|qualify|having|union|intersect|except|minus|window|fetch|offset|on|using)\b/i
const SET_OPERATOR = /^(union|intersect|except|minus)\b/i
// Words after a FROM/JOIN source that are not its alias.
const NOT_A_SOURCE_ALIAS = new Set(
  "on using where join left right inner outer full cross natural group order limit qualify having union intersect except minus window fetch offset lateral pivot unpivot tablesample sample for at before changes match_recognize with".split(
    " ",
  ),
)

/** One FROM/JOIN source of a select: a table (its full relation name, every
 *  segment unquoted and lowercased), a CTE, or a FROM subquery (named by its
 *  scope), with the alias it is read under. */
interface Source {
  name: string
  /** A schema-qualified table's last segment, which a column qualifier names it by. */
  short?: string
  alias?: string
}

interface ParsedSelects {
  items: SelectItem[]
  /** Per `scope#branch`, the sources its FROM / JOIN clauses read. */
  sources: Map<string, Source[]>
  /** Per `scope#branch`, the masked text of its FROM/JOIN source list: table
   *  names, aliases and table-function or `pivot`/`unpivot` arguments, without
   *  the bodies of FROM subqueries and without join conditions. */
  sourceText: Map<string, string>
  /** `scope#branch` selects with a source the parser could not name: a
   *  parenthesised join, a Jinja expression other than `ref`/`source`/`this`, a
   *  comma-joined source after a join condition, or no source at all in a
   *  select that holds a Jinja expression (which may be its FROM). */
  unknownSources: Set<string>
  /** Nested queries that are the operand of `in`, `exists`, `any`, `some` or
   *  `all`: their rows decide a condition and never reach an output. */
  predicates: Set<string>
  /** The SQL has a shape whose scopes, select lists or output names are not
   *  modelled: a CTE column list (`a (x, y) as (…)`), a `with` inside
   *  parentheses, `select as struct|value`, or a select list that stops at a
   *  clause word used as a column (`select topic, offset, ssn from …`). */
  unmodelled: boolean
  /** Items holding a Jinja expression that may stand for a raw column or a
   *  column list: an item without an alias, or one whose expression is not a
   *  macro call (`{{ col }} as x`). */
  jinjaItems: Set<SelectItem>
}

/** Offset of the `)` closing the `(` at `open` in masked SQL, or the end. */
function closingParen(s: string, open: number): number {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++
    else if (s[i] === ")" && --depth === 0) return i
  }
  return s.length
}

function parseSelects(sql: string): ParsedSelects {
  const s = maskSql(sql)
  const withLiterals = maskSql(sql, true)
  const lineStarts = [0]
  for (let i = 0; i < s.length; i++) if (s[i] === "\n") lineStarts.push(i + 1)
  const lineOf = (offset: number) => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
  const items: SelectItem[] = []
  const sources = new Map<string, Source[]>()
  const sourceText = new Map<string, string>()
  const unknownSources = new Set<string>()
  const predicates = new Set<string>()
  const jinjaItems = new Set<SelectItem>()
  let unmodelled = false
  // The scope each nested query's `(` opens, so a FROM subquery is a named source.
  const parenScope = new Map<number, string>()
  // Each select's scope, branch and the offset its select list ends at.
  const selects: Array<{ scope: string; branch: number; start: number; end: number }> = []
  const scopes: string[] = [ROOT_SCOPE]
  const branches = new Map<string, number>()
  // `name as (`, or `name (col, …) as (`: a column list still names the CTE, whose
  // outputs then keep the body's own names (so a renamed column resolves to nothing).
  const cteHead = new RegExp(
    String.raw`(${SEGMENT})\s*(\([^()]*\)\s*)?\s+as\s*(?:(?:not\s+)?materialized\s*)?$`,
    "i",
  )
  const tableRef = new RegExp(String.raw`^\s*((?:${SEGMENT}\s*\.\s*)*${SEGMENT})`, "i")
  // A nested query is keyed by the alias after its `)` (`(select …) s`,
  // `(select …) as n`), else numbered within its parent, so a subquery added
  // elsewhere does not rename it between base and head.
  const nestedKeys = new Set<string>()
  const nestedCount = new Map<string, number>()
  const subAlias = new RegExp(String.raw`^\s+(?:as\s+)?(${SEGMENT})`, "i")
  const nestedKey = (parent: string, open: number) => {
    const close = closingParen(s, open)
    const alias = subAlias.exec(s.slice(close + 1, close + 200))?.[1]
    const named =
      alias && !NOT_A_SOURCE_ALIAS.has(unquote(alias)) && !NOT_AN_ALIAS.has(unquote(alias)) && !SELECT_LIST_END.test(alias)
        ? `${parent}>${unquote(alias)}` : undefined
    let key = named
    if (!key || nestedKeys.has(key)) {
      // Numbered within the parent, skipping any key already taken (a numbered
      // key can equal one another scope numbered under the same alias).
      let n = nestedCount.get(parent) ?? 0
      do key = `${named ?? parent}>sub${++n}`
      while (nestedKeys.has(key))
      nestedCount.set(parent, n)
    }
    nestedKeys.add(key)
    return key
  }
  // A `from` of the same select after `at`: at its nesting level, before a set
  // operator or the end of the query (`is distinct from` is not one).
  const fromAhead = (at: number) => {
    let depth = 0
    for (let j = at; j < s.length; j++) {
      const d = s[j]
      if (d === "(") depth++
      else if (d === ")") {
        if (--depth < 0) return false
      } else if (d === ";" && depth === 0) return false
      else if (depth === 0 && !isWordChar(s[j - 1])) {
        if (SET_OPERATOR.test(s.slice(j, j + 10))) return false
        if (/^from\b/i.test(s.slice(j, j + 5)) && !/\bdistinct\s+$/i.test(s.slice(Math.max(0, j - 12), j))) return true
      }
    }
    return false
  }
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === "(") {
      const parent = scopes[scopes.length - 1]
      const cte = cteHead.exec(s.slice(Math.max(0, i - 200), i))
      // A CTE body is named by its CTE; a nested query gets its own scope; any
      // other parenthesis (a call, a grouping) stays in its parent's scope.
      if (/^\s*with\b/i.test(s.slice(i + 1, i + 50))) unmodelled = true
      if (cte && !/^as$/i.test(cte[1])) {
        scopes.push(unquote(cte[1]))
        if (cte[2]) unmodelled = true
      } else if (/^[\s(]*select\b/i.test(s.slice(i + 1, i + 200))) {
        scopes.push(nestedKey(parent, i))
        parenScope.set(i, scopes[scopes.length - 1])
        const before = s.slice(Math.max(0, i - 40), i)
        if (
          /(?:^|[^\w$."\x60])(?:in|exists|any|some)\s*$/i.test(before) ||
          (/(?:^|[^\w$."\x60])all\s*$/i.test(before) && !/\b(?:union|intersect|except|minus)\s+all\s*$/i.test(before))
        )
          predicates.add(scopes[scopes.length - 1])
      } else scopes.push(parent)
      continue
    }
    if (c === ")") {
      if (scopes.length > 1) scopes.pop()
      continue
    }
    if ((c !== "s" && c !== "S") || isWordChar(s[i - 1]) || !/^select\b/i.test(s.slice(i, i + 7))) continue
    const scope = scopes[scopes.length - 1]
    const branch = branches.get(scope) ?? 0
    branches.set(scope, branch + 1)
    // The list runs from after `select [distinct [on (…)]|all|top n]` to the first
    // clause keyword, `)` or `;` at its own nesting level.
    let start = i + 6
    const distinctOn = /^\s+distinct\s+on\s*\(/i.exec(s.slice(start, start + 100))
    if (distinctOn) start = closingParen(s, start + distinctOn[0].length - 1) + 1
    else {
      const prefix = /^\s+(?:(?:distinct|all)\b|top\s+\d+\b)?/i.exec(s.slice(start, start + 100))
      if (prefix) start += prefix[0].length
    }
    if (/^\s*as\s+(?:struct|value)\b/i.test(s.slice(start, start + 40))) unmodelled = true
    let depth = 0
    let itemStart = start
    let position = 0
    let end = s.length
    const push = (stop: number) => {
      const raw = s.slice(itemStart, stop)
      if (!raw.trim()) return
      const first = itemStart + (raw.length - raw.trimStart().length)
      const last = itemStart + raw.trimEnd().length - 1
      const item: SelectItem = {
        ...describeItem(raw),
        exact: normalizeItem(withLiterals.slice(itemStart, stop)),
        scope,
        branch,
        position: position++,
        startLine: lineOf(first),
        endLine: lineOf(last),
      }
      items.push(item)
      // Jinja expressions of the item (masked to `_`, so not ones inside a literal).
      const jinja = [...sql.slice(itemStart, stop).matchAll(/\{\{[\s\S]*?\}\}/g)].filter(
        (m) => s[itemStart + m.index!] === "_",
      )
      if (jinja.length && (!splitAlias(item.text).alias || jinja.some((m) => !m[0].includes("(")))) jinjaItems.add(item)
    }
    for (let j = start; j <= s.length; j++) {
      const d = s[j]
      if (j === s.length || (depth === 0 && (d === ")" || d === ";"))) {
        push(j)
        end = j
        break
      }
      if (d === "(") depth++
      else if (d === ")") depth--
      else if (depth === 0 && d === ",") {
        push(j)
        itemStart = j + 1
      } else if (
        depth === 0 &&
        !isWordChar(s[j - 1]) &&
        SELECT_LIST_END.test(s.slice(j, j + 10)) &&
        // `listagg(x, ',') within group (order by y)` is part of the item.
        !withinGroup(s, j) &&
        // `* except (…)` (BigQuery) is one item, not a set operation.
        !(/^except\b/i.test(s.slice(j, j + 7)) && /\*\s*$/.test(s.slice(itemStart, j)))
      ) {
        // A list that stops at any other clause word while this select still
        // has a FROM ahead stopped at a column named like one (`offset`, `window`).
        if (!/^from\b/i.test(s.slice(j, j + 5)) && !SET_OPERATOR.test(s.slice(j, j + 10)) && fromAhead(j)) unmodelled = true
        push(j)
        end = j
        break
      }
    }
    selects.push({ scope, branch, start, end })
  }
  // Sources read at each select's own level: the table, CTE or subquery after
  // `from`, `join`, or a `,` inside a FROM list, with its alias, up to the end of
  // the select (`)`, `;`, a set operator).
  const aliasRe = new RegExp(String.raw`^\s+(?:as\s+)?(${SEGMENT})`, "i")
  const segmentRe = new RegExp(SEGMENT, "g")
  for (const { scope, branch, start, end } of selects) {
    const key = `${scope}#${branch}`
    const read: Source[] = []
    let inFrom = false
    // Inside a join's `on` / `using` condition: a `,` at this level starts a
    // comma-joined source (`join b on … , lateral flatten(…) f`).
    let inCondition = false
    let depth = 0
    // The source list's own text, one segment per source: from after `from`,
    // `join` or `,` to the next of them or the word that ends the list.
    let text = ""
    let segment = -1
    const closeSegment = (stop: number) => {
      if (segment >= 0) text += ` ${s.slice(segment, stop)}`
      segment = -1
    }
    let j = end
    for (; j < s.length; j++) {
      const d = s[j]
      if (depth === 0 && (d === ")" || d === ";")) break
      if (d === "(") depth++
      else if (d === ")") depth--
      if (depth !== 0) continue
      const boundary = !isWordChar(s[j - 1])
      if (boundary && SET_OPERATOR.test(s.slice(j, j + 10))) break
      const kw = boundary ? /^(from|join)\b/i.exec(s.slice(j, j + 5)) : null
      if (kw || (inFrom && d === ",")) {
        closeSegment(j)
        const after = j + (kw ? kw[0].length : 1)
        const lead = after + (/^\s*/.exec(s.slice(after, after + 200))?.[0].length ?? 0)
        let name: string | undefined
        let short: string | undefined
        let rest = lead
        if (s[lead] === "(") {
          // A FROM subquery is a source under its alias; any other parenthesis
          // (a parenthesised join) names no source here.
          name = parenScope.get(lead)
          rest = closingParen(s, lead) + 1
        } else {
          const ref = tableRef.exec(s.slice(after, after + 300))
          if (ref) {
            const segments = [...ref[1].matchAll(segmentRe)].map((m) => m[0])
            const last = segments[segments.length - 1]
            const at = after + ref[0].length - last.length
            // A Jinja `{{ ref('x') }}` is masked to underscores: name it by its source text.
            short = /^_+$/.test(last) ? sql.slice(at, at + last.length).replace(/\s+/g, "").toLowerCase() : unquote(last)
            // Database and schema stay part of the identity: `restricted.customers`
            // and `public.customers` are different tables.
            name = [...segments.slice(0, -1).map(unquote), short].join(".")
            rest = after + ref[0].length
          }
        }
        if (name) {
          const alias = aliasRe.exec(s.slice(rest, rest + 200))?.[1]
          const src: Source = short && short !== name ? { name, short } : { name }
          if (alias && !NOT_A_SOURCE_ALIAS.has(unquote(alias))) src.alias = unquote(alias)
          read.push(src)
          // A Jinja source that is not a relation call could name anything, a CTE included.
          if (short?.startsWith("{{") && !/^\{\{[-+]?(?:(?:ref|source)\(|this[-+]?\}\}$)/.test(short)) unknownSources.add(key)
        } else unknownSources.add(key)
        // A FROM subquery's body is its own scope: only its alias belongs to this list.
        segment = s[lead] === "(" && name ? rest : after
        inFrom = true
        j = after - 1
        inCondition = false
      } else if (inCondition && d === ",") {
        // Not read as a source (the resolvers keep their source list): its text
        // counts, and the select reads something unnamed.
        closeSegment(j)
        segment = j + 1
        unknownSources.add(key)
      } else if (boundary && FROM_LIST_END.test(s.slice(j, j + 10))) {
        closeSegment(j)
        inCondition = inFrom || inCondition ? /^(?:on|using)\b/i.test(s.slice(j, j + 6)) : false
        inFrom = false
      }
    }
    closeSegment(j)
    // No source parsed, yet a Jinja expression in the select: it may hold the FROM.
    if (!read.length && /(?<![\w$])_{4,}(?![\w$])/.test(s.slice(start, j))) unknownSources.add(key)
    sources.set(key, read)
    sourceText.set(key, text)
  }
  return { items, sources, sourceText, unknownSources, predicates, unmodelled, jinjaItems }
}

/**
 * Every select list in `sql`, item by item, with the query scope each belongs
 * to. Scope is what separates a CTE's `ssn as contact` from the final select's
 * `email as contact`: only `ROOT_SCOPE` items are the model's output. Items are
 * parsed across lines, so a multi-line expression or alias is one item.
 */
export function selectItems(sql: string): SelectItem[] {
  return parseSelects(sql).items
}

const STAR = new RegExp(String.raw`^(?:${SEGMENT}\.)*\*$`)

/** The model's final output, as `finalOutputs` resolves it. */
export interface FinalOutputs {
  /**
   * Per output name of the model (its FINAL projection, never a CTE's or a
   * nested query's own aliases), the source columns it exposes RAW under that
   * name, each as `source.column` where the source is the table (its full
   * relation name as written) the column is read from: `c.ssn as tax_ref` with
   * `customers c` → `tax_ref: {customers.ssn}`, so the same column name from
   * another table (`s.ssn` with `spouses s`, or `restricted.customers` vs
   * `public.customers`) is a different exposure. A qualifier resolves
   * through its own FROM/JOIN source only; a column read from a CTE or a FROM
   * subquery takes that scope's exposure for it (masked there → nothing raw), and
   * `*` over them takes all of theirs. An unqualified column resolves through the
   * CTEs/subqueries that output it, else the single table read (several tables →
   * one combined `a|b.column` ref). A qualifier that matches no source gets a ref
   * that matches nothing on the other side. A later set-operation branch takes the
   * first branch's name at the same position. An item that wraps the column in any
   * other function or expression (`sha2(c.ssn)`, `left(c.ssn, 4)`, `case …`,
   * `a || b`) exposes nothing raw and is left out.
   */
  raw: Map<string, Set<string>>
  /** Every output name the final projection resolves. */
  names: Set<string>
  /** The final projection has a plain `*`, so it also passes through unnamed columns. */
  passthrough: boolean
  /** The `source.column` refs the final projection's plain `*` items expose raw
   *  for a column they pass through unnamed (`select * from customers` →
   *  `ssn: {customers.ssn}`; a CTE that masks it → none). */
  starRaw: (column: string) => Set<string>
  /** The database/schema prefix of every table the SQL reads (`""` for an
   *  unqualified one), for `refCovered`'s environment check. */
  prefixes: Set<string>
  /** Per output name, a signature of how it is computed: the item text (string
   *  literals as written, each FROM/JOIN alias named by its source) plus the
   *  full text of every CTE or subquery its select reads. Equal signatures on two sides mean the name is computed the same way. */
  signatures: Map<string, Set<string>>
  /** Per output name, every `source.column` ref its value is computed from, raw
   *  or not, resolved like `raw` (`lower(s.ssn) as email` with `spouses s` →
   *  `email: {spouses.ssn}`; through a CTE, what that CTE's column reads). */
  reads: Map<string, Set<string>>
}

interface ScopeOutputs extends Omit<FinalOutputs, "passthrough" | "starRaw" | "prefixes"> {
  /** `*` items, whose columns pass through unnamed (`select * from customers`). */
  stars: Array<{ branch: number; qualifier?: string }>
  /** Every item's text, and that of every scope it reads. */
  body: string
}

let unresolvedRefs = 0

const splitRef = (ref: string) => {
  const dot = ref.lastIndexOf(".")
  return { tables: ref.slice(0, dot).split("|"), column: ref.slice(dot + 1) }
}

/** A table name split into its database/schema prefix and its own name. A Jinja
 *  `{{ ref(…) }}` name has no prefix. */
function splitTable(table: string): { prefix: string; name: string } {
  const dot = table.startsWith("{{") ? -1 : table.lastIndexOf(".")
  return dot < 0 ? { prefix: "", name: table } : { prefix: table.slice(0, dot), name: table.slice(dot + 1) }
}

/** The database/schema prefixes the base's SQL reads tables under: `sameTable`
 *  asks only whether the base already read tables under the head's prefix. */
export interface RelationPrefixes {
  base: Set<string>
}

/**
 * Head table `h` and base table `b` are the same table. Equal names are. With
 * the same own name, an unqualified side matches a qualified one, and two
 * different prefixes are different tables when the base already read tables
 * under the head's prefix (that prefix exists in the base's environment, so
 * the head chose another schema): base `restricted.customers` +
 * `public.orders` → head `public.customers` is a swap. A head prefix the base
 * never read is an environment difference: a base compiled into `dbt_prod`
 * and a head into `dbt_ci_pr_42` (or a `+schema` change) read the same tables.
 * Without `env`, names must be equal.
 */
function sameTable(h: string, b: string, env?: RelationPrefixes): boolean {
  if (h === b) return true
  if (!env) return false
  const x = splitTable(h)
  const y = splitTable(b)
  if (x.name !== y.name) return false
  if (!x.prefix || !y.prefix) return true
  return !env.base.has(x.prefix)
}

/**
 * `ref` is one of the `exposed` source columns. An unqualified column read over
 * several tables (`customers|orders.email`, see `FinalOutputs.raw`) comes from
 * exactly one of them (the query would be ambiguous otherwise), so it is
 * covered by a single-table ref to one of its members. The reverse is not: a
 * base combined ref does not say which table the column came from, so a head
 * read pinned to one of them (`s.ssn`) may be new. Two combined refs match only
 * when they read the same tables, member by member. Tables compare as in
 * `sameTable` (database/schema only within one environment).
 */
export function refCovered(ref: string, exposed: Set<string>, env?: RelationPrefixes): boolean {
  if (exposed.has(ref)) return true
  const r = splitRef(ref)
  for (const e of exposed) {
    const x = splitRef(e)
    if (x.column !== r.column) continue
    if (x.tables.length === 1) {
      if (r.tables.some((t) => sameTable(t, x.tables[0], env))) return true
      continue
    }
    // Two combined refs: the same tables, member by member.
    if (r.tables.length === x.tables.length && r.tables.every((t) => x.tables.some((b) => sameTable(t, b, env))))
      return true
  }
  return false
}

/** `sql` lowercased except inside string literals, whose case can change what
 *  an expression does (`regexp_replace(email, '[a-z]', '*')`). */
const lowerOutsideLiterals = (sql: string) =>
  sql.replace(/'(?:[^']|'')*'|[^']+/g, (m) => (m.startsWith("'") ? m : m.toLowerCase()))

/** The model's final output: every name it resolves, the source columns each
 *  exposes raw (`raw`), and how each is computed. */
export function finalOutputs(sql: string): FinalOutputs {
  const { items, sources } = parseSelects(sql)
  const byScope = new Map<string, SelectItem[]>()
  for (const item of items) {
    const list = byScope.get(item.scope)
    if (list) list.push(item)
    else byScope.set(item.scope, [item])
  }
  // A ref no source explains: unique, so it is never "already exposed".
  const unresolved = (col: string) => new Set([`?${++unresolvedRefs}.${col}`])
  const union = (sets: Iterable<Set<string>>) => {
    const out = new Set<string>()
    for (const set of sets) for (const x of set) out.add(x)
    return out
  }
  const memo = new Map<string, ScopeOutputs>()
  const refMemo = new Map<string, { raw: Set<string>; reads: Set<string> }>()
  // `seen` plus `scope`, built once per pair: the same chain is walked for every
  // column, so copying `seen` on each step would make a deep chain quadratic.
  const innerSets = new WeakMap<Set<string>, Map<string, Set<string>>>()
  const innerOf = (seen: Set<string>, scope: string) => {
    let perScope = innerSets.get(seen)
    if (!perScope) innerSets.set(seen, (perScope = new Map()))
    let inner = perScope.get(scope)
    if (!inner) perScope.set(scope, (inner = new Set([...seen, scope])))
    return inner
  }
  const isDerived = (src: Source, scope: string, seen: Set<string>) =>
    src.name !== scope && byScope.has(src.name) && !seen.has(src.name)
  // The `source.column` refs a column read in `scope#branch` resolves to: those
  // it exposes raw (`raw`; a column a CTE computes is none), and every one its
  // value is computed from (`reads`).
  type Refs = { raw: Set<string>; reads: Set<string> }
  const same = (set: Set<string>): Refs => ({ raw: set, reads: set })
  const unionRefs = (list: Refs[]): Refs => ({ raw: union(list.map((r) => r.raw)), reads: union(list.map((r) => r.reads)) })
  const resolveRef = (scope: string, branch: number, qualifier: string | undefined, col: string, seen: Set<string>): Refs => {
    // Memoised like `resolve`: a wide select over a deep `*` chain would
    // otherwise walk the chain once per column reference.
    const memoKey = `${scope}#${branch}\u0000${qualifier ?? ""}\u0000${col}`
    const hit = refMemo.get(memoKey)
    if (hit) return hit
    const out = resolveRefUncached(scope, branch, qualifier, col, seen)
    refMemo.set(memoKey, out)
    return out
  }
  const resolveRefUncached = (
    scope: string,
    branch: number,
    qualifier: string | undefined,
    col: string,
    seen: Set<string>,
  ): Refs => {
    const srcs = sources.get(`${scope}#${branch}`) ?? []
    const inner = innerOf(seen, scope)
    const fromSource = (src: Source): Refs => {
      if (!isDerived(src, scope, seen)) return same(byScope.has(src.name) ? unresolved(col) : new Set([`${src.name}.${col}`]))
      const out = resolve(src.name, inner)
      if (out.names.has(col)) return { raw: out.raw.get(col) ?? new Set(), reads: out.reads.get(col) ?? new Set() }
      if (out.stars.length) return unionRefs(out.stars.map((st) => resolveRef(src.name, st.branch, st.qualifier, col, inner)))
      return same(unresolved(col))
    }
    if (qualifier) {
      // A qualifier names its source by alias, else by the table's last segment.
      const named = (x: Source) => x.name === qualifier || x.short === qualifier
      const src =
        srcs.find((x) => x.alias === qualifier) ?? srcs.find((x) => !x.alias && named(x)) ?? srcs.find(named)
      return src ? fromSource(src) : same(unresolved(col))
    }
    const named = srcs.filter((x) => isDerived(x, scope, seen) && resolve(x.name, inner).names.has(col))
    if (named.length) return unionRefs(named.map(fromSource))
    const open = srcs.filter((x) =>
      isDerived(x, scope, seen) ? resolve(x.name, inner).stars.length > 0 : !byScope.has(x.name),
    )
    if (open.length === 1) return fromSource(open[0])
    if (open.length > 1) return same(new Set([`${[...new Set(open.map((x) => x.name))].sort().join("|")}.${col}`]))
    return same(unresolved(col))
  }
  // An item's text for signatures: lowercased outside literals, with each
  // FROM/JOIN alias replaced by the source it names (a table by its own name,
  // without database/schema, which `refCovered` compares environment-aware via
  // `reads`; a CTE or subquery by its scope), so renaming an alias
  // (`md5(c.ssn)` → `md5(cu.ssn)` on one table) keeps the signature.
  const signatureText = (item: SelectItem, scope: string) => {
    const named = new Map<string, string>()
    for (const src of sources.get(`${scope}#${item.branch}`) ?? [])
      if (src.alias && src.alias !== src.name) named.set(src.alias, byScope.has(src.name) ? src.name : splitTable(src.name).name)
    const text = lowerOutsideLiterals(item.exact)
    if (!named.size) return text
    return text.replace(/'(?:[^']|'')*'|[^']+/g, (part) =>
      part.startsWith("'")
        ? part
        : part.replace(new RegExp(String.raw`(?<![\w$."\x60])(${SEGMENT})(\s*\.)`, "g"), (m, q: string, dot: string) => {
            const src = named.get(unquote(q))
            return src === undefined ? m : `\u0004${src}${dot}`
          }),
    )
  }
  const resolve = (scope: string, seen: Set<string>): ScopeOutputs => {
    const cached = memo.get(scope)
    if (cached) return cached
    const inner = innerOf(seen, scope)
    const raw = new Map<string, Set<string>>()
    const names = new Set<string>()
    const signatures = new Map<string, Set<string>>()
    const reads = new Map<string, Set<string>>()
    const stars: ScopeOutputs["stars"] = []
    const addTo = (map: Map<string, Set<string>>, name: string, values: Iterable<string>) => {
      const set = map.get(name) ?? new Set<string>()
      for (const v of values) set.add(v)
      map.set(name, set)
    }
    const scopeItems = byScope.get(scope) ?? []
    const firstNames = new Map(scopeItems.filter((i) => i.branch === 0).map((i) => [i.position, i.name]))
    const readBodies = new Set<string>()
    for (const item of scopeItems) {
      const derived = (sources.get(`${scope}#${item.branch}`) ?? []).filter((src) => isDerived(src, scope, seen))
      const bodies = derived.map((src) => resolve(src.name, inner).body).sort()
      for (const b of bodies) readBodies.add(b)
      if (STAR.test(item.text)) {
        const qualifier = /([^.]+)\.\*$/.exec(item.text)?.[1]
        const q = qualifier ? unquote(qualifier) : undefined
        stars.push({ branch: item.branch, qualifier: q })
        for (const src of derived) {
          if (q && src.alias !== q && src.name !== q) continue
          const out = resolve(src.name, inner)
          for (const n of out.names) names.add(n)
          for (const [n, cols] of out.raw) addTo(raw, n, cols)
          for (const [n, sigs] of out.signatures) addTo(signatures, n, [...sigs].map((sig) => `*${sig}`))
          for (const [n, cols] of out.reads) addTo(reads, n, cols)
        }
        continue
      }
      const name = item.branch === 0 ? item.name : firstNames.get(item.position)
      if (!name) continue
      names.add(name)
      addTo(signatures, name, [`${signatureText(item, scope)}\u0001${bodies.join("\u0002")}`])
      if (item.rawColumn) {
        const refs = resolveRef(scope, item.branch, item.rawQualifier, item.rawColumn, seen)
        addTo(raw, name, refs.raw)
        addTo(reads, name, refs.reads)
      } else {
        reads.set(name, reads.get(name) ?? new Set())
        for (const r of item.reads ?? []) addTo(reads, name, resolveRef(scope, item.branch, r.qualifier, r.column, seen).reads)
        // An expression whose column reads parse to nothing is not known to read
        // nothing: it is never "already exposed" by its reads (the signature may
        // still match). Only a constant reads nothing.
        if (!item.reads?.length && !item.constant) addTo(reads, name, unresolved(name))
      }
    }
    for (const [n, cols] of raw) if (!cols.size) raw.delete(n)
    const body = [scopeItems.map((i) => signatureText(i, scope)).join(","), ...[...readBodies].sort()].join("\u0003")
    const result = { raw, names, signatures, reads, stars, body }
    memo.set(scope, result)
    return result
  }
  const { raw, names, signatures, reads, stars } = resolve(ROOT_SCOPE, new Set())
  // The raw refs a `*` passes `col` through as. Unlike an unqualified column
  // read over several sources (one combined ref: it comes from exactly one of
  // them), a `*` passes every source's columns through, so each source is
  // resolved on its own: `select * from customers join spouses` exposes
  // `customers.ssn` and `spouses.ssn`, which a head `c.ssn` or `s.ssn` matches.
  // Memoised like `resolveRef`: a CTE whose `*` joins the previous one twice
  // would otherwise double the walk at every level.
  const starMemo = new Map<string, Set<string>>()
  const starRefs = (scope: string, branch: number, qualifier: string | undefined, col: string, seen: Set<string>) => {
    const memoKey = `${scope}#${branch}\u0000${qualifier ?? ""}\u0000${col}`
    const hit = starMemo.get(memoKey)
    if (hit) return hit
    const out = starRefsUncached(scope, branch, qualifier, col, seen)
    starMemo.set(memoKey, out)
    return out
  }
  const starRefsUncached = (
    scope: string,
    branch: number,
    qualifier: string | undefined,
    col: string,
    seen: Set<string>,
  ): Set<string> => {
    const srcs = sources.get(`${scope}#${branch}`) ?? []
    const named = (x: Source) => x.name === qualifier || x.short === qualifier
    const picked = qualifier
      ? [srcs.find((x) => x.alias === qualifier) ?? srcs.find((x) => !x.alias && named(x)) ?? srcs.find(named)].filter(
          (x): x is Source => !!x,
        )
      : srcs
    const inner = innerOf(seen, scope)
    const out = new Set<string>()
    for (const src of picked) {
      if (!isDerived(src, scope, seen)) {
        if (!byScope.has(src.name)) out.add(`${src.name}.${col}`)
        continue
      }
      const body = resolve(src.name, inner)
      const refs = body.names.has(col)
        ? (body.raw.get(col) ?? new Set<string>())
        : union(body.stars.map((st) => starRefs(src.name, st.branch, st.qualifier, col, inner)))
      for (const r of refs) out.add(r)
    }
    return out
  }
  const starRaw = (column: string) =>
    union(stars.map((st) => starRefs(ROOT_SCOPE, st.branch, st.qualifier, column, new Set())))
  const prefixes = new Set<string>()
  for (const list of sources.values()) for (const src of list) if (!byScope.has(src.name)) prefixes.add(splitTable(src.name).prefix)
  return { raw, names, signatures, reads, passthrough: stars.length > 0, starRaw, prefixes }
}

/** A Jinja statement tag that emits no text of its own: control flow and `set`. */
export const SILENT_JINJA_TAG = /^\{%[-+]?\s*(?:if|elif|else|endif|for|endfor|set|endset)\b[\s\S]*%\}$/

// Calls whose result does not reveal their argument: hashes, encryption and
// masking (by name, so a project's own `mask_ssn(…)` counts), a part of a
// string, a count or a length, and a date reduced to a part or a difference.
// Any other call (`coalesce`, `trim`, `max`, `replace`, a cast) keeps the value.
const MASKING_NAME =
  /hash|md5|hmac|fingerprint|encrypt|cipher|mask|redact|anonymi[sz]e|pseudonymi[sz]e|tokeni[sz]e|obfuscate|scramble|(?:^|_)(?:sha|crc)(?:\d|_|$)/i
const MASKING_EXACT = new Set(
  "left right substr substring regexp_replace translate length len char_length character_length count count_if countif approx_count_distinct datediff date_diff timestampdiff timestamp_diff months_between age date_trunc datetrunc extract date_part datepart year".split(
    " ",
  ),
)
// `unmask(…)`, `decrypt(…)`, `detokenize(…)` undo one.
const isMaskingCall = (name: string) =>
  MASKING_EXACT.has(name.toLowerCase()) || (MASKING_NAME.test(name) && !/^(?:de|un)/i.test(name))
const NULL_TEST = new RegExp(String.raw`(?<![\w$."\x60])${COLUMN_REF}\s+is\s+(?:not\s+)?null\b`, "gi")

/**
 * The columns an expression item reads in a way that keeps their value: every
 * read except those inside a masking call (`sha2(ssn)`, `right(ssn, 4)`), a
 * null test (`ssn is null`), a window or filter clause, or a query nested in
 * the item (its own scope). `coalesce(ssn, '')`, `max(ssn)`, `case … then ssn
 * end` and `replace(ssn, '-', '')` still read `ssn`.
 */
function unmaskedReads(text: string): Array<{ qualifier?: string; column: string }> {
  let e = splitAlias(text).expr
  for (let m = /\(\s*select\b/i.exec(e); m; m = /\(\s*select\b/i.exec(e))
    e = `${e.slice(0, m.index)} ${e.slice(closingParen(e, m.index) + 1)}`
  const call = /(?<![\w$."\x60])((?:[A-Za-z_][\w$]*\s*\.\s*)*)([A-Za-z_][\w$]*)\s*\(/g
  for (let m = call.exec(e); m; m = call.exec(e)) {
    if (!isMaskingCall(m[2])) continue
    const open = m.index + m[0].length - 1
    e = `${e.slice(0, m.index)} ${e.slice(closingParen(e, open) + 1)}`
    call.lastIndex = m.index
  }
  return columnReads(e.replace(NULL_TEST, " "))
}

/** What a `*` select item passes on: which source it spans and under which
 *  names it carries a column (`* exclude (a)`, `* except (a)`, `* replace (f(a)
 *  as a)`, `* rename (a as b)`, in any combination). `undefined` for an item
 *  that is not a star; `opaque` for one whose columns cannot be named
 *  (`object_construct(*)`, `struct(t.*)`, `* ilike '…'`). */
interface StarItem {
  qualifier?: string
  opaque?: boolean
  /** The names `column` leaves the star under: none when it is excluded or
   *  replaced by an expression, its new name when renamed. */
  carries: (column: string) => string[]
}

const STAR_HEAD = new RegExp(String.raw`^((?:${SEGMENT}\s*\.\s*)*)\*`)
const SEGMENT_ONLY = new RegExp(String.raw`^${SEGMENT}$`)

function starItem(text: string): StarItem | undefined {
  const head = STAR_HEAD.exec(text)
  if (!head) {
    // A `*` inside the item that is not a multiplication (an operand on both
    // sides): `object_construct(*)`, `struct(t.*)`, `as struct *`. `count(*)`
    // reads no column.
    const t = text.replace(/\bcount\s*\(\s*\*\s*\)/gi, " ")
    for (let i = t.indexOf("*"); i >= 0; i = t.indexOf("*", i + 1)) {
      const prev = /(\S)\s*$/.exec(t.slice(0, i))?.[1]
      const next = /^\s*(\S)/.exec(t.slice(i + 1))?.[1]
      const product = !!prev && /[\w$)"'\x60\]]/.test(prev) && !!next && /[\w$("'\x60.+-]/.test(next)
      if (!product) return { opaque: true, carries: (c) => [c] }
    }
    return undefined
  }
  const segments = [...head[1].matchAll(new RegExp(SEGMENT, "g"))].map((m) => unquote(m[0]))
  const qualifier = segments.length ? segments[segments.length - 1] : undefined
  const dropped = new Set<string>()
  // Entries of `replace (…)` then `rename (…)`, in the order they apply: the
  // columns each entry's value comes from (unmasked), and its name.
  const steps: Array<{ kind: "replace" | "rename"; from: string[]; to: string }> = []
  let rest = text.slice(head[0].length)
  while (rest.trim()) {
    const m = /^\s*(exclude|except|replace|rename)\b\s*/i.exec(rest)
    if (!m) return { qualifier, opaque: true, carries: (c) => [c] }
    rest = rest.slice(m[0].length)
    let list: string
    if (rest.startsWith("(")) {
      const close = closingParen(rest, 0)
      list = rest.slice(1, close)
      rest = rest.slice(close + 1)
    } else {
      // One bare entry: `exclude ssn`, `rename a as b`.
      const bare = new RegExp(String.raw`^${SEGMENT}(?:\s+as\s+${SEGMENT})?`, "i").exec(rest)
      if (!bare) return { qualifier, opaque: true, carries: (c) => [c] }
      list = bare[0]
      rest = rest.slice(bare[0].length)
    }
    const kind = m[1].toLowerCase()
    for (const entry of topLevelItems(list)) {
      if (!entry.trim()) continue
      if (kind === "exclude" || kind === "except") {
        if (!SEGMENT_ONLY.test(entry.trim())) return { qualifier, opaque: true, carries: (c) => [c] }
        dropped.add(unquote(entry.trim()))
        continue
      }
      // `expr as name`: a raw column under `name`, or an expression that masks it.
      const item = describeItem(entry)
      const { alias } = splitAlias(item.text)
      if (!alias) return { qualifier, opaque: true, carries: (c) => [c] }
      const from = item.rawColumn ? [item.rawColumn] : unmaskedReads(item.text).map((r) => r.column)
      steps.push({ kind: kind as "replace" | "rename", from, to: unquote(alias) })
    }
  }
  const carries = (column: string) => {
    if (dropped.has(column)) return []
    let names = new Set([column])
    for (const step of steps) {
      if (step.kind === "rename") {
        if (step.from.some((f) => names.delete(f))) names.add(step.to)
        continue
      }
      // `replace (expr as to)`: `to` now holds `expr`. It still holds the column
      // only when `expr` reads it unmasked.
      const kept = step.from.some((f) => names.has(f))
      names.delete(step.to)
      if (kept) names.add(step.to)
    }
    return [...names]
  }
  return { qualifier, carries }
}

const wordIn = (text: string | undefined, word: string, dotted = true) =>
  !!text &&
  new RegExp(
    `(?<![\\w$${dotted ? "" : "."}])["\x60]?${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["\x60]?(?![\\w$${dotted ? "" : "."}])`,
    "i",
  ).test(text)

/** Whether raw columns of a model's SQL can reach its final output raw. */
export interface RawReach {
  /** Every select item of the SQL, as `selectItems` returns them. */
  items: SelectItem[]
  /** The item's output keeps `column`'s value: it selects it raw, or reads it in
   *  an expression outside any masking call (`coalesce(ssn, '')`, not `sha2(ssn)`). */
  carries: (item: SelectItem, column: string) => boolean
  /** The value this item outputs may reach the model's final output unmasked. */
  reaches: (item: SelectItem) => boolean
  /** The item may pass `column`'s value on to the final output unmasked: it
   *  carries it and reaches the output, or is a `*` that does not exclude or
   *  mask it and whose name for it reaches the output. */
  passes: (item: SelectItem, column: string) => boolean
  /** The final output may expose a column named `column` raw: through an item
   *  that carries it and reaches the output, or through a `*` (or a Jinja
   *  column list) over a table whose columns the SQL does not list. */
  mayExpose: (column: string) => boolean
  /** The 1-based `line` sits in a clause that selects nothing: the nearest
   *  clause word before it, outside closed parentheses, is `where`, `group by`,
   *  `order by`, `partition by`, `having`, `qualify`, `on`, `using`, `from` or
   *  `join`. `false` when that cannot be told (no clause word, or `select`). */
  inClause: (line: number) => boolean
}

// Jinja expressions are masked to `_`, a word character: one glued to a clause
// word (`{{ config() }}select`, `from{{ ref('x') }}`) hides that word.
const JINJA_GLUED_KEYWORD =
  /\}\}(?=(?:select|from|join|union|intersect|except|minus|with|where|on|using|as)\b)|(?<![\w$])(?:select|from|join|union|intersect|except|minus|with|where|on|using|as)(?=\{\{)/i
const CLAUSE_WORD =
  /^(select|from|join|where|group\s+by|order\s+by|partition\s+by|having|qualify|on|using|limit|offset|window|with|union|intersect|except|minus|fetch|into|values)\b/i
const SELECTS_NOTHING = /^(?:from|join|where|group\s+by|order\s+by|partition\s+by|having|qualify|on|using)$/i

/**
 * Follows a raw column from the select item that reads it to the model's final
 * output, on SQL that may still hold Jinja. The answer is "may reach": it is
 * `false` only when every query that can read the item's scope is known and
 * none passes the column on raw, so an unknown shape counts as reaching.
 *
 * An item of the final select reaches the output. An item of a CTE or a FROM
 * subquery reaches it when a query reading that scope (in its FROM/JOIN list,
 * or correlated from a query nested in one that does) selects the item's
 * output name raw, or through a `*` that spans the scope and neither excludes
 * nor masks it, or in an expression that keeps its value (`coalesce(x, '')`,
 * `max(x)`), and that query's own output reaches it in turn (`with a as (select
 * ssn as x …), b as (select x from a) select x from b`). A query that reads the
 * name only inside masking calls (`sha2(x)`, `right(x, 4)`), or does not select
 * it, stops it.
 *
 * Counted as reaching, because the names leaving them are unknown:
 * a nested query that is not a FROM source (a scalar subquery in a select
 * list, a `lateral` subquery, a parenthesised set-operation branch); a reader
 * whose source list names the column (`unpivot (v for k in (ssn))`,
 * `unnest(s.ssn)`); a reader selecting the scope as a whole row (`select s`,
 * `to_json(s)`), expanding it as a struct (`ssn.*`), with a `*` that cannot be
 * named (`object_construct(*)`), or with a Jinja expression that may stand for
 * columns; a reader whose sources did not parse, matched by name alone; and any
 * SQL with a CTE column list, a parenthesised `with`, `select as struct`, a
 * clause word used as a column name, a Jinja expression glued to a clause word,
 * or a Jinja statement other than control flow. The operand of `in` / `exists`
 * / `any` / `some` / `all` decides a condition and reaches nothing.
 */
export function rawReach(sql: string): RawReach {
  const { items, sources, sourceText, unknownSources, predicates, unmodelled, jinjaItems } = parseSelects(sql)
  const opaque =
    unmodelled ||
    JINJA_GLUED_KEYWORD.test(sql) ||
    !(sql.match(/\{%[\s\S]*?%\}/g) ?? []).every((t) => SILENT_JINJA_TAG.test(t))
  const byKey = new Map<string, SelectItem[]>()
  const firstNames = new Map<string, string | undefined>()
  for (const item of items) {
    const key = `${item.scope}#${item.branch}`
    const list = byKey.get(key)
    if (list) list.push(item)
    else byKey.set(key, [item])
    if (item.branch === 0) firstNames.set(`${item.scope}\u0000${item.position}`, item.name)
  }
  // A later set-operation branch outputs under the first branch's name.
  const outName = (item: SelectItem) =>
    item.branch === 0 ? item.name : (firstNames.get(`${item.scope}\u0000${item.position}`) ?? item.name)
  const scopes = new Set(items.map((i) => i.scope))
  const fromSubqueries = new Set<string>()
  for (const list of sources.values()) for (const src of list) if (src.name.includes(">")) fromSubqueries.add(src.name)
  const inPredicate = (scope: string) => {
    for (let at = scope.length; at > 0; at = scope.lastIndexOf(">", at - 1)) if (predicates.has(scope.slice(0, at))) return true
    return false
  }
  const naming = (src: Source) => [src.alias, src.name, src.short].filter((x): x is string => !!x)
  // Every select whose rows can reach an output (not the operand of a
  // condition), with the selects it is nested in, at any depth.
  const keyed = [...sources.keys()].map((key) => ({ key, scope: key.slice(0, key.lastIndexOf("#")) }))
  const selects = keyed
    .filter((sel) => !inPredicate(sel.scope))
    .map((sel) => ({ ...sel, outer: keyed.filter((o) => sel.scope.startsWith(`${o.scope}>`)) }))
  const stars = new Map<SelectItem, StarItem | undefined>()
  const starOf = (item: SelectItem) => {
    if (!stars.has(item)) stars.set(item, starItem(item.text))
    return stars.get(item)
  }
  // An expression item's unmasked reads. A `*` item names no column it reads
  // (`* exclude (ssn)`), and a raw item is its column.
  const readsByItem = new Map<SelectItem, Array<{ qualifier?: string; column: string }>>()
  const readsOf = (item: SelectItem) => {
    let reads = readsByItem.get(item)
    if (!reads) readsByItem.set(item, (reads = item.rawColumn || starOf(item) ? [] : unmaskedReads(item.text)))
    return reads
  }

  const reach = (scope: string, name: string | undefined, seen: Set<string>): boolean => {
    if (scope === ROOT_SCOPE) return true
    if (scope.includes(">")) {
      if (inPredicate(scope)) return false
      // Not a FROM source: a scalar subquery, a lateral or a set-operation branch.
      if (!fromSubqueries.has(scope)) return true
    }
    if (!name) return true
    const visit = `${scope}\u0000${name}`
    if (seen.has(visit)) return false
    seen.add(visit)
    for (const sel of selects) {
      const own = (sources.get(sel.key) ?? []).filter((src) => src.name === scope)
      const outerSelects = sel.outer
      const outer = outerSelects.flatMap((o) => (sources.get(o.key) ?? []).filter((src) => src.name === scope))
      // Sources that did not parse, here or in an enclosing select, or a list
      // that names the scope without parsing it as a source.
      const blind =
        unknownSources.has(sel.key) ||
        outerSelects.some((o) => unknownSources.has(o.key)) ||
        (!own.length && !scope.includes(">") && wordIn(sourceText.get(sel.key), scope, false))
      if (!own.length && !outer.length && !blind) continue
      // A table function, `unpivot` or array join over the column moves its
      // values under another name.
      if (wordIn(sourceText.get(sel.key), name)) return true
      const scopeNames = new Set([...own, ...outer].flatMap(naming))
      const otherNames = new Set(
        [sel, ...outerSelects].flatMap((x) => (sources.get(x.key) ?? []).filter((src) => src.name !== scope).flatMap(naming)),
      )
      // A qualifier names the scope, or no source the parser knows: an alias it
      // did not read (`src pivot (…) p`) may still be the scope, so that counts.
      const fromScope = (qualifier?: string) =>
        !qualifier || blind || scopeNames.has(qualifier) || !otherNames.has(qualifier)
      for (const item of byKey.get(sel.key) ?? []) {
        if (jinjaItems.has(item)) return true
        const star = starOf(item)
        if (star) {
          // An unqualified `*` spans the select's own sources only.
          if (star.qualifier ? !fromScope(star.qualifier) : !own.length && !blind) continue
          // `x.*` over a struct column named like the output expands its fields.
          if (star.qualifier === name && !scopeNames.has(name)) return true
          if (star.opaque) return true
          if (star.carries(name).some((carried) => reach(sel.scope, carried, seen))) return true
          continue
        }
        // The name selected raw, or read by an expression that keeps its value.
        const keeps = item.rawColumn
          ? item.rawColumn === name && fromScope(item.rawQualifier)
          : readsOf(item).some((r) => r.column === name && fromScope(r.qualifier))
        if (keeps) {
          if (reach(sel.scope, outName(item), seen)) return true
          continue
        }
        // The scope as a whole row: `select s from src s`, `to_json(s)`.
        const row = (r: { qualifier?: string; column: string }) => !r.qualifier && scopeNames.has(r.column)
        if (item.rawColumn ? !item.rawQualifier && scopeNames.has(item.rawColumn) : readsOf(item).some(row)) return true
      }
    }
    return false
  }
  const memo = new Map<string, boolean>()
  const reachMemo = (scope: string, name: string | undefined) => {
    const key = `${scope}\u0000${name ?? "\u0000"}`
    let out = memo.get(key)
    if (out === undefined) memo.set(key, (out = reach(scope, name, new Set())))
    return out
  }
  const carries = (item: SelectItem, column: string) =>
    item.rawColumn ? item.rawColumn === column : readsOf(item).some((r) => r.column === column)
  const reaches = (item: SelectItem) => opaque || reachMemo(item.scope, outName(item))
  const passes = (item: SelectItem, column: string) => {
    const star = starOf(item)
    if (!star) return carries(item, column) && reaches(item)
    if (star.opaque) return opaque || reachMemo(item.scope, undefined)
    return star.carries(column).some((name) => opaque || reachMemo(item.scope, name))
  }
  const exposeMemo = new Map<string, boolean>()
  const mayExpose = (column: string) => {
    if (opaque) return true
    let out = exposeMemo.get(column)
    if (out !== undefined) return out
    out =
      items.some((i) => carries(i, column) && reaches(i)) ||
      selects.some((sel) => {
        // A select reading a table whose columns are not listed in the SQL.
        const tables = (sources.get(sel.key) ?? []).filter((src) => !scopes.has(src.name))
        if (!tables.length && !unknownSources.has(sel.key)) return false
        const tableNames = new Set(tables.flatMap(naming))
        const derivedNames = new Set((sources.get(sel.key) ?? []).filter((src) => scopes.has(src.name)).flatMap(naming))
        return (byKey.get(sel.key) ?? []).some((item) => {
          if (jinjaItems.has(item)) return reachMemo(sel.scope, column)
          const star = starOf(item)
          if (star) {
            // A `*` qualified by a CTE or subquery passes that scope's columns only.
            if (star.qualifier && derivedNames.has(star.qualifier) && !tableNames.has(star.qualifier)) return false
            return star.opaque ? reachMemo(sel.scope, column) : star.carries(column).some((c) => reachMemo(sel.scope, c))
          }
          // A table as a whole row.
          return !!item.rawColumn && !item.rawQualifier && tableNames.has(item.rawColumn) && reachMemo(sel.scope, column)
        })
      })
    exposeMemo.set(column, out)
    return out
  }
  let masked: string | undefined
  let lineStarts: number[] | undefined
  const inClause = (line: number) => {
    masked ??= maskSql(sql)
    if (!lineStarts) {
      lineStarts = [0]
      for (let i = 0; i < masked.length; i++) if (masked[i] === "\n") lineStarts.push(i + 1)
    }
    const start = lineStarts[line - 1]
    if (start === undefined) return false
    // Backwards from the line, skipping parentheses that closed before it.
    let depth = 0
    for (let i = start - 1; i >= 0; i--) {
      const c = masked[i]
      if (c === ")") depth++
      else if (c === "(") depth = Math.max(0, depth - 1)
      else if (depth === 0 && !isWordChar(masked[i - 1]) && /[a-z]/i.test(c)) {
        const word = CLAUSE_WORD.exec(masked.slice(i, i + 24))
        if (word) return SELECTS_NOTHING.test(word[1].replace(/\s+/g, " "))
      }
    }
    return false
  }
  return { items, carries, reaches, passes, mayExpose, inClause }
}

/** A diff line with comments and whitespace normalised (and a leading/trailing
 *  select-list comma dropped), so a reindented line compares equal to its base. */
export function normalizeSelectLine(line: string): string {
  return stripComments(line)
    .replace(/\s+/g, " ")
    .replace(/\s*([(),])\s*/g, "$1")
    .trim()
    .replace(/^,|,$/g, "")
}

/** Column tokens (with aliases) of `rule.capturesColumns` over the added lines `rule.added` matches. */
function capturedColumns(rule: Rule, added: string[]): SelectItemColumn[] {
  const out: SelectItemColumn[] = []
  for (const l of added) {
    const s = stripComments(l)
    if (!rule.capturesColumns || !rule.added?.test(s) || rule.unless?.test(s)) continue
    out.push(...selectItemColumns(l, rule.capturesColumns))
  }
  return out
}

/** Evaluate the catalog against a changed file. */
export function evaluateCatalog(
  file: ChangedFile,
  newSql: string,
  added: string[],
  removed: string[],
  rubric: Rubric,
): Finding[] {
  const input: RuleInput = { file, newSql, added, removed }
  const model = modelName(file.path)
  const matched: { rule: Rule; finding: Finding }[] = []
  for (const rule of CATALOG) {
    if (!ruleMatches(rule, input)) continue
    const f = makeFinding({
      severity: clampSeverity(rule.category, rule.severity, "high"),
      category: rule.category,
      title: `${model}: ${rule.title}`,
      body: rule.body,
      file: file.path,
      model,
      confidence: "high",
      evidence: {
        tool: "rule-catalog",
        result: rule.portability
          ? { rule: rule.id, portability: true, worksOn: rule.portability.worksOn }
          : rule.capturesColumns
            ? (() => {
                const items = capturedColumns(rule, added)
                return { rule: rule.id, columns: [...new Set(items.map((i) => i.column))], items }
              })()
            : { rule: rule.id },
      },
      ruleKey: `${rule.category}:${rule.id}`,
    })
    if (!exclusionReason(f, rubric)) matched.push({ rule, finding: f })
  }

  // The generated `fn-<name>` rules (rule-generators.ts) are a long-tail
  // portability net. When a dedicated hand-written rule already flags the same
  // function on this file, drop the generic one so the reviewer doesn't repeat
  // the same advice. We treat a function as "already covered" if a non-generated
  // finding mentions it in call form `NAME(` or backticked `NAME`.
  const covered = new Set<string>()
  for (const { rule, finding } of matched) {
    if (rule.id.startsWith("fn-")) continue
    const text = `${finding.title} ${finding.body}`
    for (const m of text.matchAll(/`([A-Za-z_][A-Za-z0-9_.]*)`|\b([A-Za-z_][A-Za-z0-9_]+)\s*\(/g)) {
      covered.add((m[1] ?? m[2]).toLowerCase())
    }
  }
  return matched
    .filter(({ rule }) => !(rule.id.startsWith("fn-") && covered.has(rule.id.slice(3))))
    .map(({ finding }) => finding)
}

/** Build a RuleInput from an example (for the catalog self-test). */
export function inputFromExample(ex: RuleExample, kind: RuleKind = "model_sql"): RuleInput {
  const defaultPath =
    kind === "schema_yml" ? "models/marts/_models.yml" : kind === "snapshot" ? "snapshots/s.sql" : "models/marts/m.sql"
  const file: ChangedFile = { path: ex.path ?? defaultPath, status: "modified" }
  const added = ex.add ? ex.add.split("\n") : []
  const removed = ex.remove ? ex.remove.split("\n") : []
  const newSql = ex.newSql ?? ex.add ?? ""
  return { file, newSql, added, removed }
}

// ===========================================================================
// RULE CATALOG — grouped by concern. Each entry is a real-world review catch.
// ===========================================================================

const r = (
  id: string,
  category: ReviewCategory,
  severity: Severity,
  title: string,
  body: string,
  match: Pick<Rule, "added" | "removed" | "newSql" | "absentNewSql" | "unless" | "kind" | "pathGlob" | "portability" | "capturesColumns">,
  example: RuleExample,
  counter?: RuleExample,
): Rule => ({ id, category, severity, title, body, ...match, example, counter })

export const CATALOG: Rule[] = []

const CORRECTNESS: Rule[] = [
  r(
    "not-exists-suggested",
    "sql_correctness",
    "suggestion",
    "consider NOT EXISTS over NOT IN",
    "Prefer NOT EXISTS / LEFT JOIN … IS NULL; NOT IN breaks on NULLs and is slower.",
    { added: /\bnot\s+in\s*\(/i },
    { add: "where id not in (1,2,3)" },
    { add: "where id in (1,2,3)" },
  ),
  r(
    "in-subquery-large",
    "warehouse_cost",
    "suggestion",
    "IN (subquery) — consider a semi-join",
    "A correlated/large IN-subquery is often better as an EXISTS or JOIN for the optimizer.",
    { added: /\bin\s*\(\s*select\b/i },
    { add: "where id in (select id from x)" },
    { add: "where id in (1,2)" },
  ),
  r(
    "scalar-subquery-select",
    "warehouse_cost",
    "suggestion",
    "scalar subquery in SELECT runs per row",
    "A `(select …)` in the SELECT list can execute per output row; a JOIN is usually cheaper.",
    { added: /select[^;]*,\s*\(\s*select\b/i },
    { add: "select a, (select max(b) from t) from x" },
    { add: "select a, b from x" },
  ),
  r(
    "union-not-all",
    "warehouse_cost",
    "suggestion",
    "UNION dedups — use UNION ALL if disjoint",
    "`UNION` adds a distinct pass; if inputs can't overlap, `UNION ALL` is far cheaper.",
    { added: /\bunion\b(?!\s+all)/i },
    { add: "select 1 union select 2" },
    { add: "select 1 union all select 2" },
  ),
  r(
    "intersect-perf",
    "warehouse_cost",
    "suggestion",
    "INTERSECT/EXCEPT can be expensive",
    "Set operators sort/hash both sides; confirm a join wouldn't be clearer and cheaper.",
    { added: /\b(intersect|except|minus)\b/i },
    { add: "select a from x except select a from y" },
    { add: "select a from x" },
  ),
  r(
    "having-row-filter",
    "sql_correctness",
    "suggestion",
    "row predicate in HAVING belongs in WHERE",
    "Filtering non-aggregated columns in HAVING is slower and often a bug; move to WHERE.",
    { added: /\bhaving\b.*(=|<|>|like)/i, unless: /\b(count|sum|avg|min|max)\s*\(/i },
    { add: "having status = 'x'" },
    { add: "having count(*) > 1" },
  ),
  r(
    "distinct-and-group-by",
    "sql_correctness",
    "suggestion",
    "DISTINCT together with GROUP BY is redundant",
    "Using DISTINCT on an already-grouped query is redundant and signals confusion about grain.",
    { newSql: /select\s+distinct[\s\S]*\bgroup\s+by\b/i },
    { add: "select distinct a, count(*) from t group by a" },
    { add: "select a, count(*) from t group by a" },
  ),
  r(
    "count-star-nullable",
    "sql_correctness",
    "suggestion",
    "COUNT(col) skips NULLs — confirm intent",
    "`COUNT(col)` ignores NULLs while `COUNT(*)` counts rows; make sure the right one is used.",
    { added: /\bcount\s*\(\s*(?!distinct|\*)[a-z_]/i },
    { add: "select count(amount) from t" },
    { add: "select count(*) from t" },
  ),
  r(
    "nested-aggregate",
    "sql_correctness",
    "warning",
    "nested aggregate is invalid / needs a subquery",
    "Aggregates can't be nested directly (e.g. SUM(COUNT(...))); pre-aggregate in a CTE.",
    { added: /\b(sum|avg|min|max)\s*\(\s*(count|sum|avg|min|max)\s*\(/i },
    { add: "select sum(count(id)) from t" },
    { add: "select sum(amount) from t" },
  ),
  r(
    "group-by-positional",
    "sql_quality",
    "suggestion",
    "GROUP BY positional refs are fragile",
    "`GROUP BY 1,2` breaks silently when the SELECT list reorders; group by explicit names.",
    { added: /\bgroup\s+by\s+\d+(\s*,\s*\d+)+/i },
    { add: "group by 1, 2" },
    { add: "group by customer_id" },
  ),
  r(
    "order-by-positional",
    "sql_quality",
    "suggestion",
    "ORDER BY positional refs are fragile",
    "`ORDER BY 1` breaks when columns reorder; order by explicit names.",
    { added: /\border\s+by\s+\d+/i },
    { add: "order by 1" },
    { add: "order by created_at" },
  ),
  r(
    "select-into",
    "sql_correctness",
    "critical",
    "SELECT INTO / CREATE TABLE inside a model",
    "Models must be a single SELECT — dbt owns materialization. Remove the DDL.",
    { added: /\b(select\s+[^;]*\binto\b|create\s+table)\b/i },
    { add: "select * into new_t from t" },
    { add: "select * from t" },
  ),
  r(
    "temp-table",
    "sql_correctness",
    "warning",
    "temp table created in a model",
    "Creating #temp/temporary tables in a model bypasses dbt's DAG and materialization.",
    { added: /\bcreate\s+(temp|temporary|#)/i },
    { add: "create temp table tmp as select 1" },
    { add: "with tmp as (select 1)" },
  ),
  // reserved-word-alias removed: the compiled core's `review_lexical_scan` owns
  // reserved-word detection (308-word curated list in the binary).
]

const NULLS: Rule[] = [
  r(
    "coalesce-mismatched-type",
    "sql_correctness",
    "suggestion",
    "COALESCE with mismatched types",
    "`coalesce(num, 'n/a')` mixes types and errors or implicitly casts; keep branches same-typed.",
    { added: /coalesce\s*\(\s*(\d+\s*,\s*'|'[^']*'\s*,\s*\d)/i },
    { add: "coalesce(0, 'none')" },
    { add: "coalesce(amount, 0)" },
  ),
  // NOTE: division-without-guard is handled by the literal-safe
  // `detectDivisionNoGuard` detector and (once shipped) core's AST rule L032 —
  // a regex catalog twin here would double-report and trip on `/` inside string
  // literals, so it is intentionally omitted.
  // isnull/nvl portability is owned by core L033 (dialect-aware: silent on
  // Snowflake/Redshift/etc. that support NVL). A non-dialect-aware TS regex twin
  // here false-flagged NVL on its native warehouses (measured FP).
  r(
    "null-concat",
    "sql_correctness",
    "suggestion",
    "string concat with a possibly-NULL operand",
    "In many dialects `'x' || null` is NULL; concatenating a nullable column can blank the result.",
    { added: /\|\|/ },
    { add: "select first_name || last_name" },
    { add: "select a + b" },
  ),
]

const DATETIME: Rule[] = [
  r(
    "now-in-filter",
    "idempotency",
    "warning",
    "current date/time in a filter — sliding window",
    "A `now()`/`current_date` predicate makes the result depend on run time (non-idempotent).",
    { added: /\bwhere\b[^;]*\b(current_date|current_timestamp|now|getdate|sysdate)\b/i },
    { add: "where created_at > current_date - 7" },
    { add: "where created_at > '2024-01-01'" },
  ),
  r(
    "dateadd-from-now",
    "idempotency",
    "warning",
    "DATEADD/INTERVAL from current time",
    "Computing windows from `now()` shifts row membership every run; anchor to a var/column.",
    { added: /(dateadd|date_add|date_sub|interval)[^;]*\b(current_date|current_timestamp|now|getdate)\b/i },
    { add: "where ts > dateadd(day,-7,current_date)" },
    { add: "where ts > dateadd(day,-7,'2024-01-01')" },
  ),
  r(
    "timezone-naive-now",
    "sql_correctness",
    "suggestion",
    "naive now() ignores timezone",
    "Bare `now()`/`current_timestamp` uses session TZ; be explicit for cross-region correctness.",
    { added: /\bcurrent_timestamp\b(?!\s*\(\s*\))/i },
    { add: "select current_timestamp" },
    { add: "select current_timestamp() as _loaded_at" },
  ),
  r(
    "string-date-compare",
    "sql_correctness",
    "suggestion",
    "comparing a date column to a string literal",
    "Relying on implicit string→date casts is fragile; cast explicitly to date/timestamp.",
    { added: /\b\w*(date|_at|_ts)\b\s*(=|>|<|>=|<=)\s*'\d{4}\/\d/i },
    { add: "where order_date >= '2024/01/01'" },
    { add: "where order_date >= date '2024-01-01'" },
  ),
  r(
    "extract-on-partition",
    "warehouse_cost",
    "suggestion",
    "EXTRACT/DATE_PART on a date column in WHERE",
    "Wrapping the date column in EXTRACT/DATE_PART defeats partition pruning; use a range.",
    { added: /\bwhere\b[^;]*\b(extract|date_part)\s*\(/i },
    { add: "where extract(month from d) = 1" },
    { add: "where d >= '2024-01-01'" },
  ),
  r(
    "datediff-arg-order",
    "sql_correctness",
    "suggestion",
    "verify DATEDIFF argument order",
    "DATEDIFF arg order differs by warehouse (start,end vs end,start) — sign bugs are common.",
    { added: /\bdatediff\s*\(/i },
    { add: "select datediff(day, a, b)" },
    { add: "select date_diff_safe(a,b)" },
  ),
]

const TYPES: Rule[] = [
  r(
    "implicit-cast-compare",
    "sql_correctness",
    "suggestion",
    "implicit type cast in comparison",
    "Comparing a string column to a number (or vice-versa) forces an implicit cast and can mis-match.",
    { added: /\b\w+_(id|code|zip)\b\s*=\s*\d+/i },
    { add: "where zip_code = 90210" },
    { add: "where zip_code = '90210'" },
  ),
  r(
    "cast-float-to-int",
    "sql_correctness",
    "suggestion",
    "cast to INT truncates, not rounds",
    "`cast(x as int)` truncates toward zero; use round()/floor() if rounding is intended.",
    { added: /cast\s*\([^)]*\bas\s+(int|integer|int64|smallint)\b/i },
    { add: "cast(amount as int)" },
    { add: "cast(amount as numeric)" },
  ),
  r(
    "varchar-fixed-size",
    "contract_violation",
    "suggestion",
    "fixed VARCHAR(n) can truncate",
    "`varchar(n)` silently truncates longer strings on some warehouses; prefer unbounded string.",
    { added: /\b(varchar|char)\s*\(\s*\d+\s*\)/i },
    { add: "cast(name as varchar(20))" },
    { add: "cast(name as string)" },
  ),
  r(
    "boolean-as-int",
    "sql_quality",
    "suggestion",
    "boolean stored as 0/1 int",
    "Encoding booleans as 0/1 loses type safety; use a real boolean.",
    { added: /\bcase\s+when\b[^;]*\bthen\s+1\b[^;]*\belse\s+0\b/i },
    { add: "case when x then 1 else 0 end" },
    { add: "case when x then 'a' else 'b' end" },
  ),
  r(
    "string-trim-missing",
    "sql_quality",
    "suggestion",
    "join/compare on un-trimmed string",
    "Comparing raw strings without trim()/lower() causes silent mismatches on whitespace/case.",
    { added: /\bon\s+\w+\.\w*(name|email|code)\b\s*=\s*\w+\.\w/i },
    { add: "on a.email = b.email" },
    { add: "on lower(a.email) = lower(b.email)" },
  ),
]

const JOINS: Rule[] = [
  r(
    "right-join",
    "sql_quality",
    "suggestion",
    "RIGHT JOIN is hard to read — prefer LEFT",
    "RIGHT JOINs are error-prone to reason about; reorder tables and use LEFT JOIN.",
    { added: /\bright\s+(outer\s+)?join\b/i },
    { add: "right join orders o on o.id = c.id" },
    { add: "left join orders o on o.id = c.id" },
  ),
  r(
    "full-outer-join",
    "join_risk",
    "suggestion",
    "FULL OUTER JOIN — verify both-null rows handled",
    "FULL OUTER JOINs produce rows with NULLs on either side; coalesce keys and confirm grain.",
    { added: /\bfull\s+(outer\s+)?join\b/i },
    { add: "full outer join b on a.id=b.id" },
    { add: "inner join b on a.id=b.id" },
  ),
  r(
    "join-no-on",
    "join_risk",
    "critical",
    "JOIN without ON / USING — cartesian product",
    "A JOIN with no ON clause is a cross join; add the join key.",
    { added: /\bjoin\s+[\w.`'{}() ]+\s+(where|group|order|having|;|$)/i },
    { add: "join orders where x = 1" },
    { add: "join orders on a=b" },
  ),
  r(
    "using-join",
    "join_risk",
    "suggestion",
    "JOIN USING can hide NULL/ambiguity",
    "`USING(col)` joins on equality and merges columns; an explicit `ON` is clearer and safer.",
    { added: /\bjoin\b[^;]*\busing\s*\(/i },
    { add: "join b using (id)" },
    { add: "join b on a.id=b.id" },
  ),
  r(
    "multiple-left-joins",
    "fanout",
    "suggestion",
    "several LEFT JOINs to detail tables — fan-out risk",
    "Chaining LEFT JOINs to one-to-many tables multiplies rows; pre-aggregate before joining.",
    { newSql: /left\s+join[\s\S]*left\s+join[\s\S]*left\s+join/i },
    { add: "a left join b on x left join c on y left join d on z" },
    { add: "a left join b on x" },
  ),
  r(
    "join-on-cast",
    "join_risk",
    "suggestion",
    "join key wrapped in CAST/function",
    "Casting a column inside the ON clause defeats key pruning and signals a type mismatch.",
    { added: /\bon\b[^;]*\bcast\s*\(/i },
    { add: "on cast(a.id as string) = b.id" },
    { add: "on a.id = b.id" },
  ),
  r(
    "join-or-condition",
    "join_risk",
    "warning",
    "OR in a join condition — explosive/slow",
    "`JOIN … ON a=b OR c=d` often produces a near-cartesian and disables hash joins. Split into UNION.",
    { added: /\bon\b[^;]*\bor\b/i },
    { add: "on a.id=b.id or a.alt=b.alt" },
    { add: "on a.id=b.id and a.k=b.k" },
  ),
  r(
    "lateral-join",
    "warehouse_cost",
    "suggestion",
    "LATERAL/CROSS APPLY runs per row",
    "Lateral joins execute the subquery per outer row; verify it's necessary and bounded.",
    { added: /\b(cross\s+apply|outer\s+apply|lateral)\b/i },
    { add: "cross apply (select 1) x" },
    { add: "join x on 1=1" },
  ),
  r(
    "unqualified-column-multi-table",
    "sql_quality",
    "suggestion",
    "unqualified column with multiple tables",
    "With joins present, unqualified columns are ambiguous and break when both sides add the name.",
    { newSql: /select\s+\w+\s*,[\s\S]*\bjoin\b/i },
    { add: "select id, name from a join b on a.k=b.k" },
    { add: "select a.id from a join b on a.k=b.k" },
  ),
  r(
    "self-join-no-inequality",
    "fanout",
    "suggestion",
    "self-join without an inequality may duplicate",
    "Self-joining on equality alone yields mirror/self pairs; add `a.id < b.id` to dedupe.",
    { newSql: /from\s+(\w+)\s+\w+[\s\S]*join\s+\1\s+/i },
    { add: "from t a join t b on a.k=b.k" },
    { add: "from t a join u b on a.k=b.k" },
  ),
]

const AGG: Rule[] = [
  r(
    "avg-of-avg",
    "sql_correctness",
    "warning",
    "AVG of an AVG is statistically wrong",
    "Averaging pre-averaged values isn't the overall average; aggregate from the base grain.",
    { added: /\bavg\s*\(\s*avg_/i },
    { add: "select avg(avg_order_value)" },
    { add: "select avg(order_value)" },
  ),
  r(
    "sum-of-ratio",
    "sql_correctness",
    "suggestion",
    "SUM of a ratio/percentage is meaningless",
    "Summing rates/percentages double-counts; sum numerator and denominator then divide.",
    { added: /\bsum\s*\(\s*\w*(rate|pct|percent|ratio)\b/i },
    { add: "select sum(conversion_rate)" },
    { add: "select sum(amount)" },
  ),
  r(
    "count-distinct-multiple-cols",
    "sql_correctness",
    "suggestion",
    "COUNT(DISTINCT a, b) portability",
    "Multi-column COUNT(DISTINCT) isn't supported on all warehouses; concat or use a subquery.",
    { added: /count\s*\(\s*distinct\s+[^),]+,/i, portability: { worksOn: ["mysql", "snowflake", "databricks"] } },
    { add: "count(distinct a, b)" },
    { add: "count(distinct a)" },
  ),
  r(
    "agg-without-group",
    "sql_correctness",
    "suggestion",
    "mixing aggregate and non-aggregate without GROUP BY",
    "Selecting a bare column alongside an aggregate with no GROUP BY errors or picks an arbitrary row.",
    { newSql: /select\s+\w+\s*,\s*(sum|count|avg|max|min)\s*\([\s\S]*\bfrom\b/i, absentNewSql: /\bgroup\s+by\b/i },
    { add: "select customer_id, sum(amount) from t" },
    { add: "select sum(amount) from t" },
  ),
  r(
    "string-agg-no-order",
    "sql_correctness",
    "suggestion",
    "STRING_AGG/LISTAGG without ORDER BY",
    "Aggregating strings without an ORDER BY gives non-deterministic concatenation order.",
    { added: /\b(string_agg|listagg|group_concat|array_agg)\s*\(/i, unless: /order\s+by/i },
    { add: "string_agg(name)" },
    { add: "string_agg(name order by name)" },
  ),
  r(
    "min-max-on-string-date",
    "sql_correctness",
    "suggestion",
    "MIN/MAX on a string date compares lexically",
    "MIN/MAX over a string-typed date compares text, not chronology; cast to date first.",
    { added: /\b(min|max)\s*\(\s*\w*date_str/i },
    { add: "max(date_str)" },
    { add: "max(order_date)" },
  ),
  r(
    "filter-after-agg",
    "sql_correctness",
    "suggestion",
    "aggregate filtered in WHERE instead of HAVING",
    "You can't filter an aggregate in WHERE; aggregate conditions belong in HAVING.",
    { added: /\bwhere\b[^;]*\b(count|sum|avg)\s*\(/i },
    { add: "where sum(x) > 10" },
    { add: "having sum(x) > 10" },
  ),
  r(
    "percentile-no-within",
    "sql_correctness",
    "suggestion",
    "PERCENTILE_CONT without WITHIN GROUP",
    "Ordered-set aggregates need `WITHIN GROUP (ORDER BY …)`; missing it errors or misorders.",
    { added: /percentile_(cont|disc)\s*\(/i, unless: /within\s+group/i },
    { add: "percentile_cont(0.5)" },
    { add: "percentile_cont(0.5) within group (order by x)" },
  ),
]

const WINDOWS: Rule[] = [
  r(
    "running-total-no-order",
    "sql_correctness",
    "warning",
    "running aggregate window with no ORDER BY",
    "A cumulative `sum() over (partition by …)` without ORDER BY isn't a running total — add ORDER BY.",
    { added: /\b(sum|count|avg)\s*\([^)]*\)\s*over\s*\(\s*partition[^)]*\)/i, unless: /order\s+by/i },
    { add: "sum(x) over (partition by id)" },
    { add: "sum(x) over (partition by id order by d)" },
  ),
  r(
    "rows-vs-range",
    "sql_correctness",
    "suggestion",
    "RANGE frame with ties double-counts — use ROWS",
    "`RANGE BETWEEN` includes peer rows with equal ORDER BY values; use `ROWS` for true running totals.",
    { added: /\brange\s+between\b/i },
    { add: "over (order by d range between unbounded preceding and current row)" },
    { add: "over (order by d rows between unbounded preceding and current row)" },
  ),
  r(
    "lag-lead-no-default",
    "sql_correctness",
    "suggestion",
    "LAG/LEAD without a default yields NULL at edges",
    "First/last rows get NULL from LAG/LEAD; pass a default if downstream math can't handle NULL.",
    { added: /\b(lag|lead)\s*\(\s*[^,)]+\s*\)/i },
    { add: "lag(amount) over (order by d)" },
    { add: "lag(amount, 1, 0) over (order by d)" },
  ),
  r(
    "qualify-without-window",
    "sql_quality",
    "suggestion",
    "QUALIFY without a window function",
    "`QUALIFY` filters window results; without a window function it's likely a misplaced WHERE/HAVING.",
    { newSql: /\bqualify\b/i, absentNewSql: /\bover\s*\(/i },
    { add: "select a from t qualify x = 1" },
    { add: "select a from t qualify row_number() over (order by d) = 1" },
  ),
  r(
    "distinct-with-window",
    "sql_correctness",
    "warning",
    "DISTINCT with a window function",
    "DISTINCT runs after window functions, so it dedupes post-computation — usually not intended.",
    { newSql: /select\s+distinct[\s\S]*\bover\s*\(/i },
    { add: "select distinct a, row_number() over (order by d) from t" },
    { add: "select a, row_number() over (order by d) from t" },
  ),
]

const PERF: Rule[] = [
  r(
    "count-distinct-large",
    "warehouse_cost",
    "suggestion",
    "COUNT(DISTINCT) is expensive at scale",
    "Exact distinct counts need a global sort/hash; use APPROX_COUNT_DISTINCT/HLL when tolerable.",
    { added: /count\s*\(\s*distinct/i },
    { add: "count(distinct user_id)" },
    { add: "count(user_id)" },
  ),
  r(
    "order-by-in-cte",
    "warehouse_cost",
    "suggestion",
    "ORDER BY inside a CTE/subquery is ignored",
    "Ordering inside a CTE has no guaranteed effect downstream and just adds a sort cost.",
    { newSql: /\bas\s*\(\s*select[\s\S]*?\border\s+by\b[\s\S]*?\)/i },
    { add: "with x as (select a from t order by a) select * from x" },
    { add: "with x as (select a from t) select * from x" },
  ),
  r(
    "function-on-join-key",
    "warehouse_cost",
    "suggestion",
    "function on a filter column blocks pruning",
    "Wrapping a filtered column in lower()/upper()/substr defeats clustering/partition pruning.",
    { added: /\bwhere\b[^;]*\b(lower|upper|substr|substring|trim|replace)\s*\(/i },
    { add: "where lower(email) = 'x'" },
    { add: "where email = 'x'" },
  ),
  r(
    "implicit-cross-join-comma",
    "join_risk",
    "warning",
    "comma-separated tables in FROM (implicit cross join)",
    "`from a, b` cross-joins unless a WHERE ties them — fragile; use explicit JOIN … ON.",
    { added: /\bfrom\s+[\w.`{}']+(\s+\w+)?\s*,\s*[\w.`{}']+/i },
    { add: "from orders o, customers c" },
    { add: "from orders o" },
  ),
  r(
    "select-star-in-cte-final",
    "warehouse_cost",
    "suggestion",
    "SELECT * in final projection",
    "A trailing `select *` carries every upstream column forward, bloating the model and storage.",
    { added: /^\s*select\s+\*\s*$/i },
    { add: "select *" },
    { add: "select id, name" },
  ),
  r(
    "large-in-list",
    "warehouse_cost",
    "suggestion",
    "very large literal IN-list",
    "A huge `IN (… , … , …)` literal list is slow and unmaintainable; join to a seed/ref instead.",
    { added: /\bin\s*\([^)]*,[^)]*,[^)]*,[^)]*,[^)]*,/i },
    { add: "where id in (1,2,3,4,5,6)" },
    { add: "where id in (1,2)" },
  ),
  r(
    "nested-subqueries-deep",
    "warehouse_cost",
    "suggestion",
    "deeply nested subqueries hurt readability/plans",
    "Several nested `(select … (select …))` levels are hard to optimize; flatten into CTEs.",
    { newSql: /\(\s*select[\s\S]*\(\s*select[\s\S]*\(\s*select/i },
    { add: "select (select (select (select 1)))" },
    { add: "select a from t" },
  ),
  r(
    "distinct-star",
    "warehouse_cost",
    "warning",
    "SELECT DISTINCT * scans + sorts everything",
    "`select distinct *` reads all columns and sorts the whole set — almost always the wrong fix.",
    { added: /select\s+distinct\s+\*/i },
    { add: "select distinct * from t" },
    { add: "select distinct id from t" },
  ),
  r(
    "regexp-heavy",
    "warehouse_cost",
    "suggestion",
    "regex function on a filtered/large column",
    "REGEXP_* over big tables is CPU-heavy; prefer LIKE/anchored patterns where possible.",
    { added: /\b(regexp_contains|regexp_like|rlike|regexp_extract|regexp_matches)\s*\(/i },
    { add: "where regexp_contains(name, 'x')" },
    { add: "where name like 'x%'" },
  ),
  r(
    "cartesian-via-union-subquery",
    "warehouse_cost",
    "suggestion",
    "scalar aggregate cross-joined to every row",
    "Cross-joining a 1-row aggregate to a big table is fine, but verify it isn't an accidental fan-out.",
    { added: /\bcross\s+join\s*\(\s*select\b/i },
    { add: "cross join (select max(d) from t)" },
    { add: "join (select id from t) x on x.id=a.id" },
  ),
]

const MATERIALIZATION: Rule[] = [
  r(
    "ephemeral-with-joins",
    "materialization",
    "suggestion",
    "ephemeral model with heavy joins is inlined everywhere",
    "An `ephemeral` model is inlined into every consumer; with joins that's repeated recompute. Prefer view/table.",
    { newSql: /materialized\s*[=:]\s*['"]?ephemeral[\s\S]*\bjoin\b/i },
    { add: "{{ config(materialized='ephemeral') }} select * from a join b on a.k=b.k" },
    { add: "{{ config(materialized='view') }} select * from a join b on a.k=b.k" },
  ),
  r(
    "staging-as-table",
    "materialization",
    "suggestion",
    "staging model materialized as table",
    "Staging models are usually views/ephemeral; a `table` here adds storage + a full rebuild each run.",
    { newSql: /materialized\s*[=:]\s*['"]?table/i, pathGlob: /(^|\/)stg_|(^|\/)staging\//i },
    {
      add: "{{ config(materialized='table') }} select 1",
      newSql: "{{ config(materialized='table') }} select 1",
      path: "models/staging/stg_x.sql",
    },
    {
      add: "{{ config(materialized='view') }} select 1",
      newSql: "{{ config(materialized='view') }} select 1",
      path: "models/staging/stg_x.sql",
    },
  ),
  r(
    "on-schema-change-ignore",
    "contract_violation",
    "warning",
    "incremental on_schema_change='ignore'",
    "With `on_schema_change='ignore'`, added/reordered columns silently misalign on append. Use 'sync_all_columns' or 'append_new_columns'.",
    { added: /on_schema_change\s*[=:]\s*['"]ignore/i },
    { add: "on_schema_change='ignore'" },
    { add: "on_schema_change='sync_all_columns'" },
  ),
  r(
    "delete-insert-no-key",
    "dedup",
    "warning",
    "delete+insert incremental without unique_key",
    "`incremental_strategy='delete+insert'` with no `unique_key` can't delete matched rows — duplicates accrue.",
    { newSql: /delete\s*\+\s*insert/i, absentNewSql: /unique_key/i },
    { add: "incremental_strategy='delete+insert' select 1", newSql: "incremental_strategy='delete+insert' select 1" },
    {
      add: "incremental_strategy='delete+insert' unique_key='id'",
      newSql: "incremental_strategy='delete+insert' unique_key='id'",
    },
  ),
  r(
    "merge-no-key",
    "dedup",
    "warning",
    "merge incremental without unique_key",
    "`incremental_strategy='merge'` needs a `unique_key` to match rows; without it it appends and duplicates.",
    { newSql: /incremental_strategy\s*[=:]\s*['"]merge/i, absentNewSql: /unique_key/i },
    { add: "incremental_strategy='merge' select 1", newSql: "incremental_strategy='merge' select 1" },
    { add: "incremental_strategy='merge' unique_key='id'", newSql: "incremental_strategy='merge' unique_key='id'" },
  ),
  r(
    "values-inline-seed",
    "sql_quality",
    "suggestion",
    "inline VALUES list should be a seed",
    "A hardcoded `(values …)` lookup belongs in a `seeds/` CSV, not inline in a model.",
    { added: /\bfrom\s*\(\s*values\b/i },
    { add: "from (values (1),(2)) as t(x)" },
    { add: "from {{ ref('seed_x') }}" },
  ),
  r(
    "pre-hook-dml",
    "sql_correctness",
    "warning",
    "destructive pre/post-hook",
    "A `pre_hook`/`post_hook` running DELETE/TRUNCATE/DROP runs every build and can destroy data.",
    { added: /(pre_hook|post_hook)[\s\S]*\b(delete|truncate|drop)\b/i },
    { add: "post_hook='truncate table x'" },
    { add: "post_hook='grant select on x to role'" },
  ),
  r(
    "table-no-cluster-large",
    "warehouse_cost",
    "suggestion",
    "large table materialization without clustering/partitioning",
    "A `table`/incremental over a big source with no partition_by/cluster_by scans fully on read. Add partitioning.",
    {
      newSql: /materialized\s*[=:]\s*['"]?(table|incremental)/i,
      absentNewSql: /(partition_by|cluster_by|partitioned\s+by|clustered\s+by)/i,
      pathGlob: /(^|\/)(marts|fct_|fact_)/i,
    },
    {
      add: "{{ config(materialized='incremental') }} select 1 from fct",
      newSql: "{{ config(materialized='incremental') }} select 1 from fct",
    },
    {
      add: "{{ config(materialized='incremental', partition_by={'field':'d'}) }} select 1",
      newSql: "{{ config(materialized='incremental', partition_by={'field':'d'}) }} select 1",
    },
  ),
]

const DBT_CONV: Rule[] = [
  r(
    "ref-double-quotes",
    "sql_quality",
    "suggestion",
    "ref() uses double quotes",
    "dbt convention is single-quoted `ref('model')`; double quotes are inconsistent and can confuse linters.",
    { added: /\{\{\s*ref\(\s*"/i },
    { add: 'from {{ ref("x") }}' },
    { add: "from {{ ref('x') }}" },
  ),
  r(
    "information-schema",
    "sql_quality",
    "warning",
    "querying INFORMATION_SCHEMA directly",
    "Reading INFORMATION_SCHEMA/SVV_* in a model bypasses the dbt DAG and is environment-fragile.",
    { added: /\bfrom\s+[`"]?information_schema\b|\bfrom\s+svv_/i },
    { add: "from information_schema.tables" },
    { add: "from {{ ref('x') }}" },
  ),
  r(
    "run-query-parse",
    "sql_quality",
    "warning",
    "run_query()/statement at parse time",
    "`run_query`/`statement` execute against the warehouse during compile — slow, fragile, and needs a live DB.",
    { added: /\b(run_query|statement)\s*\(/i },
    { add: "{% set r = run_query('select 1') %}" },
    { add: "{{ ref('x') }}" },
  ),
  r(
    "adapter-call",
    "sql_quality",
    "suggestion",
    "adapter.* introspection in a model",
    "`adapter.get_columns_in_relation`/`adapter.dispatch` hit the warehouse at compile; isolate in macros.",
    { added: /\{\{[^}]*adapter\.\w+/i },
    { add: "{{ adapter.get_columns_in_relation(this) }}" },
    { add: "{{ ref('x') }}" },
  ),
  r(
    "dbt-utils-star",
    "warehouse_cost",
    "suggestion",
    "dbt_utils.star() expands to all columns",
    "`dbt_utils.star()` selects every column (like SELECT *), bloating the model and needing a DB at parse.",
    { added: /dbt_utils\.star\s*\(/i },
    { add: "{{ dbt_utils.star(from=ref('x')) }}" },
    { add: "select id, name" },
  ),
  r(
    "env-var-in-model",
    "pii_exposure",
    "suggestion",
    "env_var() inside a model",
    "`{{ env_var(...) }}` in model SQL couples logic to the environment and can leak secrets into compiled code.",
    { added: /\{\{\s*env_var\s*\(/i },
    { add: "where token = '{{ env_var('API_KEY') }}'" },
    { add: "where d > {{ var('cutoff', 0) }}" },
  ),
  r(
    "magic-number",
    "sql_quality",
    "suggestion",
    "magic numeric constant",
    "An unexplained constant (e.g. `* 86400`, `/ 1000000`) hurts readability; name it via a var/CTE.",
    { added: /[*\/]\s*(86400|3600|1000000|604800|1048576)\b/ },
    { add: "select seconds / 86400 as days" },
    { add: "select a / b as r" },
  ),
  r(
    "hardcoded-fx-multiplier",
    "sql_quality",
    "suggestion",
    "hardcoded conversion/multiplier",
    "A literal rate like `* 1.1` (tax/fx) drifts out of date; source it from a seed/var.",
    { added: /[*]\s*1\.\d{1,3}\b/ },
    { add: "select amount * 1.08 as with_tax" },
    { add: "select amount * qty as total" },
  ),
  r(
    "ref-to-source-table",
    "lineage_breakage",
    "warning",
    "ref() pointing at a raw/source table name",
    "Using `ref()` on a source-style name (raw_/src_) suggests a missing `source()`; lineage will be wrong.",
    { added: /\{\{\s*ref\(\s*['"](raw_|src_|source_)/i },
    { add: "from {{ ref('raw_orders') }}" },
    { add: "from {{ source('app','orders') }}" },
  ),
  r(
    "limit-in-subquery-dev",
    "sql_correctness",
    "warning",
    "LIMIT inside a CTE/subquery",
    "A `LIMIT` buried in a CTE caps rows for everything downstream — usually a debugging leftover.",
    { newSql: /\bas\s*\(\s*select[\s\S]*\blimit\s+\d+[\s\S]*\)/i },
    { add: "with x as (select a from t limit 100) select * from x" },
    { add: "with x as (select a from t) select * from x" },
  ),
  r(
    "sample-clause",
    "sql_correctness",
    "warning",
    "TABLESAMPLE / SAMPLE left in model",
    "A `tablesample`/`sample` clause returns a random subset every run — non-deterministic and lossy.",
    { added: /\b(tablesample|sample)\s*\(/i },
    { add: "from t tablesample (10 percent)" },
    { add: "from t" },
  ),
]

const TESTS_CONTRACTS: Rule[] = [
  r(
    "enforced-contract-removed",
    "contract_violation",
    "warning",
    "enforced contract removed",
    "Dropping `enforced: true` removes the schema guarantee downstream consumers rely on.",
    { kind: "schema_yml", removed: /enforced:\s*true/i },
    { remove: "      enforced: true" },
    { remove: "      some_other: true" },
  ),
  r(
    "accepted-values-removed",
    "test_coverage",
    "suggestion",
    "accepted_values test removed",
    "Removing an `accepted_values` test lets unexpected enum values flow through silently.",
    { kind: "schema_yml", removed: /accepted_values/i },
    { remove: "          - accepted_values:" },
    { remove: "          - not_null" },
  ),
  r(
    "yml-data-type-narrowed",
    "contract_violation",
    "warning",
    "contract column data_type narrowed",
    "A contracted `data_type` was changed to a narrower type — truncation/overflow + contract break.",
    {
      kind: "schema_yml",
      removed: /data_type:\s*(numeric|string|bignumeric|float64)/i,
      added: /data_type:\s*(int|smallint|varchar\(|number\(\d)/i,
    },
    { add: "        data_type: int64", remove: "        data_type: numeric" },
    { add: "        data_type: numeric", remove: "        data_type: string" },
  ),
  r(
    "yml-column-removed",
    "contract_violation",
    "warning",
    "column removed from schema.yml",
    "Removing a column entry from a contracted model breaks the contract and any downstream ref to it.",
    { kind: "schema_yml", removed: /^\s*-\s*name:\s*\w+/i },
    { remove: "      - name: order_id" },
    { remove: "    description: docs" },
  ),
  r(
    "test-severity-warn",
    "test_coverage",
    "suggestion",
    "test downgraded to severity: warn",
    "Setting a test to `severity: warn` stops it failing CI — it no longer guards the merge.",
    { kind: "schema_yml", added: /severity:\s*warn/i },
    { add: "          severity: warn" },
    { add: "          severity: error" },
  ),
  r(
    "test-disabled",
    "test_coverage",
    "warning",
    "test disabled (enabled: false)",
    "Disabling a test (`enabled: false`) silently removes its guarantee; confirm it's truly obsolete.",
    { kind: "schema_yml", added: /enabled:\s*false/i },
    { add: "          enabled: false" },
    { add: "          enabled: true" },
  ),
  r(
    "yml-description-removed",
    "sql_quality",
    "suggestion",
    "model/column description removed",
    "Removing documentation reduces discoverability and breaks docs/exposure references.",
    { kind: "schema_yml", removed: /^\s*description:/i },
    { remove: "    description: revenue per day" },
    { remove: "    name: x" },
  ),
  r(
    "source-freshness-removed",
    "freshness",
    "warning",
    "source freshness check removed",
    "Deleting a source `freshness:` block stops stale-data alerts; downstream silently serves old data.",
    { kind: "schema_yml", removed: /freshness:/i },
    { remove: "    freshness:" },
    { remove: "    description: orders" },
  ),
  r(
    "loaded-at-field-removed",
    "freshness",
    "warning",
    "source loaded_at_field removed",
    "Removing `loaded_at_field` disables freshness measurement on the source.",
    { kind: "schema_yml", removed: /loaded_at_field:/i },
    { remove: "    loaded_at_field: _loaded_at" },
    { remove: "    database: prod" },
  ),
  r(
    "relationship-test-removed-yml",
    "test_coverage",
    "warning",
    "relationships (FK) test removed",
    "Dropping a `relationships` test removes referential-integrity checking between models.",
    { kind: "schema_yml", removed: /relationships:/i },
    { remove: "          - relationships:" },
    { remove: "          - not_null" },
  ),
]

const SNAPSHOTS: Rule[] = [
  r(
    "snapshot-select-star",
    "freshness",
    "warning",
    "snapshot uses SELECT * — breaks on schema change",
    "A `select *` snapshot errors or mis-tracks when the source adds/changes a column; select explicit columns.",
    { kind: "snapshot", added: /select\s+\*/i },
    { add: "select * from {{ source('a','b') }}" },
    { add: "select id, status from {{ source('a','b') }}" },
  ),
  r(
    "snapshot-check-no-cols",
    "freshness",
    "warning",
    "check-strategy snapshot without check_cols",
    "A `strategy='check'` snapshot needs `check_cols`; without it changes aren't detected.",
    { kind: "snapshot", newSql: /strategy\s*[=:]\s*['"]check/i, absentNewSql: /check_cols/i },
    { add: "{{ config(strategy='check') }}", newSql: "{{ config(strategy='check') }}" },
    {
      add: "{{ config(strategy='check', check_cols=['status']) }}",
      newSql: "{{ config(strategy='check', check_cols=['status']) }}",
    },
  ),
  r(
    "snapshot-timestamp-no-updated",
    "freshness",
    "warning",
    "timestamp-strategy snapshot without updated_at",
    "A `strategy='timestamp'` snapshot requires `updated_at`; missing it breaks SCD tracking.",
    { kind: "snapshot", newSql: /strategy\s*[=:]\s*['"]timestamp/i, absentNewSql: /updated_at/i },
    { add: "{{ config(strategy='timestamp') }}", newSql: "{{ config(strategy='timestamp') }}" },
    {
      add: "{{ config(strategy='timestamp', updated_at='modified_at') }}",
      newSql: "{{ config(strategy='timestamp', updated_at='modified_at') }}",
    },
  ),
  r(
    "snapshot-hard-deletes",
    "freshness",
    "suggestion",
    "snapshot without invalidate_hard_deletes",
    "Without `invalidate_hard_deletes=true`, rows deleted at source stay 'current' forever in the snapshot.",
    { kind: "snapshot", newSql: /\{%\s*snapshot\b/i, absentNewSql: /invalidate_hard_deletes/i },
    {
      add: "{% snapshot s %}{{ config(strategy='timestamp', updated_at='u') }}",
      newSql: "{% snapshot s %}{{ config(strategy='timestamp', updated_at='u') }}",
    },
    {
      add: "{% snapshot s %}{{ config(invalidate_hard_deletes=true) }}",
      newSql: "{% snapshot s %}{{ config(invalidate_hard_deletes=true) }}",
    },
  ),
]

const SECURITY_PII: Rule[] = [
  r(
    "hardcoded-credential",
    "pii_exposure",
    "critical",
    "hardcoded credential/secret in SQL",
    "A literal password/secret/api_key/token in model SQL leaks into compiled artifacts and git. Use env/secret manager.",
    { added: /\b(password|secret|api_key|apikey|access_token|private_key)\s*[=:]\s*['"][^'"]{4,}/i },
    { add: "where api_key = 'sk-12345abc'" },
    { add: "where d > {{ var('cutoff', 0) }}" },
  ),
  r(
    "select-pii-columns",
    "pii_exposure",
    "warning",
    "PII columns selected",
    "Email/SSN/phone/DOB pulled into a model widens PII exposure; confirm it's needed and masked.",
    {
      added: /^\s*[\w.]*\b(ssn|social_security|email|phone_number|date_of_birth|passport)\b/i,
      capturesColumns: /\b(ssn|social_security|email|phone_number|date_of_birth|passport)\b/i,
    },
    { add: "        c.ssn," },
    { add: "        c.country," },
  ),
  r(
    "pii-concat",
    "pii_exposure",
    "suggestion",
    "concatenating PII fields",
    "Joining first/last name or email into a new field creates derived PII that needs governance.",
    { added: /(first_name\s*\|\||concat\s*\(\s*first_name)/i },
    { add: "first_name || last_name as full_name" },
    { add: "a || b as k" },
  ),
  r(
    "masking-removed",
    "pii_exposure",
    "warning",
    "masking macro/post-hook removed",
    "Removing a masking macro/post-hook re-exposes raw PII on the next rebuild.",
    { removed: /(apply_masking|mask_column|masking_policy)/i },
    { remove: "post_hook=\"{{ apply_masking('email') }}\"" },
    { remove: 'post_hook="grant select"' },
  ),
  r(
    "weak-pii-hash",
    "pii_exposure",
    "suggestion",
    "weak hash (MD5) of PII",
    "MD5/SHA1 of PII is reversible/brute-forceable; use a keyed hash or proper tokenization for anonymization.",
    { added: /\bmd5\s*\(\s*\w*(email|ssn|phone|name)/i },
    { add: "md5(email) as email_hash" },
    { add: "md5(order_id) as k" },
  ),
  r(
    "plaintext-pii-key",
    "pii_exposure",
    "suggestion",
    "surrogate key built from raw PII",
    "Hashing PII into a join key still derives from PII and can correlate individuals; prefer a tokenized id.",
    { added: /generate_surrogate_key\s*\(\s*\[[^\]]*\b(email|ssn|phone)\b/i },
    { add: "{{ dbt_utils.generate_surrogate_key(['email']) }}" },
    { add: "{{ dbt_utils.generate_surrogate_key(['order_id']) }}" },
  ),
]

const BIGQUERY: Rule[] = [
  r(
    "bq-no-partition-filter",
    "warehouse_cost",
    "warning",
    "BigQuery: query on a partitioned table with no partition filter",
    "Without a `_PARTITIONTIME`/partition-column predicate, BigQuery scans the whole table (full cost).",
    {
      added: /from\s+[^;\n]*(events|logs|fct_|fact_|_fct|_fact)/i,
      absentNewSql: /(_partitiontime|_partitiondate|\bwhere\b[\s\S]*(date|_at|created|partition))/i,
    },
    { add: "from `proj`.`ds`.`events_fct`", newSql: "from `proj`.`ds`.`events_fct`" },
    {
      add: "from `proj`.`ds`.`events_fct` where created_at > '2024-01-01'",
      newSql: "from `proj`.`ds`.`events_fct` where created_at > '2024-01-01'",
    },
  ),
  r(
    "bq-wildcard-no-suffix",
    "warehouse_cost",
    "warning",
    "BigQuery: wildcard table without _TABLE_SUFFIX filter",
    "Wildcard tables (`events_*`) scan every shard unless filtered on `_TABLE_SUFFIX`.",
    { added: /from\s+[`"][^`"]*\*[`"]/i, absentNewSql: /_table_suffix/i },
    { add: "from `proj.ds.events_*`", newSql: "from `proj.ds.events_*`" },
    {
      add: "from `proj.ds.events_*` where _table_suffix between '2024' and '2025'",
      newSql: "from `proj.ds.events_*` where _table_suffix between '2024' and '2025'",
    },
  ),
  r(
    "bq-legacy-sql",
    "sql_quality",
    "warning",
    "BigQuery: legacy-SQL syntax",
    "Legacy SQL (`[proj:ds.table]`, `TABLE_DATE_RANGE`) is deprecated; use Standard SQL.",
    { added: /(\[[\w-]+:[\w.]+\]|table_date_range|table_query)/i },
    { add: "from [my-proj:ds.table]" },
    { add: "from `my-proj`.`ds`.`table`" },
  ),
  r(
    "bq-cross-join-unnest",
    "fanout",
    "suggestion",
    "BigQuery: CROSS JOIN UNNEST can explode rows",
    "`CROSS JOIN UNNEST(array)` multiplies rows by array length; confirm the fan-out is intended.",
    { added: /cross\s+join\s+unnest\s*\(/i },
    { add: "cross join unnest(items) as item" },
    { add: "left join unnest(items) as item" },
  ),
  // bq-safe-cast-missing removed: it flagged EVERY numeric/date CAST as "consider
  // SAFE_CAST", which is a false-positive on the overwhelmingly common case of a
  // clean cast. The genuine dirty-data concern is too context-dependent for a
  // blanket regex; flagging all casts erodes trust (measured FP in value eval).
  r(
    "bq-float64-money",
    "sql_correctness",
    "suggestion",
    "BigQuery: FLOAT64 for money loses precision",
    "Use `NUMERIC`/`BIGNUMERIC` for currency; `FLOAT64` introduces rounding error.",
    { added: /cast\s*\(\s*\w*(amount|price|revenue|cost|total)\w*\s+as\s+float64/i },
    { add: "cast(amount as float64)" },
    { add: "cast(amount as numeric)" },
  ),
  r(
    "bq-select-star-replace",
    "sql_quality",
    "suggestion",
    "BigQuery: prefer SELECT * EXCEPT/REPLACE over bare *",
    "If you must use `*`, BigQuery's `* EXCEPT(...)`/`* REPLACE(...)` is safer than a bare star.",
    { added: /select\s+\*\s+from/i, unless: /except\s*\(|replace\s*\(|\{\{/i },
    { add: "select * from t" },
    { add: "select * except(x) from t" },
  ),
  r(
    "bq-generate-array-large",
    "warehouse_cost",
    "suggestion",
    "BigQuery: GENERATE_ARRAY/DATE_ARRAY can be huge",
    "A wide `GENERATE_ARRAY`/`GENERATE_DATE_ARRAY` materializes every element; bound the range.",
    { added: /generate_(date_|timestamp_)?array\s*\(/i },
    { add: "generate_date_array('2000-01-01', current_date)" },
    { add: "from {{ ref('date_spine') }}" },
  ),
  r(
    "bq-datetime-vs-timestamp",
    "sql_correctness",
    "suggestion",
    "BigQuery: DATETIME vs TIMESTAMP confusion",
    "`DATETIME` has no timezone; mixing it with `TIMESTAMP` in comparisons shifts results.",
    { added: /cast\s*\(\s*\w*\s+as\s+datetime\b/i },
    { add: "cast(ts as datetime)" },
    { add: "cast(ts as timestamp)" },
  ),
  r(
    "bq-array-no-offset",
    "sql_correctness",
    "suggestion",
    "BigQuery: array access needs OFFSET/ORDINAL",
    "Indexing an array as `arr[0]` errors in BigQuery; use `arr[OFFSET(0)]` or `[ORDINAL(1)]`.",
    { added: /\b\w+\[\s*\d+\s*\]/ },
    { add: "select items[0]" },
    { add: "select items[offset(0)]" },
  ),
  r(
    "bq-approx-good",
    "warehouse_cost",
    "suggestion",
    "BigQuery: large exact COUNT(DISTINCT) — APPROX is cheaper",
    "On BigQuery, `APPROX_COUNT_DISTINCT` is dramatically cheaper than exact distinct at scale.",
    { added: /count\s*\(\s*distinct/i, pathGlob: /(marts|reporting)/i },
    { add: "count(distinct user_id)", path: "models/marts/m.sql" },
    { add: "count(user_id)", path: "models/marts/m.sql" },
  ),
  r(
    "bq-string-comparison-collation",
    "sql_correctness",
    "suggestion",
    "BigQuery: case-sensitive string join",
    "BigQuery string comparison is case-sensitive by default; normalize with LOWER or set collation.",
    { added: /\bon\s+\w+\.\w*(name|code|sku)\b\s*=\s*\w+\./i },
    { add: "on a.sku = b.sku" },
    { add: "on lower(a.sku) = lower(b.sku)" },
  ),
]

const SNOWFLAKE: Rule[] = [
  r(
    "sf-variant-no-cast",
    "sql_correctness",
    "suggestion",
    "Snowflake: VARIANT path used without explicit cast",
    "Reading `col:field` from a VARIANT returns VARIANT; cast (`::string`) so downstream types are stable.",
    { added: /\w+:[a-z_]\w*(?!\s*::)/i, unless: /::|http|case\s+when/i },
    { add: "select payload:user_id from t" },
    { add: "select payload:user_id::int from t" },
  ),
  r(
    "sf-flatten-explosion",
    "fanout",
    "suggestion",
    "Snowflake: LATERAL FLATTEN multiplies rows",
    "`LATERAL FLATTEN(input => arr)` produces one row per element; verify the fan-out is intended.",
    { added: /lateral\s+flatten\s*\(/i },
    { add: "from t, lateral flatten(input => t.items)" },
    { add: "from t" },
  ),
  r(
    "sf-time-travel",
    "sql_correctness",
    "warning",
    "Snowflake: time-travel (AT/BEFORE) in a model",
    "`AT(TIMESTAMP …)`/`BEFORE(STATEMENT …)` reads historical data — non-reproducible in a model.",
    { added: /\b(at|before)\s*\(\s*(timestamp|offset|statement)\s*=>/i },
    { add: "from t at(offset => -60)" },
    { add: "from t" },
  ),
  r(
    "sf-result-scan",
    "sql_correctness",
    "warning",
    "Snowflake: RESULT_SCAN in a model",
    "`RESULT_SCAN(LAST_QUERY_ID())` depends on session state and can't be reproduced by dbt.",
    { added: /result_scan\s*\(/i },
    { add: "from table(result_scan(last_query_id()))" },
    { add: "from {{ ref('x') }}" },
  ),
  // zeroifnull/iff/decode/nvl2 portability owned by core L033 (dialect-aware).
  // sf-array-agg-no-order removed: redundant with `string-agg-no-order` (which
  // covers array_agg AND guards on `order by`), and buggy here — its `unless`
  // only matched `within group`, so it false-fired on the standard
  // `array_agg(x order by x)` form (measured FP in the value eval).
  r(
    "sf-transient-loss",
    "materialization",
    "suggestion",
    "Snowflake: transient table has no fail-safe",
    "A `transient` materialization saves storage but loses Fail-safe recovery; confirm that's acceptable.",
    { added: /transient\s*[=:]\s*true|materialized\s*[=:]\s*['"]?transient/i },
    { add: "{{ config(transient=true) }}" },
    { add: "{{ config(materialized='table') }}" },
  ),
  r(
    "sf-copy-into",
    "sql_correctness",
    "critical",
    "Snowflake: COPY INTO / PUT inside a model",
    "`COPY INTO`/`PUT`/`GET` are loading commands, not transforms — they don't belong in a model.",
    { added: /\b(copy\s+into|put\s+file|get\s+@)\b/i },
    { add: "copy into t from @stage" },
    { add: "select * from t" },
  ),
  r(
    "sf-ilike-perf",
    "warehouse_cost",
    "suggestion",
    "Snowflake: ILIKE is case-insensitive scan",
    "`ILIKE` can't use search-optimization the way an anchored equality can; prefer LOWER(col)=… where possible.",
    { added: /\bilike\b/i },
    { add: "where name ilike '%shirt%'" },
    { add: "where lower(name) = 'shirt'" },
  ),
  // getdate/sysdate portability owned by core L033 (dialect-aware: silent on
  // Redshift/SQL Server). The idempotency concern (clock in a transform) is a
  // SEPARATE rule (rs-getdate) and is kept.
  r(
    "sf-sample-clause",
    "sql_correctness",
    "warning",
    "Snowflake: SAMPLE/TABLESAMPLE returns random subset",
    "`SAMPLE (n)` returns a different random subset each run — non-deterministic and lossy in a model.",
    { added: /\bsample\s*\(\s*\d/i },
    { add: "from t sample (10)" },
    { add: "from t" },
  ),
]

const REDSHIFT: Rule[] = [
  r(
    "rs-no-distkey-sortkey",
    "warehouse_cost",
    "suggestion",
    "Redshift: large table without dist/sort keys",
    "A Redshift `table` over a big source with no `dist`/`sort` config redistributes on every join — slow.",
    {
      newSql: /materialized\s*[=:]\s*['"]?table/i,
      absentNewSql: /(dist\s*[=:]|sort\s*[=:]|diststyle|sortkey)/i,
      pathGlob: /(marts|fct_|fact_)/i,
    },
    {
      add: "{{ config(materialized='table') }} select 1 from fct",
      newSql: "{{ config(materialized='table') }} select 1 from fct",
      path: "models/marts/fct_x.sql",
    },
    {
      add: "{{ config(materialized='table', sort='id') }} select 1",
      newSql: "{{ config(materialized='table', sort='id') }} select 1",
      path: "models/marts/fct_x.sql",
    },
  ),
  r(
    "rs-varchar-default",
    "contract_violation",
    "suggestion",
    "Redshift: VARCHAR without length defaults to 256",
    "Redshift `VARCHAR` defaults to 256 chars and truncates silently; size it explicitly for long text.",
    { added: /cast\s*\(\s*\w+\s+as\s+varchar\s*\)/i },
    { add: "cast(notes as varchar)" },
    { add: "cast(notes as varchar(4096))" },
  ),
  r(
    "rs-listagg-limit",
    "sql_correctness",
    "suggestion",
    "Redshift: LISTAGG overflows past 64KB",
    "Redshift `LISTAGG` errors when the result exceeds 64KB; bound or pre-truncate the inputs.",
    { added: /\blistagg\s*\(/i },
    { add: "listagg(comment, ',')" },
    { add: "array_agg(comment)" },
  ),
  r(
    "rs-leader-node-fn",
    "sql_correctness",
    "warning",
    "Redshift: leader-node-only function on a table",
    "`GENERATE_SERIES`/some functions run only on the leader node and error when used with table data.",
    { added: /\bgenerate_series\s*\(/i },
    { add: "select generate_series(1, n) from t" },
    { add: "from {{ ref('numbers') }}" },
  ),
  r(
    "rs-getdate",
    "idempotency",
    "suggestion",
    "Redshift: GETDATE()/SYSDATE in transform",
    "`GETDATE()`/`SYSDATE` bake run time into output (non-idempotent); pass an as-of var.",
    { added: /\b(getdate|sysdate)\b/i },
    { add: "where d > getdate() - 7" },
    { add: "where d > '2024-01-01'" },
  ),
  r(
    "rs-super-no-cast",
    "sql_correctness",
    "suggestion",
    "Redshift: SUPER path without cast",
    "Reading from a SUPER column without casting yields SUPER; cast for stable downstream types.",
    { added: /\w+\.\w+\s*::\s*super\b|\bjson_extract_path_text\s*\(/i },
    { add: "select json_extract_path_text(data, 'id')" },
    { add: "select id from t" },
  ),
]

const DATABRICKS: Rule[] = [
  r(
    "dbx-explode-fanout",
    "fanout",
    "suggestion",
    "Spark/Databricks: explode() multiplies rows",
    "`explode(array)`/`posexplode` emits one row per element — a fan-out; verify downstream grain.",
    { added: /\b(explode|posexplode|explode_outer)\s*\(/i },
    { add: "select explode(items)" },
    { add: "select items" },
  ),
  r(
    "dbx-collect-list-no-sort",
    "sql_correctness",
    "suggestion",
    "Spark: collect_list/collect_set ordering is non-deterministic",
    "`collect_list`/`collect_set` produce arrays in arbitrary order; sort explicitly if order matters.",
    { added: /\bcollect_(list|set)\s*\(/i, unless: /sort_array/i },
    { add: "collect_list(id)" },
    { add: "sort_array(collect_list(id))" },
  ),
  r(
    "dbx-merge-no-condition",
    "join_risk",
    "warning",
    "Databricks: MERGE INTO without a selective condition",
    "A `MERGE` whose `ON` is too broad (or `1=1`) rewrites the whole Delta table each run.",
    { added: /merge\s+into[\s\S]*\bon\s+(1\s*=\s*1|true)\b/i },
    { add: "merge into t using s on 1=1" },
    { add: "merge into t using s on t.id=s.id" },
  ),
  r(
    "dbx-no-partition-large",
    "warehouse_cost",
    "suggestion",
    "Databricks: large Delta table without partitioning/Z-ORDER",
    "A big Delta `table` with no `partition_by`/Z-ORDER scans all files; add partitioning for prune-ability.",
    {
      newSql: /materialized\s*[=:]\s*['"]?(table|incremental)/i,
      absentNewSql: /(partition_by|zorder|z_order|liquid)/i,
      pathGlob: /(marts|fct_|fact_)/i,
    },
    {
      add: "{{ config(materialized='table') }} select 1 from fct",
      newSql: "{{ config(materialized='table') }} select 1 from fct",
      path: "models/marts/fct_x.sql",
    },
    {
      add: "{{ config(materialized='table', partition_by=['d']) }} select 1",
      newSql: "{{ config(materialized='table', partition_by=['d']) }} select 1",
      path: "models/marts/fct_x.sql",
    },
  ),
  r(
    "dbx-cache-in-model",
    "sql_quality",
    "suggestion",
    "Spark: CACHE/UNCACHE TABLE in a model",
    "`CACHE TABLE`/`REFRESH` are session/runtime ops, not transforms — remove from model SQL.",
    { added: /\b(cache\s+table|uncache\s+table|refresh\s+table)\b/i },
    { add: "cache table t" },
    { add: "select * from t" },
  ),
  r(
    "dbx-string-to-date-fmt",
    "sql_correctness",
    "suggestion",
    "Spark: to_date/to_timestamp without format",
    "`to_date(str)` without an explicit format guesses and silently NULLs unparseable values.",
    { added: /\bto_(date|timestamp)\s*\(\s*[a-z_][\w.]*\s*\)/i },
    { add: "to_date(order_date)" },
    { add: "to_date(order_date, 'yyyy-MM-dd')" },
  ),
]

const STYLE: Rule[] = [
  r(
    "where-1-eq-1",
    "sql_quality",
    "suggestion",
    "no-op WHERE 1=1 / WHERE true",
    "`where 1=1`/`where true` is a no-op (often a leftover scaffold); remove or add the real predicate.",
    { added: /\bwhere\s+(1\s*=\s*1|true)\b/i },
    { add: "where 1=1" },
    { add: "where status = 'x'" },
  ),
  r(
    "trailing-semicolon",
    "sql_quality",
    "suggestion",
    "trailing semicolon in a model",
    "dbt models shouldn't end in `;` — it can break wrapping/CTAS on some adapters.",
    { added: /;\s*$/ },
    { add: "select 1;" },
    { add: "select 1" },
  ),
  r(
    "multiple-statements",
    "sql_correctness",
    "critical",
    "multiple statements in one model",
    "A model must be a single statement; two `;`-separated statements won't materialize correctly.",
    { added: /;\s*\S+[\s\S]*;/ },
    { add: "select 1; select 2;" },
    { add: "select 1" },
  ),
  r(
    "implicit-alias-no-as",
    "sql_quality",
    "suggestion",
    "column alias without AS",
    "Aliasing as `col x` (no `AS`) is ambiguous and easy to misread as a missing comma.",
    { added: /select\s+\w+\s+\w+\s*,/i, unless: /\bas\b|distinct|\*/i },
    { add: "select amount total," },
    { add: "select amount as total," },
  ),
  r(
    "generic-cte-name",
    "sql_quality",
    "suggestion",
    "non-descriptive CTE name",
    "CTE names like `tmp`/`t1`/`cte`/`final2` hide intent; name them for what they compute.",
    { added: /\bwith\s+(tmp|temp|t1|t2|cte|x|foo|test|final2)\s+as\b/i },
    { add: "with tmp as (select 1)" },
    { add: "with daily_revenue as (select 1)" },
  ),
  r(
    "nested-case",
    "sql_quality",
    "suggestion",
    "deeply nested CASE expression",
    "Nested `CASE WHEN … CASE WHEN` is hard to verify; flatten with combined conditions or a mapping.",
    { newSql: /case\s+when[\s\S]*\bcase\s+when/i },
    { add: "case when a then case when b then 1 end end" },
    { add: "case when a then 1 end" },
  ),
  r(
    "hardcoded-env-name",
    "sql_quality",
    "warning",
    "hardcoded environment/schema name",
    "A literal `'prod'`/`'production'`/`analytics.` in SQL breaks across environments; use target/var.",
    { added: /['"](prod|production|staging|dev)['"]/i },
    { add: "where env = 'production'" },
    { add: "where env = '{{ target.name }}'" },
  ),
  r(
    "like-no-wildcard",
    "sql_quality",
    "suggestion",
    "LIKE without a wildcard — use =",
    "`like 'exact'` with no `%`/`_` is just equality; `=` is clearer and faster.",
    { added: /\blike\s+'[^%_']+'/i },
    { add: "where code like 'ABC'" },
    { add: "where code like 'ABC%'" },
  ),
  r(
    "recursive-cte",
    "sql_quality",
    "suggestion",
    "recursive CTE — verify termination",
    "`WITH RECURSIVE` can loop infinitely or blow up; confirm a base case and depth bound.",
    { added: /\bwith\s+recursive\b/i },
    { add: "with recursive r as (select 1)" },
    { add: "with r as (select 1)" },
  ),
  r(
    "pivot-portability",
    "sql_quality",
    "suggestion",
    "PIVOT/UNPIVOT is dialect-specific",
    "`PIVOT`/`UNPIVOT` syntax varies by warehouse and is hard to test; consider conditional aggregation.",
    {
      added: /\b(pivot|unpivot)\s*\(/i,
      // No PIVOT/UNPIVOT on Postgres, MySQL, Trino or Athena.
      portability: { worksOn: ["snowflake", "bigquery", "databricks", "redshift", "tsql", "oracle", "duckdb"] },
    },
    { add: "from t pivot(sum(x) for k in ('a'))" },
    { add: "sum(case when k='a' then x end)" },
  ),
  r(
    "top-n-no-order",
    "sql_correctness",
    "suggestion",
    "TOP n without ORDER BY",
    "`SELECT TOP n` without `ORDER BY` returns arbitrary rows; add an explicit order.",
    { added: /select\s+top\s+\d+/i, unless: /order\s+by/i },
    { add: "select top 10 * from t" },
    { add: "select top 10 * from t order by d" },
  ),
  r(
    "group-by-alias",
    "sql_quality",
    "suggestion",
    "GROUP BY on a SELECT alias",
    "Grouping by a select-list alias isn't portable (errors on some warehouses); repeat the expression.",
    { added: /\bgroup\s+by\s+\w+_(amt|amount|total|cnt|count)\b/i, portability: { worksOn: ["snowflake", "bigquery", "postgres", "redshift", "databricks", "duckdb", "mysql", "clickhouse"] } },
    { add: "group by total_amount" },
    { add: "group by customer_id" },
  ),
  r(
    "interval-string-literal",
    "sql_quality",
    "suggestion",
    "string interval literal portability",
    "`interval '1 day'` literal syntax differs across warehouses; prefer dateadd/date_add functions.",
    {
      // The unit inside the quotes (`'1 day'`), not the ANSI `interval '30' day`.
      added: /interval\s+'\d+\s+[a-z]+'/i,
      // BigQuery, MySQL, T-SQL, Oracle, Trino and Athena need `INTERVAL 1 DAY` /
      // `INTERVAL '1' DAY` (or have no interval literal).
      portability: { worksOn: ["postgres", "redshift", "snowflake", "duckdb", "databricks"] },
    },
    { add: "d + interval '1 day'" },
    { add: "d - interval '30' day" },
  ),
  r(
    "date-plus-int",
    "sql_correctness",
    "suggestion",
    "integer arithmetic on a date",
    "`date + 7` (bare int) isn't portable and is ambiguous (days? seconds?); use dateadd/interval.",
    { added: /\b\w*(date|_dt)\b\s*[+\-]\s*\d+\b/i, portability: { worksOn: ["postgres", "redshift", "snowflake", "duckdb", "oracle"] } },
    { add: "select order_date + 7" },
    { add: "select dateadd(day, 7, order_date)" },
  ),
  // Split from date-plus-int: `timestamp + integer` has no operator on most
  // engines that accept `date + integer` (Postgres, Snowflake, DuckDB).
  r(
    "timestamp-plus-int",
    "sql_correctness",
    "suggestion",
    "integer arithmetic on a timestamp",
    "`updated_at + 1` (bare int on a timestamp) fails on most warehouses and is ambiguous (days? seconds?); use dateadd/interval.",
    { added: /\b\w*_at\b\s*[+\-]\s*\d+\b/i, portability: { worksOn: ["oracle"] } },
    { add: "select updated_at + 1" },
    { add: "select dateadd(day, 1, updated_at)" },
  ),
]

const MISC: Rule[] = [
  r(
    "order-by-rand",
    "idempotency",
    "warning",
    "ORDER BY RANDOM() is non-deterministic + costly",
    "Ordering by a random value gives different output each run and forces a full sort.",
    { added: /order\s+by\s+(rand|random)\s*\(/i },
    { add: "order by random()" },
    { add: "order by created_at" },
  ),
  r(
    "limit-no-order",
    "sql_correctness",
    "suggestion",
    "LIMIT without ORDER BY returns arbitrary rows",
    "`LIMIT n` with no `ORDER BY` picks non-deterministic rows that vary run-to-run.",
    { newSql: /\blimit\s+\d+/i, absentNewSql: /order\s+by/i },
    { add: "select a from t limit 10", newSql: "select a from t limit 10" },
    { add: "select a from t order by a limit 10", newSql: "select a from t order by a limit 10" },
  ),
  r(
    "nullif-self",
    "sql_correctness",
    "warning",
    "NULLIF(x, x) is always NULL",
    "`nullif(x, x)` always returns NULL — almost certainly a typo.",
    { added: /nullif\s*\(\s*(\w[\w.]*)\s*,\s*\1\s*\)/i },
    { add: "nullif(amount, amount)" },
    { add: "nullif(amount, 0)" },
  ),
  r(
    "coalesce-single-arg",
    "sql_quality",
    "suggestion",
    "COALESCE with one argument is a no-op",
    "`coalesce(x)` does nothing; remove it or add the fallback value.",
    { added: /coalesce\s*\(\s*[\w.]+\s*\)/i },
    { add: "coalesce(amount)" },
    { add: "coalesce(amount, 0)" },
  ),
  r(
    "uncorrelated-exists",
    "sql_correctness",
    "warning",
    "EXISTS subquery not correlated",
    "`exists (select 1 from t)` with no link to the outer query is constant (all-or-nothing).",
    { added: /\bexists\s*\(\s*select\b[^)]*\bfrom\b[^)]*\)/i, unless: /where[\s\S]*\b\w+\.\w+\s*=\s*\w+\./i },
    { add: "where exists (select 1 from orders)" },
    { add: "where exists (select 1 from orders o where o.cid = c.id)" },
  ),
  r(
    "in-with-null",
    "sql_correctness",
    "suggestion",
    "NULL inside an IN-list",
    "A `NULL` in an IN-list never matches and is dead; in a NOT IN it empties the result.",
    { added: /\bin\s*\([^)]*\bnull\b[^)]*\)/i },
    { add: "where x in (1, null, 3)" },
    { add: "where x in (1, 2, 3)" },
  ),
  r(
    "integer-division",
    "sql_correctness",
    "suggestion",
    "integer division truncates",
    "`5 / 2` does integer division (=2) on many warehouses; cast a side to numeric for a real ratio.",
    { added: /(?<![\d.])\d+\s*\/\s*\d+(?![\d.])/ },
    { add: "select 7 / 2 as r" },
    { add: "select 7.0 / 2 as r" },
  ),
  r(
    "mod-by-zero",
    "sql_correctness",
    "warning",
    "modulo / division by a literal zero",
    "`mod(x, 0)` / `x % 0` errors at runtime.",
    { added: /(mod\s*\(\s*[^,]+,\s*0\s*\)|%\s*0\b)/i },
    { add: "select mod(x, 0)" },
    { add: "select mod(x, 7)" },
  ),
  r(
    "not-equal-drops-null",
    "sql_correctness",
    "suggestion",
    "<>/!= silently excludes NULL rows",
    "`col <> 'x'` drops rows where col IS NULL; add `or col is null` if those should remain.",
    { added: /\b[\w.]+\s*(<>|!=)\s*'/i },
    { add: "where status <> 'cancelled'" },
    { add: "where status is distinct from 'cancelled'" },
  ),
  r(
    "boolean-eq-literal",
    "sql_quality",
    "suggestion",
    "comparing boolean to true/'true'",
    "`is_active = true` is redundant; use the boolean directly. `= 'true'` (string) is a type bug.",
    { added: /\b\w+\s*=\s*('true'|'false')/i },
    { add: "where active = 'true'" },
    { add: "where active" },
  ),
  r(
    "redundant-subquery",
    "sql_quality",
    "suggestion",
    "redundant wrapping subquery",
    "`from (select * from t)` adds a pointless nesting level; select from the table directly.",
    { added: /from\s*\(\s*select\s+\*\s+from\s+[\w.]+\s*\)/i },
    { add: "from (select * from raw_orders)" },
    { add: "from {{ ref('t') }}" },
  ),
  r(
    "distinct-on",
    "sql_quality",
    "suggestion",
    "DISTINCT ON is Postgres-specific",
    "`DISTINCT ON (…)` isn't portable; use `qualify row_number()` for first-row-per-group.",
    { added: /distinct\s+on\s*\(/i, portability: { worksOn: ["postgres", "duckdb"] } },
    { add: "select distinct on (id) * from t" },
    { add: "qualify row_number() over (partition by id order by d) = 1" },
  ),
  r(
    "fetch-first",
    "sql_quality",
    "suggestion",
    "FETCH FIRST portability",
    "`FETCH FIRST n ROWS` isn't supported everywhere; `LIMIT` (with ORDER BY) is more portable.",
    { added: /fetch\s+first\s+\d+/i, portability: { worksOn: ["postgres", "snowflake", "oracle", "trino", "duckdb"] } },
    { add: "fetch first 10 rows only" },
    { add: "limit 10" },
  ),
  r(
    "string-truncate-left",
    "sql_correctness",
    "suggestion",
    "LEFT/SUBSTR truncation may cut data",
    "`left(x, n)`/`substr(x,1,n)` silently truncates longer values; confirm n covers real lengths.",
    { added: /\b(left|substr|substring)\s*\(\s*[\w.]+\s*,\s*\d/i },
    { add: "left(description, 50)" },
    { add: "description" },
  ),
  r(
    "concat-number-string",
    "sql_correctness",
    "suggestion",
    "implicit number→string in concat",
    "Concatenating a number with `||`/concat relies on an implicit cast; cast explicitly.",
    { added: /\b\d+\s*\|\|\s*'|'\s*\|\|\s*\d/i },
    { add: "select 5 || ' items'" },
    { add: "select cast(5 as string) || ' items'" },
  ),
  r(
    "redundant-distinct-count",
    "sql_quality",
    "suggestion",
    "COUNT(DISTINCT <constant>)",
    "`count(distinct 1)` is just `min(1)`/`sign(count(*))`; almost certainly a mistake.",
    { added: /count\s*\(\s*distinct\s+\d+\s*\)/i },
    { add: "count(distinct 1)" },
    { add: "count(distinct id)" },
  ),
  r(
    "in-empty-list",
    "sql_correctness",
    "warning",
    "empty IN () list",
    "`in ()` is invalid or always-false; likely a templating bug that emptied the list.",
    { added: /\bin\s*\(\s*\)/i },
    { add: "where id in ()" },
    { add: "where id in (1)" },
  ),
  r(
    "cast-chain",
    "sql_quality",
    "suggestion",
    "chained casts",
    "`cast(cast(x as string) as int)` round-trips types and hides intent; cast once.",
    { added: /cast\s*\(\s*cast\s*\(/i },
    { add: "cast(cast(x as string) as int)" },
    { add: "cast(x as int)" },
  ),
  r(
    "union-select-star",
    "sql_correctness",
    "warning",
    "SELECT * in a UNION",
    "`select *` on either side of a UNION breaks (column count/order) the moment a column is added.",
    { newSql: /select\s+\*[\s\S]*\bunion\b/i },
    { add: "select * from a union all select * from b" },
    { add: "select id from a union all select id from b" },
  ),
  r(
    "group-by-all-ordinal",
    "sql_quality",
    "suggestion",
    "GROUP BY ALL hides grain",
    "`GROUP BY ALL` is convenient but obscures the grain and silently changes when you add a column.",
    { added: /\bgroup\s+by\s+all\b/i },
    { add: "group by all" },
    { add: "group by customer_id, order_date" },
  ),
  r(
    "where-not-null-or",
    "sql_correctness",
    "suggestion",
    "OR with IS NULL can defeat an index/prune",
    "`where a = x or a is null` is hard to optimize; consider coalesce or a UNION.",
    { added: /\bwhere\b[\s\S]*=\s*[^;]*\bor\b[\s\S]*\bis\s+null\b/i },
    { add: "where status = 'x' or status is null" },
    { add: "where coalesce(status,'x') = 'x'" },
  ),
  r(
    "timestamp-string-format",
    "sql_correctness",
    "suggestion",
    "parsing date from string without format",
    "`to_date`/`parse_date` without an explicit format guesses and NULLs unparseable rows.",
    { added: /\b(to_date|to_timestamp|parse_date|parse_timestamp)\s*\(\s*[\w.]+\s*\)/i },
    { add: "to_date(order_date)" },
    { add: "to_date('%Y-%m-%d', order_date)" },
  ),
  r(
    "bool-and-or-mix-3",
    "sql_correctness",
    "suggestion",
    "three-way AND/OR mix needs parentheses",
    "Long `a and b or c and d` chains are precedence traps; parenthesize the intended grouping.",
    { added: /\b\w+[^;]*\band\b[^;]*\bor\b[^;]*\band\b/i, unless: /\(/ },
    { add: "where a and b or c and d" },
    { add: "where (a and b) or (c and d)" },
  ),
  r(
    "count-of-nullable-pct",
    "sql_correctness",
    "suggestion",
    "rate from COUNT(col) over COUNT(*)",
    "`count(col)/count(*)` mixes NULL-skipping and row counts — usually a denominator bug.",
    { added: /count\s*\(\s*[\w.]+\s*\)\s*\/\s*count\s*\(\s*\*\s*\)/i },
    { add: "count(converted)/count(*)" },
    { add: "countif(converted)/count(*)" },
  ),
  r(
    "hardcoded-row-id",
    "sql_quality",
    "suggestion",
    "hardcoded id literal in a predicate",
    "Filtering on a specific id (`where id = 12345`) is usually leftover debugging.",
    { added: /\bwhere\b[\s\S]*\b\w*id\s*=\s*\d{3,}/i },
    { add: "where customer_id = 12345" },
    { add: "where customer_id = c.id" },
  ),
  r(
    "select-now-column",
    "idempotency",
    "suggestion",
    "now() materialized as a column value",
    "Storing `current_timestamp` as a data column (not an audit field) bakes run time into the data.",
    { added: /\b(current_timestamp|now|current_date)\s*\(\s*\)\s+as\s+(?!_)/i },
    { add: "current_timestamp() as snapshot_time" },
    { add: "current_timestamp() as _loaded_at" },
  ),
  r(
    "string-in-numeric-agg",
    "sql_correctness",
    "suggestion",
    "SUM/AVG over a string-typed column",
    "Aggregating a column that looks string-typed (`_str`/`_code`) implies a missing cast.",
    { added: /\b(sum|avg)\s*\(\s*\w*(_str|_code|_text)\b/i },
    { add: "sum(amount_str)" },
    { add: "sum(cast(amount_str as numeric))" },
  ),
  r(
    "join-without-schema-prefix",
    "sql_quality",
    "suggestion",
    "join target not via ref()/source()",
    "A join to a bare table name (not `ref`/`source`) drops the lineage edge.",
    { added: /\bjoin\s+[a-z_]\w*\s+\w+\s+on\b/i, unless: /\{\{|unnest|lateral|flatten/i },
    { add: "join orders o on o.id = c.id" },
    { add: "join {{ ref('orders') }} o on o.id = c.id" },
  ),
  r(
    "subquery-in-select-count",
    "warehouse_cost",
    "suggestion",
    "correlated COUNT subquery in SELECT",
    "A `(select count(*) …)` per row is O(n²); rewrite as a GROUP BY join.",
    { added: /,\s*\(\s*select\s+count\s*\(/i },
    { add: "select id, (select count(*) from o where o.cid=c.id)" },
    { add: "select id, order_count from c" },
  ),
  r(
    "case-when-no-end",
    "sql_correctness",
    "warning",
    "CASE without END",
    "A `CASE WHEN` with no matching `END` on the line/expression is a syntax error.",
    { added: /\bcase\s+when\b[^;]*$/i, unless: /\bend\b|\{\{|\{%/i },
    { add: "case when x > 0 then 1" },
    { add: "case when x > 0 then 1 end" },
  ),
  r(
    "double-aggregation-alias",
    "sql_correctness",
    "suggestion",
    "aggregate of an aggregate alias",
    "Referencing an aggregate alias inside another aggregate needs a subquery/CTE, not the same SELECT.",
    { added: /\b(sum|avg|max|min)\s*\(\s*\w*(total|sum|count|avg)_/i },
    { add: "avg(total_revenue)" },
    { add: "avg(revenue)" },
  ),
  r(
    "where-cast-column",
    "warehouse_cost",
    "suggestion",
    "CAST on a filtered column blocks pruning",
    "Casting a column in WHERE (e.g. `cast(d as date) = …`) prevents partition/cluster pruning.",
    { added: /\bwhere\b[^;]*\bcast\s*\(/i },
    { add: "where cast(created_at as date) = '2024-01-01'" },
    { add: "where created_at >= '2024-01-01'" },
  ),
  r(
    "inequality-join",
    "warehouse_cost",
    "suggestion",
    "inequality / range join is expensive",
    "`join … on a.d between b.start and b.end` can't hash-join and may explode; bound it carefully.",
    { added: /\bon\b[^;]*\bbetween\b/i },
    { add: "on a.d between b.start and b.end" },
    { add: "on a.id = b.id" },
  ),
  r(
    "string-concat-key-no-sep",
    "dedup",
    "suggestion",
    "key built by concatenation without a separator",
    "`a || b` as a key collides (`'1'||'23'` == `'12'||'3'`); add a delimiter or use generate_surrogate_key.",
    { added: /\b\w+\s*\|\|\s*\w+\s+as\s+\w*(key|id|sk)\b/i },
    { add: "a || b as customer_key" },
    { add: "a || '-' || b as customer_key" },
  ),
  r(
    "count-star-with-left-join",
    "fanout",
    "suggestion",
    "COUNT(*) after a LEFT JOIN counts unmatched rows",
    "`count(*)` after a LEFT JOIN counts the 1 NULL-filled row for non-matches; use count(child.key).",
    { newSql: /count\s*\(\s*\*\s*\)[\s\S]*left\s+join/i },
    { add: "select a.id, count(*) from a left join b on a.id=b.aid group by 1" },
    { add: "select a.id, count(b.id) from a left join b on a.id=b.aid group by 1" },
  ),
  r(
    "string-length-no-trim",
    "sql_correctness",
    "suggestion",
    "length() on un-trimmed string",
    "`length(x) = 0` misses whitespace-only values; trim first or check for blanks explicitly.",
    { added: /\blength\s*\(\s*[\w.]+\s*\)\s*=\s*0/i },
    { add: "where length(name) = 0" },
    { add: "where trim(name) = ''" },
  ),
  r(
    "update-from-in-model",
    "sql_correctness",
    "critical",
    "UPDATE … FROM in a model",
    "An `UPDATE` statement mutates data directly, bypassing dbt's rebuild model — not allowed in a model.",
    { added: /\bupdate\s+\w+\s+set\b/i },
    { add: "update t set x = 1" },
    { add: "select 1 as x" },
  ),
  r(
    "truncate-in-model",
    "sql_correctness",
    "critical",
    "TRUNCATE inside a model",
    "`TRUNCATE` empties a table on every build — destructive and not a transform.",
    { added: /\btruncate\s+(table\s+)?\w/i },
    { add: "truncate table staging" },
    { add: "select * from staging" },
  ),
  r(
    "ddl-grant",
    "pii_exposure",
    "warning",
    "GRANT/REVOKE statement in a model",
    "Access-control DDL (`GRANT`/`REVOKE`) doesn't belong in transform SQL; manage grants via config/hooks.",
    { added: /\b(grant|revoke)\s+\w/i },
    { add: "grant select on t to role analyst" },
    { add: "select 1" },
  ),
  r(
    "create-or-replace",
    "sql_correctness",
    "critical",
    "CREATE OR REPLACE in a model",
    "dbt issues the CREATE; a hand-written `CREATE OR REPLACE` conflicts with materialization.",
    { added: /\bcreate\s+or\s+replace\b/i },
    { add: "create or replace table t as select 1" },
    { add: "select 1" },
  ),
  r(
    "group-by-count-mismatch",
    "sql_quality",
    "suggestion",
    "many GROUP BY positions — verify against SELECT",
    "Long positional `group by 1,2,3,4,5` is fragile; one reorder silently changes the grain.",
    { added: /\bgroup\s+by\s+\d+(\s*,\s*\d+){3,}/i },
    { add: "group by 1,2,3,4,5" },
    { add: "group by customer_id" },
  ),
  r(
    "ilike-anywhere",
    "warehouse_cost",
    "suggestion",
    "ILIKE with surrounding wildcards",
    "`ilike '%x%'` is a case-insensitive full scan; consider a search index or normalized column.",
    { added: /\bilike\s+'%[^']*%'/i },
    { add: "where name ilike '%shirt%'" },
    { add: "where name = 'shirt'" },
  ),
]

const MISC2: Rule[] = [
  r(
    "coalesce-all-null",
    "sql_correctness",
    "warning",
    "COALESCE(NULL, NULL) is always NULL",
    "Every COALESCE branch is a NULL literal — the expression can only be NULL.",
    { added: /coalesce\s*\(\s*null\s*,\s*null/i },
    { add: "coalesce(null, null)" },
    { add: "coalesce(a, 0)" },
  ),
  r(
    "self-equality",
    "sql_correctness",
    "warning",
    "predicate compares a column to itself",
    "`where x = x` is true for non-NULL rows and silently drops NULLs — almost always a typo.",
    { added: /\bwhere\s+(\w[\w.]*)\s*=\s*\1\b/i },
    { add: "where status = status" },
    { add: "where status = active" },
  ),
  r(
    "join-self-column",
    "join_risk",
    "warning",
    "join condition compares a column to itself",
    "`on a.x = a.x` doesn't relate the tables (cartesian on that key). Reference both sides.",
    { added: /\bon\s+(\w+\.\w+)\s*=\s*\1\b/i },
    { add: "on a.id = a.id" },
    { add: "on a.id = b.id" },
  ),
  r(
    "count-distinct-star",
    "sql_correctness",
    "warning",
    "COUNT(DISTINCT *) is invalid/ambiguous",
    "`count(distinct *)` isn't valid SQL on most warehouses; count distinct explicit columns.",
    { added: /count\s*\(\s*distinct\s*\*/i },
    { add: "count(distinct *)" },
    { add: "count(distinct id)" },
  ),
  r(
    "empty-string-eq",
    "sql_correctness",
    "suggestion",
    "comparing to empty string '' ",
    "`= ''` treats empty and NULL differently across warehouses; decide and handle both explicitly.",
    { added: /=\s*''/ },
    { add: "where name = ''" },
    { add: "where name is null" },
  ),
  r(
    "decimal-no-scale",
    "sql_correctness",
    "suggestion",
    "money cast to NUMERIC without scale",
    "`cast(amount as numeric)` (no precision/scale) may default to integer rounding on some engines.",
    { added: /cast\s*\(\s*\w*(amount|price|revenue|total|cost)\w*\s+as\s+(numeric|decimal)\s*\)/i },
    { add: "cast(amount as numeric)" },
    { add: "cast(amount as numeric(38,4))" },
  ),
  r(
    "substr-zero-index",
    "sql_correctness",
    "suggestion",
    "SUBSTR starting at position 0",
    "SQL string positions are 1-based; `substr(x, 0, n)` behaves inconsistently across warehouses.",
    { added: /\bsubstr(ing)?\s*\(\s*[\w.]+\s*,\s*0\b/i },
    { add: "substr(code, 0, 3)" },
    { add: "substr(code, 1, 3)" },
  ),
  r(
    "current-user",
    "idempotency",
    "suggestion",
    "CURRENT_USER/SESSION_USER in a model",
    "Session identity functions vary by who runs the build, making output non-reproducible.",
    { added: /\b(current_user|session_user|current_role)\b/i },
    { add: "select current_user as u" },
    { add: "select '{{ target.name }}' as env" },
  ),
  r(
    "greatest-least-null",
    "sql_correctness",
    "suggestion",
    "GREATEST/LEAST NULL behavior varies",
    "Some warehouses return NULL if any GREATEST/LEAST argument is NULL — guard nullable inputs.",
    { added: /\b(greatest|least)\s*\(/i, unless: /coalesce|nvl|ifnull/i },
    { add: "greatest(a, b)" },
    { add: "greatest(coalesce(a,0), coalesce(b,0))" },
  ),
  r(
    "json-extract-no-cast",
    "sql_correctness",
    "suggestion",
    "JSON extraction without a cast",
    "`json_extract`/`json_value` returns JSON/string; cast so downstream types are stable.",
    { added: /json_(extract|value|query)\s*\(/i, unless: /::|cast/i },
    { add: "json_extract(payload, '$.id')" },
    { add: "cast(json_extract(payload, '$.id') as int)" },
  ),
  r(
    "where-leading-and",
    "sql_correctness",
    "warning",
    "WHERE immediately followed by AND/OR",
    "`where and …` is a syntax error — usually a templating bug that dropped the first predicate.",
    { added: /\bwhere\s+(and|or)\b/i },
    { add: "where and status = 'x'" },
    { add: "where status = 'x'" },
  ),
  r(
    "nested-coalesce",
    "sql_quality",
    "suggestion",
    "nested COALESCE",
    "`coalesce(coalesce(a,b),c)` flattens to `coalesce(a,b,c)`; simplify.",
    { added: /coalesce\s*\(\s*coalesce\s*\(/i },
    { add: "coalesce(coalesce(a,b),c)" },
    { add: "coalesce(a,b,c)" },
  ),
  r(
    "cast-as-text",
    "sql_quality",
    "suggestion",
    "non-portable type name (TEXT)",
    "`cast(x as text)` isn't supported on all warehouses; use `string`/`varchar`.",
    { added: /\bas\s+text\b/i, portability: { worksOn: ["postgres", "redshift", "duckdb", "snowflake"] } },
    { add: "cast(x as text)" },
    { add: "cast(x as string)" },
  ),
  // order-desc-no-nulls removed: flagged EVERY `order by x desc` for a missing
  // NULLS LAST/FIRST — noise on the overwhelmingly common case (warehouses have
  // sane default NULL ordering). Measured FP in the real-world corpus.
  r(
    "power-caret",
    "sql_correctness",
    "suggestion",
    "`^` is XOR, not power, on some warehouses",
    "`a ^ b` is bitwise XOR in BigQuery/Snowflake (power in Postgres); use POW()/POWER() for exponent.",
    { added: /[\w.)]\s*\^\s*\d/ },
    { add: "select value ^ 2" },
    { add: "select power(value, 2)" },
  ),
  r(
    "approx-in-financial",
    "sql_correctness",
    "suggestion",
    "approximate function in a financial model",
    "`APPROX_*`/`HLL` trade accuracy for speed — never use them where exact counts/sums are required.",
    {
      added: /\b(approx_count_distinct|approx_quantiles|hll_count)\b/i,
      pathGlob: /(revenue|finance|billing|fct_revenue)/i,
    },
    { add: "approx_count_distinct(id)", path: "models/marts/fct_revenue.sql" },
    { add: "count(distinct id)", path: "models/marts/fct_revenue.sql" },
  ),
]

CATALOG.push(
  ...CORRECTNESS,
  ...NULLS,
  ...DATETIME,
  ...TYPES,
  ...JOINS,
  ...AGG,
  ...WINDOWS,
  ...PERF,
  ...MATERIALIZATION,
  ...DBT_CONV,
  ...TESTS_CONTRACTS,
  ...SNAPSHOTS,
  ...SECURITY_PII,
  ...BIGQUERY,
  ...SNOWFLAKE,
  ...REDSHIFT,
  ...DATABRICKS,
  ...STYLE,
  ...MISC,
  ...MISC2,
)
// NOTE: the large generated families (dialect-specific functions, reserved
// words, non-portable types, operators) used to live in `rule-generators.ts`.
// That curated knowledge now ships in the compiled core (L033 functions, L035
// types, `review_lexical_scan` for reserved-words/operators) — see
// orchestrate.ts. This catalog keeps only the hand-written structural / dbt
// rules; the engine owns the bulk and runs over parsed ASTs.
