import z from "zod"
import { readOnlyCaveat } from "../native/connections/read-only"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
// altimate_change start — workspace precedence
import * as Precedence from "../workspace/precedence"
// altimate_change end
import { discoverCatalog } from "./warehouse-discovery"

// altimate_change start — point at the locations the registry actually reads
import { CONN_ENV_PREFIX, globalConfigPath, localConfigPath } from "../native/connections/registry"

/** The no-connections hint. Paths come from the registry's own helpers so it cannot drift from what is loaded. */
export function noConnectionsMessage(): string {
  return [
    "No warehouse connections configured.",
    "",
    `Preferred: use the warehouse_add tool. It stores passwords and keys in the OS credential store when one is available; otherwise it keeps them out of the file for this session only, so use ${CONN_ENV_PREFIX}<NAME> to make them persistent.`,
    "",
    "Alternatively, connections are read from these sources (later ones override earlier ones):",
    `  1. ${globalConfigPath()} (global)`,
    `  2. ${localConfigPath()} (this project)`,
    `  3. ${CONN_ENV_PREFIX}<NAME> environment variables, each holding one connection's config as JSON (set them in the shell before starting altimate-code; a running process cannot see variables exported later)`,
    "",
    "After adding the first connection file, call warehouse_list again. Edits to an existing connections.json take effect after a restart. Example connections.json:",
    "{",
    '  "my-db": { "type": "postgres", "host": "localhost", "port": 5432, "database": "mydb", "user": "user", "password": "pass" }',
    "}",
    `To keep the password out of the file, omit it and set ${CONN_ENV_PREFIX}<NAME> to the full config as JSON instead.`,
    "",
    "Do not put connections.json in .opencode/; it is not read from there.",
  ].join("\n")
}
// altimate_change end

// altimate_change start — MCP: connection candidates from the existing project-scan detection (names and types only,
// never values); every probe is local and fail-safe.
const MAX_CANDIDATES = 10
async function discoveredCandidates(): Promise<string> {
  const scan = await import("./project-scan")
  const [env, dbt] = await Promise.all([
    scan.detectEnvVars().catch(() => []),
    scan
      .detectDbtProject(process.cwd())
      .then((project) => Dispatcher.call("dbt.profiles", { projectDir: project.found ? project.path : undefined }))
      .then((result) => result.connections ?? [])
      .catch(() => []),
  ])
  const lines = [
    ...env.map((c) => `- ${c.type} from environment variable ${c.signal}`),
    ...dbt.map((c) => `- ${c.type} from dbt profile ${c.name}`),
  ].slice(0, MAX_CANDIDATES)
  if (!lines.length) return ""
  return ["", "", "Detected but not configured (read the values from their source, then call warehouse_add):", ...lines].join("\n")
}
// altimate_change end

export const WarehouseListTool = Tool.define("warehouse_list", {
  description: "List all configured warehouse connections. Shows connection name, type, and database, with local catalog details and samples when available; row counts are catalog estimates only.",
  parameters: z.object({}),
  async execute(args, ctx) {
    try {
      const result = await Dispatcher.call("warehouse.list", {})

      const warehouses = result.warehouses ?? []
      if (warehouses.length === 0) {
        // altimate_change start — MCP: name connections the existing env-var and dbt-profile detection can see
        const candidates = ctx.extra?.mcpClient === true ? await discoveredCandidates() : ""
        // altimate_change end
        return {
          title: "Warehouses: none configured",
          metadata: { count: 0 },
          output: noConnectionsMessage() + candidates,
        }
      }

      // altimate_change start — workspace precedence.
      // Annotated here, in this tool's own markdown, rather than on WarehouseInfo:
      // that struct is shared by every consumer of `warehouse.list`, and a field
      // added there would surface far beyond this listing. The notes re-validate the
      // snapshot against the current binding the way the query tools do, so a
      // re-linked project is not told its rows are served by the old workspace.
      const notes = await Precedence.warehouseListNotes(ctx.sessionID, warehouses)
      const shadowedCount = notes.size
      // altimate_change start — MCP: compact table and one-call catalog discovery
      const mcp = ctx.extra?.mcpClient === true

      const lines: string[] = shadowedCount
        ? ["Name | Type | Database | Served by", "-----|------|----------|----------"]
        : ["Name | Type | Database", "-----|------|--------"]
      // The rule line only decorates the header.
      if (mcp) lines.pop()
      for (const wh of warehouses) {
        const row = `${wh.name} | ${wh.type} | ${wh.database ?? "-"}`
        lines.push(shadowedCount ? `${row} | ${notes.get(wh.name) ?? "local"}` : row)
      }

      if (ctx.extra?.forceReadOnly) {
        const caveats = warehouses.map(readOnlyCaveat).filter((note): note is string => !!note)
        if (caveats.length) lines.push("", ...caveats)
      }

      // Workspace-routed connections are served elsewhere; their local catalog is not the one queried.
      if (mcp && !shadowedCount) {
        const catalog = await discoverCatalog(warehouses, { signal: ctx.abort, sessionID: ctx.sessionID })
        if (catalog) lines.push("", "Tables (name: columns; e.g. = one sample row):", catalog)
      }
      // altimate_change end

      return {
        title: `Warehouses: ${warehouses.length} configured`,
        metadata: { count: warehouses.length, shadowed: shadowedCount },
        output: lines.join("\n"),
      }
      // altimate_change end
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Warehouses: ERROR",
        metadata: { count: 0, error: msg },
        output: `Failed to list warehouses: ${msg}\n\nCheck your connection configuration and try again.`,
      }
    }
  },
})
