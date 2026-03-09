import z from "zod"
import { Tool } from "../../tool/tool"
import { Bridge } from "../bridge/client"

export const DbtProfilesTool = Tool.define("dbt_profiles", {
  description:
    "Discover dbt profiles from profiles.yml and map them to warehouse connections. Auto-detects Snowflake, BigQuery, Databricks, Postgres, Redshift, MySQL, DuckDB configurations.",
  parameters: z.object({
    path: z.string().optional().describe("Path to profiles.yml (defaults to ~/.dbt/profiles.yml)"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("dbt.profiles", {
        path: args.path,
      })

      if (!result.success) {
        return {
          title: "dbt Profiles: FAILED",
          metadata: { success: false, connection_count: 0 },
          output: result.error ?? "Failed to parse profiles.yml",
        }
      }

      const connections = result.connections ?? []
      if (connections.length === 0) {
        return {
          title: "dbt Profiles: No connections found",
          metadata: { success: true, connection_count: 0 },
          output: "No dbt profiles found. Ensure ~/.dbt/profiles.yml exists with valid configurations.",
        }
      }

      return {
        title: `dbt Profiles: ${connections.length} connection(s)`,
        metadata: { success: true, connection_count: connections.length },
        output: formatConnections(connections),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "dbt Profiles: ERROR",
        metadata: { success: false, connection_count: 0 },
        output: `Failed: ${msg}`,
      }
    }
  },
})

function formatConnections(connections: Array<{ name: string; type: string; config: Record<string, unknown> }>): string {
  const lines: string[] = []
  for (const conn of connections) {
    lines.push(`${conn.name} (${conn.type})`)
    for (const [key, val] of Object.entries(conn.config)) {
      if (key === "password" || key === "private_key_passphrase" || key === "access_token") {
        lines.push(`  ${key}: ****`)
      } else {
        lines.push(`  ${key}: ${val}`)
      }
    }
    lines.push("")
  }
  return lines.join("\n")
}
