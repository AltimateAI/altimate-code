/**
 * SQL string escaping utility for preventing SQL injection.
 *
 * Used when parameterized queries are not available (e.g., our connector's
 * execute(sql) method doesn't support bind parameters).
 */

/**
 * Escape a string value for safe interpolation into a SQL single-quoted literal.
 * Doubles single quotes and escapes backslashes.
 */
export function escapeSqlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "''")
}

/**
 * Escape a SQL identifier (schema, table, column name) by doubling double quotes.
 */
export function escapeSqlIdentifier(value: string): string {
  return value.replace(/"/g, '""')
}
