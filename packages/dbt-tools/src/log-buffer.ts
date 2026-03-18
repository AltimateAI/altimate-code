/**
 * In-memory ring buffer for dbt log messages.
 *
 * Captures dbt-integration library logging without writing to stdout/stderr,
 * which would corrupt the TUI display (see #249). Buffered logs can be
 * retrieved for diagnostics via getRecentDbtLogs().
 */

const DBT_LOG_BUFFER_SIZE = 100
const dbtLogBuffer: string[] = []

export function bufferLog(msg: string): void {
  if (dbtLogBuffer.length >= DBT_LOG_BUFFER_SIZE) {
    dbtLogBuffer.shift()
  }
  dbtLogBuffer.push(msg)
}

/** Retrieve recent dbt log messages (for diagnostics / error reporting). */
export function getRecentDbtLogs(): string[] {
  return [...dbtLogBuffer]
}

/** Clear buffered logs (call on session/adapter reset). */
export function clearDbtLogs(): void {
  dbtLogBuffer.length = 0
}
