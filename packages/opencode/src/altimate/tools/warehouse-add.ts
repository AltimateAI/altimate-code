import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
// altimate_change start — post-connect feature suggestions
import { PostConnectSuggestions } from "./post-connect-suggestions"
import { Telemetry } from "../../telemetry"
// altimate_change end
// altimate_change start — report driver readiness when adding a warehouse
import { shellQuote } from "@altimateai/drivers/resolve"
import {
  driverForWarehouseType,
  driverInstallDir,
  driverLabel,
  isDriverInstalled,
  DRIVER_PACKAGES,
} from "./warehouse-install-driver"
// altimate_change end

export const WarehouseAddTool = Tool.define("warehouse_add", {
  description:
    "Add a new warehouse connection. Stores credentials securely in OS keyring when available, metadata in connections.json.",
  parameters: z.object({
    name: z.string().describe("Name for the warehouse connection"),
    config: z.record(z.string(), z.unknown()).describe(
      `Connection configuration. Must include "type". Field aliases (camelCase, dbt names) are auto-normalized. Canonical fields per type:
- postgres: host, port, database, user, password, ssl, connection_string, statement_timeout
- snowflake: account, user, password, database, schema, warehouse, role, private_key_path, private_key_passphrase, private_key (inline PEM), authenticator (oauth/externalbrowser/okta URL), token
- bigquery: project, credentials_path (service account JSON file), credentials_json (inline JSON), location, dataset
- databricks: server_hostname, http_path, access_token, catalog, schema
- redshift: host, port, database, user, password, ssl, connection_string
- mysql: host, port, database, user, password, ssl (or ssl_ca, ssl_cert, ssl_key)
- sqlserver: host, port, database, user, password, encrypt, trust_server_certificate
- oracle: connection_string (or host, port, service_name), user, password
- duckdb: path (file path or ":memory:"), create (optional, default false)
- sqlite: path (file path), create (optional, default false)
- clickhouse: host, port, database, user, password, protocol (http/https), connection_string, request_timeout, tls_ca_cert, tls_cert, tls_key, clickhouse_settings
- trino: host, port, catalog, schema, user, password, protocol (http/https), connection_string, access_token, extra_headers
File-backed stores (duckdb, sqlite): the store must already exist — connecting never creates it, because an empty database answers every query with no rows. Pass "create": true only when the store is meant to be created. A relative "path" is resolved once, at add-time, against the project root (not the current working directory) and persisted absolute — even though this tool always writes to the global config file, "add" resolves against the project you're in right now, not against ~/.altimate-code; prefer an absolute path to avoid relying on that.
Snowflake auth examples: (1) Password: {"type":"snowflake","account":"xy12345","user":"admin","password":"secret","warehouse":"WH","database":"db"}. (2) Key-pair: {"type":"snowflake","account":"xy12345","user":"admin","private_key_path":"/path/rsa_key.p8","warehouse":"WH","database":"db"}. (3) OAuth: {"type":"snowflake","account":"xy12345","authenticator":"oauth","token":"<token>","warehouse":"WH","database":"db"}. (4) SSO: {"type":"snowflake","account":"xy12345","user":"admin","authenticator":"externalbrowser","warehouse":"WH","database":"db"}.
IMPORTANT: For private key file paths, always use "private_key_path" (not "private_key").`,
    ),
  }),
  async execute(args, ctx) {
    if (!args.config.type) {
      return {
        title: `Add '${args.name}': FAILED`,
        metadata: { success: false, name: args.name, type: "" },
        output: `Missing required field "type" in config. Specify the database type (postgres, snowflake, bigquery, databricks, redshift, clickhouse, trino, duckdb, mysql, sqlserver, oracle, sqlite, mongodb).`,
      }
    }

    try {
      const result = await Dispatcher.call("warehouse.add", {
        name: args.name,
        config: args.config,
      })

      if (result.success) {
        // altimate_change start — append post-connect feature suggestions (async, non-blocking)
        let output = `Successfully added warehouse '${result.name}' (type: ${result.type}).\n\nUse warehouse_test to verify connectivity.`

        // Adding a connection whose driver is missing used to leave a broken
        // entry behind: every later operation failed with "driver not
        // installed" and nothing said so at the point of adding. Say so here
        // instead, at the point where it can still be acted on.
        output += driverReadinessNote(result.type)

        // Run suggestion gathering concurrently with a timeout to avoid
        // adding noticeable latency to the warehouse add response.
        try {
          const SUGGESTION_TIMEOUT_MS = 1500
          const suggestionPromise = (async () => {
            const [schemaCache, warehouseList, dbtInfo] = await Promise.all([
              Dispatcher.call("schema.cache_status", {}).catch(() => null),
              Dispatcher.call("warehouse.list", {}).catch(() => ({ warehouses: [] })),
              import("./project-scan").then((m) => m.detectDbtProject(process.cwd())).catch(() => ({ found: false })),
            ])
            const schemaIndexed = (schemaCache?.total_tables ?? 0) > 0
            const dbtDetected = dbtInfo.found

            const suggestionCtx: PostConnectSuggestions.SuggestionContext = {
              warehouseType: result.type,
              schemaIndexed,
              dbtDetected,
              connectionCount: warehouseList.warehouses.length,
              toolsUsedInSession: [],
            }
            return { suggestionCtx, schemaIndexed, dbtDetected }
          })()

          const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), SUGGESTION_TIMEOUT_MS))
          const suggestionResult = await Promise.race([suggestionPromise, timeoutPromise])

          if (suggestionResult) {
            const { suggestionCtx } = suggestionResult
            output += PostConnectSuggestions.getPostConnectSuggestions(suggestionCtx)

            // Derive suggestions list from the same context to avoid drift
            const suggestionsShown = ["sql_execute", "sql_analyze", "lineage_check", "schema_detect_pii"]
            if (!suggestionCtx.schemaIndexed) suggestionsShown.unshift("schema_index")
            if (suggestionCtx.dbtDetected) suggestionsShown.push("dbt-develop", "dbt-troubleshoot")
            if (suggestionCtx.connectionCount > 1) suggestionsShown.push("data_diff")
            PostConnectSuggestions.trackSuggestions({
              suggestionType: "post_warehouse_connect",
              suggestionsShown,
              warehouseType: result.type,
            })
          }
        } catch (e) {
          // Suggestions must never break the add flow — but track the failure
          try {
            Telemetry.track({
              type: "core_failure",
              timestamp: Date.now(),
              session_id: Telemetry.getContext().sessionId || "unknown-session",
              tool_name: "warehouse_add",
              tool_category: "warehouse",
              error_class: "internal",
              error_message: Telemetry.maskString(e instanceof Error ? e.message : String(e)),
              input_signature: "post_connect_suggestions",
              duration_ms: 0,
            })
          } catch {
            // Telemetry itself failed — truly nothing we can do
          }
        }
        // altimate_change end

        return {
          title: `Add '${args.name}': OK`,
          metadata: { success: true, name: result.name, type: result.type },
          output,
        }
      }

      return {
        title: `Add '${args.name}': FAILED`,
        metadata: { success: false, name: args.name, type: "" },
        output: `Failed to add warehouse '${args.name}'.\nError: ${result.error ?? "Unknown error"}`,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: `Add '${args.name}': ERROR`,
        metadata: { success: false, name: args.name, type: "" },
        output: `Failed to add warehouse: ${msg}`,
      }
    }
  },
})

// altimate_change start — driver readiness note for newly added warehouses
/**
 * Note appended to a successful add when the warehouse's driver is missing.
 *
 * Deliberately a filesystem check and not an install: adding a connection must
 * not block on a network `npm install`, which can take minutes. The install
 * itself is the warehouse_install_driver tool, which this points at.
 */
function driverReadinessNote(type: string): string {
  const driver = driverForWarehouseType(type)
  // sqlite and any unrecognised type need no optional SDK.
  if (!driver) return ""

  try {
    if (isDriverInstalled(driver)) return ""
    const packages = DRIVER_PACKAGES[driver].join(" ")
    return (
      `\n\nNOTE: the ${driverLabel(driver)} driver is not installed yet, so this connection cannot be used until it is.\n` +
      `Run the warehouse_install_driver tool with driver="${driver}", or install it manually:\n` +
      `  npm install --prefix ${shellQuote(driverInstallDir())} ${packages}`
    )
  } catch {
    // A driver probe must never fail an add whose configuration was stored.
    return ""
  }
}
// altimate_change end
