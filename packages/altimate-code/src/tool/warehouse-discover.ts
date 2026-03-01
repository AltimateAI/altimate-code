import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"

export const WarehouseDiscoverTool = Tool.define("warehouse_discover", {
  description:
    "Discover database containers running in Docker. Detects PostgreSQL, MySQL/MariaDB, and SQL Server containers and extracts connection details from port mappings and environment variables.",
  parameters: z.object({}),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("warehouse.discover", {})

      if (result.error) {
        return {
          title: "Discover: ERROR",
          metadata: { count: 0 },
          output: `Docker discovery failed: ${result.error}`,
        }
      }

      if (result.container_count === 0) {
        return {
          title: "Discover: no containers found",
          metadata: { count: 0 },
          output: "No supported database containers found running in Docker.\n\nSupported types: PostgreSQL, MySQL/MariaDB, SQL Server.\nEnsure Docker is running and containers have published ports.",
        }
      }

      const lines: string[] = [
        "Container | Type | Host:Port | User | Database | Status",
        "----------|------|-----------|------|----------|-------",
      ]
      for (const c of result.containers) {
        lines.push(
          `${c.name} | ${c.db_type} | ${c.host}:${c.port} | ${c.user ?? "-"} | ${c.database ?? "-"} | ${c.status}`,
        )
      }
      lines.push("")
      lines.push("Use warehouse_add to save any of these as a connection.")

      return {
        title: `Discover: ${result.container_count} container(s) found`,
        metadata: { count: result.container_count },
        output: lines.join("\n"),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Discover: ERROR",
        metadata: { count: 0 },
        output: `Failed to discover containers: ${msg}\n\nEnsure Docker is running and the docker Python package is installed.`,
      }
    }
  },
})
