// A real MCP server over stdio offering exactly one tool, "echo" (test fixture).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
const server = new McpServer({ name: "e2e-echo", version: "0.0.1" })
server.tool("echo", "Echoes its input", { text: z.string() }, async ({ text }) => ({
  content: [{ type: "text", text }],
}))
await server.connect(new StdioServerTransport())
