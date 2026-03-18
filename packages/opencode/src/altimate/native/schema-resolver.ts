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
  const tables: Record<string, any> = {}
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
 * Normalize a schema_context into SchemaDefinition JSON format.
 * Accepts both flat and SchemaDefinition formats.
 */
function normalizeSchemaContext(ctx: Record<string, any>): string {
  if (isSchemaDefinitionFormat(ctx)) {
    return JSON.stringify(ctx)
  }
  return JSON.stringify(flatToSchemaDefinition(ctx))
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
  if (schemaContext && Object.keys(schemaContext).length > 0) {
    return Schema.fromJson(normalizeSchemaContext(schemaContext))
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
