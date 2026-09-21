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
export function foldQuotedIdentifierCase(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\/|"([^"]*)"/g, (match, quoted?: string) => {
    if (quoted === undefined) return match
    return /^[A-Z_][A-Z0-9_$]*$/.test(quoted) ? `"${quoted.toLowerCase()}"` : match
  })
}

/**
 * Normalize a schema_context into SchemaDefinition JSON format.
 * Accepts both flat and SchemaDefinition formats.
 */
export function normalizeSchemaContext(ctx: Record<string, any>): string {
  return JSON.stringify(normalizedSchemaDefinition(ctx))
}

function normalizedSchemaDefinition(ctx: Record<string, any>): { tables: Record<string, any> } {
  const def = (isSchemaDefinitionFormat(ctx) ? ctx : flatToSchemaDefinition(ctx)) as { tables: Record<string, any> }
  return foldSchemaCase(def)
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
  return Schema.fromDdl("CREATE TABLE _empty_ (id INT);")
}

export * as SchemaResolver from "./schema-resolver"
