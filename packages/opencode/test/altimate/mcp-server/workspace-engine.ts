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
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "snowflake_execute_database_query",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
    { name: "ask_knowledge_base", inputSchema: { type: "object", properties: { question: { type: "string" } } } },
    { name: "datamate_add_memories", inputSchema: { type: "object", properties: {} } },
    // This SQL contract is intentionally unsupported; a decoy query must not bypass validation.
    { name: "databricks_execute_sql", inputSchema: { type: "object", properties: { statement: { type: "string" } } } },
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
