/**
 * Schema resolution helpers for altimate-core native bindings.
 *
 * Translates the bridge protocol's `schema_path` / `schema_context` parameters
 * into altimate-core `Schema` objects.
 *
 * Tools pass `schema_context` in two possible formats:
 *
 * 1. **Flat format** (used by most tools):
 *    `{ "table_name": { "col_name": "TYPE", ... } }`
 *
 * 2. **SchemaDefinition format** (matches Rust struct):
 *    `{ "tables": { "table_name": { "columns": [{ "name": "col", "type": "TYPE" }] } } }`
 *
 * This module normalizes both formats into the SchemaDefinition format
 * expected by `Schema.fromJson()`.
 */

import { Schema } from "@altimateai/altimate-core"
import fs from "node:fs"
import path from "node:path"
import YAML from "yaml"

/**
 * Detect whether a schema_context object is in flat format or SchemaDefinition format.
 *
 * Flat format: `{ "table_name": { "col_name": "TYPE" } }`
 * SchemaDefinition format: has a `tables` key with nested structure.
 */
function isSchemaDefinitionFormat(ctx: Record<string, any>): boolean {
  if (!("tables" in ctx) || typeof ctx.tables !== "object" || ctx.tables === null) {
    return false
  }
  // Verify at least one value under `tables` looks like a table definition
  // (has a `columns` array), not a flat column map like { "col": "TYPE" }.
  // This prevents false positives when a flat schema has a table named "tables".
  const values = Object.values(ctx.tables)
  if (values.length === 0) return true // empty tables is valid SchemaDefinition
  return values.some((v: any) => Array.isArray(v?.columns))
}

/**
 * Convert flat schema format to SchemaDefinition format.
 *
 * Handles three input variants:
 *
 * 1. Flat map:   `{ "customers": { "id": "INTEGER", "name": "VARCHAR" } }`
 * 2. Array form: `{ "customers": [{ "name": "id", "data_type": "INTEGER" }] }`
 * 3. Partial SD: `{ "customers": { "columns": [{ "name": "id", "type": "INTEGER" }] } }`
 *
 * Output: `{ "tables": { "customers": { "columns": [{ "name": "id", "type": "INTEGER" }, ...] } } }`
 */
function flatToSchemaDefinition(flat: Record<string, any>): Record<string, any> {
  const tables: Record<string, any> = Object.create(null)
  for (const [tableName, colsOrDef] of Object.entries(flat)) {
    if (colsOrDef === null || colsOrDef === undefined) continue

    // Variant 2: array of column definitions
    if (Array.isArray(colsOrDef)) {
      if (colsOrDef.length === 0) continue // skip empty tables
      const columns = colsOrDef.map((c: any) => ({
        name: c.name,
        type: c.type ?? c.data_type ?? "VARCHAR",
      }))
      tables[tableName] = { columns }
    } else if (typeof colsOrDef === "object") {
      // Variant 3: already has a `columns` array
      if (Array.isArray(colsOrDef.columns)) {
        if (colsOrDef.columns.length === 0) continue // skip empty tables
        tables[tableName] = colsOrDef
      } else {
        // Variant 1: flat map { "col_name": "TYPE", ... }
        const entries = Object.entries(colsOrDef)
        if (entries.length === 0) continue // skip empty tables
        const columns = entries.map(([colName, colType]) => ({
          name: colName,
          type: String(colType),
        }))
        tables[tableName] = { columns }
      }
    }
  }
  return { tables }
}

/**
 * The engine compares an UNQUOTED identifier from the SQL in lowercase and a QUOTED one
 * exactly, while warehouse metadata (`schema_inspect`, `snowflake_get_table_stats`) comes
 * back in the warehouse's storage case — uppercase on Snowflake. A correct query validated
 * against real metadata therefore failed with ColumnNotFound, and uppercasing the SQL did
 * not help because the engine lowercased it again (#1333).
 *
 * An all-uppercase name is the storage form of an identifier that was created unquoted, so
 * it is stored lowercase here to meet the engine's unquoted comparison. A mixed-case name
 * was created quoted and must be referenced quoted, which the engine matches exactly, so it
 * is left alone. Lowercase names are already in the engine's form.
 */
export function foldIdentifierCase(name: string): string {
  return name !== name.toLowerCase() && name === name.toUpperCase() ? name.toLowerCase() : name
}

/**
 * Fold every table key and column name. A fold that would land on a name the schema
 * already carries (metadata with both `ORDERS` and `orders`, or `FOO` and `"foo"` columns)
 * keeps the entry as written instead: the two are distinct objects in the warehouse, the
 * schema shape has no quote identity to tell them apart, and overwriting one would drop
 * its columns from validation. The engine resolves such a pair by its own rule (tables by
 * lowercase key, columns first-wins case-insensitively), which is what it did before the
 * fold existed. Null-prototype maps, so a table named `__PROTO__` is an entry, not a
 * prototype write.
 */
export function foldSchemaCase(def: { tables: Record<string, any> }): { tables: Record<string, any> } {
  const source: Record<string, any> = def.tables ?? {}
  const tables: Record<string, any> = Object.create(null)
  const target = (name: string) => {
    const folded = foldIdentifierCase(name)
    return folded !== name && Object.hasOwn(source, folded) ? name : folded
  }
  for (const [tableName, table] of Object.entries(source)) {
    const present = new Set<string>(
      Array.isArray(table?.columns) ? table.columns.map((c: any) => c?.name).filter((n: unknown) => typeof n === "string") : [],
    )
    const columns = Array.isArray(table?.columns)
      ? table.columns.map((c: any) => {
          if (typeof c?.name !== "string") return c
          const folded = foldIdentifierCase(c.name)
          return { ...c, name: folded !== c.name && present.has(folded) ? c.name : folded }
        })
      : table?.columns
    tables[target(tableName)] = { ...table, columns }
  }
  return { ...def, tables }
}

/**
 * The other half of the fold, on the SQL. The engine matches a quoted identifier exactly,
 * so once metadata `ORDER_MONTH` is stored as `order_month` a query that writes
 * `"ORDER_MONTH"` — dbt with `quote_columns`, most BI tools on Snowflake — would miss it.
 * On the warehouses whose metadata comes back uppercase, `"ORDER_MONTH"` names the same
 * column as `order_month` unquoted, so the quoted all-uppercase spelling is lowercased
 * inside its quotes. Same length, so positions in findings do not move; still quoted, so a
 * reserved word (`"ORDER"`) stays an identifier. String literals and comments are stepped
 * over, not searched. Mixed-case quoted names are the exact-match case and are untouched.
 */
export function foldQuotedIdentifierCase(sql: string, names?: ReadonlySet<string>, folded?: Set<string>): string {
  // Skipped spans, in order: dollar-quoted strings ($$…$$, $tag$…$tag$), E'…' strings
  // with backslash escapes, ordinary '…' strings ('' doubles), line and block comments.
  // Then the two quoted-identifier forms: "…" (SQL) and `…` (BigQuery/Databricks), a
  // doubled quote inside either kept as written — that name is not a plain identifier.
  // With `names`, only a token whose lowercase form (or last dotted segment) is a name
  // the folded schema holds is touched: on MySQL/BigQuery/SQLite `"SHIPPED"` is a
  // string literal, and a query's values must not change under validation. Every
  // token folded is recorded in `folded`, so generated SQL can be given back in the
  // caller's spelling (see `PreparedSql.unfold`). The dollar-quote branch needs an
  // identifier boundary before it: `foo$t$` can be an identifier, not a string start.
  return sql.replace(
    /(?<![A-Za-z0-9_$])\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$|[eE]'(?:[^'\\]|\\[\s\S]|'')*'|'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\/|"((?:[^"]|"")*)"|`((?:[^`]|``)*)`/g,
    (match, _tag, dq?: string, bq?: string) => {
      const quoted = dq ?? bq
      if (quoted === undefined) return match
      // A doubled quote inside the name (`"A""B"`) is not a plain identifier: kept.
      if (!/^[A-Z_][A-Z0-9_$.]*$/.test(quoted)) return match
      const lower = quoted.toLowerCase()
      if (names && !names.has(lower) && !names.has(lower.slice(lower.lastIndexOf(".") + 1))) return match
      folded?.add(lower)
      const mark = match[0]
      return `${mark}${lower}${mark}`
    },
  )
}

/** The names the schema fold actually changed — every table key and column name that
 * `foldSchemaCase` stored differently from how the caller wrote it, in folded form,
 * plus each dotted segment of a folded table key (so `"DB"."SCHEMA"."ORDERS"` can meet
 * `db.schema.orders`; a column name's dots are not qualifiers). Only these may be folded
 * in the SQL: a quoted `"SHIPPED_DATE"` against metadata that holds `shipped_date` as
 * written is, on a lowercase-folding warehouse, a reference to a different, quoted
 * identifier, and folding it would validate a query Postgres rejects. A name the fold
 * kept as written because its folded form already existed (`ORDERS` beside `orders`) is
 * not folded in the SQL either, so `"ORDERS"` cannot be bound to the sibling object. */
function foldedNames(original: { tables: Record<string, any> }, folded: { tables: Record<string, any> }): Set<string> {
  const names = new Set<string>()
  for (const [table, value] of Object.entries(original.tables ?? {})) {
    const key = foldIdentifierCase(table)
    if (key !== table && Object.hasOwn(folded.tables, key) && !Object.hasOwn(folded.tables, table)) {
      names.add(key)
      for (const segment of key.split(".")) names.add(segment)
    }
    const stored = folded.tables[Object.hasOwn(folded.tables, table) ? table : key]
    const storedNames = new Set<string>(
      Array.isArray(stored?.columns) ? stored.columns.map((c: any) => c?.name).filter((n: unknown) => typeof n === "string") : [],
    )
    if (Array.isArray(value?.columns)) {
      for (const c of value.columns) {
        if (typeof c?.name !== "string") continue
        const column = foldIdentifierCase(c.name)
        if (column !== c.name && storedNames.has(column) && !storedNames.has(c.name)) names.add(column)
      }
    }
  }
  return names
}

/**
 * Normalize a schema_context into SchemaDefinition JSON format.
 * Accepts both flat and SchemaDefinition formats.
 */
export function normalizeSchemaContext(ctx: Record<string, any>, opts: { fold?: boolean } = {}): string {
  return JSON.stringify(normalizedSchemaDefinition(ctx, opts))
}

/** `fold` applies the identifier-case fold (see `foldIdentifierCase`). It is for
 * operations that match SQL against the schema — the engine's comparison rules are
 * what the fold answers to. Schema-only operations (diff, export, fingerprint) get
 * the names as the caller wrote them. */
function normalizedSchemaDefinition(ctx: Record<string, any>, opts: { fold?: boolean } = {}): { tables: Record<string, any> } {
  const def = (isSchemaDefinitionFormat(ctx) ? ctx : flatToSchemaDefinition(ctx)) as { tables: Record<string, any> }
  return opts.fold ? foldSchemaCase(def) : def
}

/**
 * Whether the caller really supplied a schema to check existence against. A `schema_path`
 * counts as one. A `schema_context` counts only if it normalises to at least one table:
 * `{ tables: {} }` and `{ users: {} }` are reachable inputs that carry no table; the
 * engine refuses them, and the no-schema path is what the caller meant.
 */
export function schemaProvided(schemaPath?: string, schemaContext?: Record<string, any>): boolean {
  if (schemaPath) return true
  if (!schemaContext || Object.keys(schemaContext).length === 0) return false
  return Object.keys(normalizedSchemaDefinition(schemaContext).tables).length > 0
}

/**
 * Resolve a Schema from a file path or inline JSON context.
 * Returns null when neither source is provided.
 */
export function resolveSchema(
  schemaPath?: string,
  schemaContext?: Record<string, any>,
): Schema | null {
  if (schemaPath) {
    return Schema.fromFile(schemaPath)
  }
  // A context that normalises to no table is no schema: the engine refuses an empty
  // definition outright ("Schema must define at least one table"), so `{ tables: {} }`
  // used to fail the call instead of running the no-schema path.
  if (schemaProvided(undefined, schemaContext)) {
    return Schema.fromJson(normalizeSchemaContext(schemaContext!))
  }
  return null
}

/** What an operation that matches SQL against a schema runs on. */
export interface PreparedSql {
  sql: string
  schema: Schema
  /** A schema was really supplied (see `schemaProvided`). */
  hasSchema: boolean
  /** The same preparation for another SQL text matched against this schema (a base
   * query, a lineage batch): folded exactly when `sql` was, untouched otherwise. */
  foldSql: (other: string) => string
  /** The caller's spelling restored in engine output: every quoted token this
   * preparation lowercased is put back in uppercase wherever it appears in a string
   * — a rewritten query, a fix, a generated test — walking objects and arrays. The
   * fold is a comparison form for matching against folded metadata, not a spelling
   * a case-sensitive warehouse would accept, so generated SQL must not carry it. */
  unfold: <T>(value: T) => T
}

/**
 * The SQL and schema for an operation that matches one against the other: the schema
 * with its identifier case folded and the SQL's quoted all-uppercase identifiers folded
 * to meet it (#1333) — both halves or neither, since a folded schema against unfolded
 * SQL, or the reverse, is the mismatch the fold exists to remove. Only quoted names the
 * folded schema holds are touched. A `schema_path` in JSON or YAML goes through the
 * same normalisation as an inline context; a DDL file carries its own case semantics
 * and is loaded as-is, with the SQL left alone.
 */
export function prepareSql(sql: string, schemaPath?: string, schemaContext?: Record<string, any>): PreparedSql {
  const asIs = (other: string) => other
  const identity = <T>(value: T) => value
  const folding = (original: { tables: Record<string, any> }, def: { tables: Record<string, any> }, schema: Schema): PreparedSql => {
    const names = foldedNames(original, def)
    const folded = new Set<string>()
    const foldSql = (other: string) => foldQuotedIdentifierCase(other, names, folded)
    return { sql: foldSql(sql), schema, hasSchema: true, foldSql, unfold: (value) => unfoldValue(value, folded) }
  }
  if (schemaPath) {
    const loaded = loadSchemaFile(schemaPath)
    if (loaded.original && loaded.schema) return folding(loaded.original, foldSchemaCase(loaded.original), loaded.schema)
    if (!loaded.schema) return { sql, schema: EMPTY_SCHEMA(), hasSchema: false, foldSql: asIs, unfold: identity }
    return { sql, schema: loaded.schema, hasSchema: true, foldSql: asIs, unfold: identity }
  }
  if (schemaProvided(undefined, schemaContext)) {
    const original = normalizedSchemaDefinition(schemaContext!)
    const def = foldSchemaCase(original)
    return folding(original, def, Schema.fromJson(JSON.stringify(def)))
  }
  return { sql, schema: EMPTY_SCHEMA(), hasSchema: false, foldSql: asIs, unfold: identity }
}

function unfoldValue<T>(value: T, folded: ReadonlySet<string>): T {
  if (folded.size === 0) return value
  if (typeof value === "string") return unfoldText(value, folded) as T
  if (Array.isArray(value)) return value.map((item) => unfoldValue(item, folded)) as T
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = unfoldValue(v, folded)
    return out as T
  }
  return value
}

/** Quoted tokens (`"…"` or `` `…` ``) whose content is one this preparation folded go
 * back to uppercase — the spelling the caller wrote, since the fold only ever took an
 * all-uppercase name down. A lowercase quoted name the caller wrote themselves was
 * never recorded and is left alone. */
function unfoldText(text: string, folded: ReadonlySet<string>): string {
  return text.replace(/"([^"]*)"|`([^`]*)`/g, (match, dq?: string, bq?: string) => {
    const quoted = dq ?? bq
    if (quoted === undefined || !folded.has(quoted)) return match
    const mark = match[0]
    return `${mark}${quoted.toUpperCase()}${mark}`
  })
}

/** `original` carries the normalised, unfolded definition when the file was normalised
 * here (the folded one is what `schema` was built from); no `schema` at all means the
 * file parsed to zero tables — no schema, not an error (the engine would refuse an
 * empty definition outright). An unreadable or malformed file still throws. */
function loadSchemaFile(schemaPath: string): { schema?: Schema; original?: { tables: Record<string, any> } } {
  const ext = path.extname(schemaPath).toLowerCase()
  if (ext === ".json" || ext === ".yaml" || ext === ".yml") {
    const text = fs.readFileSync(schemaPath, "utf8")
    const parsed = ext === ".json" ? JSON.parse(text) : YAML.parse(text)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const original = normalizedSchemaDefinition(parsed)
      if (Object.keys(original.tables).length === 0) return {}
      return { schema: Schema.fromJson(JSON.stringify(foldSchemaCase(original))), original }
    }
  }
  return { schema: Schema.fromFile(schemaPath) }
}

const EMPTY_SCHEMA = () => Schema.fromDdl("CREATE TABLE _empty_ (id INT);")

/**
 * Resolve a Schema, falling back to a minimal empty schema when none is provided.
 * Use this for functions that require a non-null Schema argument.
 */
export function schemaOrEmpty(
  schemaPath?: string,
  schemaContext?: Record<string, any>,
): Schema {
  const s = resolveSchema(schemaPath, schemaContext)
  if (s !== null) return s
  return EMPTY_SCHEMA()
}

export * as SchemaResolver from "./schema-resolver"
