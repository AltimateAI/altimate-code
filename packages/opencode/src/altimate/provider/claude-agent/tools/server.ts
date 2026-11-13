export * as ToolServer from "./server"

import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider"
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk"
import type { Tool } from "@modelcontextprotocol/sdk/types.js"
import { ToolNames } from "./names"
import type { PendingTools } from "./pending"

// Upstream builds this on `@modelcontextprotocol/server` 2.x. The shipped CLI already bundles
// `@modelcontextprotocol/sdk` 1.x, which the Claude Agent SDK also peers on, so the same low-level
// server is built from that package instead of adding a second MCP SDK.
export async function make(
  tools: readonly LanguageModelV3FunctionTool[],
  pending: PendingTools.Interface,
): Promise<McpSdkServerConfigWithInstance> {
  // Loaded on first use, so the CLI starts without loading the MCP server.
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js")
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js")
  const server = new Server({ name: "opencode", version: "1.0.0" }, { capabilities: { tools: {} } })
  const definitions = tools.map(
    (tool): Tool => ({
      name: ToolNames.short(tool.name),
      description: ToolNames.description(tool),
      inputSchema: tool.inputSchema as Tool["inputSchema"],
      // Claude serializes non-read-only tools, so each handler takes the ID from the preceding hook.
      annotations: { readOnlyHint: false },
      _meta: { "anthropic/alwaysLoad": true, "anthropic/maxResultSizeChars": 500_000 },
    }),
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = ToolNames.PREFIX + request.params.name
    if (!ToolNames.original(name, tools)) throw new Error(`Claude Code called an unregistered tool: ${name}`)
    return pending.call(name)
  })
  // The SDK's public instance type names the higher-level McpServer; the low-level Server is what it drives.
  return { type: "sdk", name: "opencode", instance: server as unknown as McpSdkServerConfigWithInstance["instance"] }
}
