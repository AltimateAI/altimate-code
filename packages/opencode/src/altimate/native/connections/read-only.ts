/** Drivers that enforce ExecuteOptions.readOnly at the database boundary. */
const ENFORCED = new Set(["postgres", "postgresql", "sqlite", "duckdb"])

export function readOnlyCaveat(connection: { name: string; type: string }): string | undefined {
  if (ENFORCED.has(connection.type.toLowerCase())) return undefined
  return `${connection.name} (${connection.type}): read-only is enforced by SQL classification only; stored functions with side effects are not blocked — use a read-only database user`
}
