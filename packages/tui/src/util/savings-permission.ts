// altimate_change - new file
// A Map, so a permission named like an inherited property (`constructor`) is not mistaken for a check.
const CHECKS = new Map([
  ["finops_databricks_savings", "Databricks"],
  ["finops_snowflake_savings", "Snowflake"],
])

/**
 * The prompt for a savings check's permission, naming the connection it runs on, which the check puts
 * first in the patterns. Undefined for every other permission. The TUI and the `run` prompt both use it.
 */
export function savingsPermissionPrompt(permission: string, patterns: readonly unknown[] | undefined) {
  const platform = CHECKS.get(permission)
  if (!platform) return undefined
  const connection = patterns?.[0]
  return {
    title: `Run the ${platform} savings check on ${typeof connection === "string" && connection !== "*" ? connection : "the default connection"}`,
    note: "Read-only queries that can start this connection's warehouse and bill while they run.",
  }
}
