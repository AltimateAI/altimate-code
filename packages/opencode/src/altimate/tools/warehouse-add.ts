import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
// altimate_change start — post-connect feature suggestions
import { PostConnectSuggestions } from "./post-connect-suggestions"
import { Telemetry } from "../../telemetry"
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
- duckdb: path (file path or ":memory:")
- sqlite: path (file path)
- clickhouse: host, port, database, user, password, protocol (http/https), connection_string, request_timeout, tls_ca_cert, tls_cert, tls_key, clickhouse_settings
- trino: host, port, catalog, schema, user, password, protocol (http/https), connection_string, access_token, extra_headers
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
