/** Drivers that enforce ExecuteOptions.readOnly at the database boundary. */
const ENFORCED = new Set(["postgres", "postgresql", "sqlite", "duckdb"])

/**
 * The caveat for a connection whose driver does not enforce read-only. A malformed connection without a string
 * type has no driver to caveat (it cannot connect), so it gets none rather than crashing the caller.
 */
export function readOnlyCaveat(connection: { name: string; type?: unknown }): string | undefined {
  if (typeof connection.type !== "string" || ENFORCED.has(connection.type.toLowerCase())) return undefined
  return `${connection.name} (${connection.type}): read-only is enforced by SQL classification only; stored functions with side effects are not blocked — use a read-only database user`
}
