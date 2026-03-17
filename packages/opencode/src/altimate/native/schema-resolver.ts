/**
 * Schema resolution helpers for altimate-core native bindings.
 *
 * Translates the bridge protocol's `schema_path` / `schema_context` parameters
 * into altimate-core `Schema` objects.
 */

import { Schema } from "@altimateai/altimate-core"

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
    return Schema.fromJson(JSON.stringify(schemaContext))
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
