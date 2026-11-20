// altimate_change - new file
const CHECKS: Record<string, string> = {
  finops_databricks_savings: "Databricks",
  finops_snowflake_savings: "Snowflake",
}

/**
 * The prompt for a savings check's permission, naming the connection it runs on, which the check puts
 * first in the patterns. Undefined for every other permission.
 */
export function savingsPermissionPrompt(permission: string, patterns: readonly unknown[] | undefined) {
  const platform = CHECKS[permission]
  if (!platform) return undefined
  const connection = patterns?.[0]
  return {
    title: `Run the ${platform} savings check on ${typeof connection === "string" && connection !== "*" ? connection : "the default connection"}`,
    note: "Read-only queries that can start this connection's warehouse and bill while they run.",
  }
}
