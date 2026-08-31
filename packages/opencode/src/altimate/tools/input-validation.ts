// altimate_change - new file
//
// Pre-flight input checks shared by the warehouse tools. They run BEFORE workspace
// precedence is consulted: a redirect must never forward malformed input to the
// engine tool, and an empty or placeholder warehouse name must not be read as
// "use the default" by the routing decision.

/** Warehouse names that models produce by mistake: empty strings and unsubstituted
 * placeholders. Both would otherwise fall through to unhelpful registry errors. */
export function validateWarehouseName(warehouse: string | undefined): string | null {
  if (warehouse === undefined) return null
  if (typeof warehouse !== "string") {
    return "warehouse must be a string"
  }
  const trimmed = warehouse.trim()
  if (trimmed.length === 0) {
    return "warehouse is an empty string — omit the parameter to use the default warehouse, or pass a configured connection name"
  }
  if (/^[?$:@]/.test(trimmed)) {
    return (
      "warehouse name looks like an unsubstituted placeholder (" +
      JSON.stringify(trimmed) +
      "). Use `warehouse_list` to see configured warehouses."
    )
  }
  return null
}

/** Table names get the same two checks; the schema tool has nothing to inspect otherwise. */
export function validateTableName(table: unknown): string | null {
  if (typeof table !== "string" || table.trim().length === 0) {
    return "table is required — pass a table name, optionally schema-qualified"
  }
  if (/^[?$:@]/.test(table.trim())) {
    return "table name looks like an unsubstituted placeholder (" + JSON.stringify(table.trim()) + ")"
  }
  return null
}
