#!/usr/bin/env bun
// Local protocol fixture, not an Altimate workspace/backend substitute.
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { MIN_ENGINE_VERSION } from "../../../src/altimate/workspace/engine-types"
if (process.argv.includes("--version")) {
  console.log(MIN_ENGINE_VERSION)
  process.exit(0)
}
const server = new Server({ name: "workspace-protocol-fixture", version: "1" }, { capabilities: { tools: {} } })
// Force backpressure unless the client drains stderr before the handshake.
await new Promise<void>((resolve, reject) => {
  process.stderr.write("diagnostic fixture\n".repeat(65536), (error) => (error ? reject(error) : resolve()))
})
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "snowflake_execute_database_query",
      // Schema fields from @altimateai/datamate 0.7.1's SnowflakeTools.getTools.
      inputSchema: {
        type: "object",
        properties: { connection_id: { type: "string" }, sql_query: { type: "string" } },
        required: ["connection_id", "sql_query"],
      },
    },
    { name: "ask_knowledge_base", inputSchema: { type: "object", properties: { question: { type: "string" } } } },
    { name: "snowflake_list_database_connections", inputSchema: { type: "object", properties: {} } },
    { name: "datamate_add_memories", inputSchema: { type: "object", properties: {} } },
    // Also from datamate 0.7.1: file-based SQL is intentionally withheld.
    {
      name: "snowflake_get_query_explain_plan",
      inputSchema: {
        type: "object",
        properties: { sql_file_path: { type: "string" }, connection_id: { type: "string" } },
      },
    },
    {
      name: "databricks_execute_sql",
      inputSchema: {
        type: "object",
        properties: { warehouse_id: { type: "string" }, statement: { type: "string" } },
        required: ["warehouse_id", "statement"],
      },
    },
  ],
}))
server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({
        workspace: process.argv[process.argv.indexOf("--datamate") + 1],
        name: request.params.name,
        arguments: request.params.arguments,
      }),
    },
  ],
}))
await server.connect(new StdioServerTransport())
