import { Schema } from "effect"
import { createInterface } from "node:readline"

// A real stdio process with a deliberately delayed catalog, requiring no listener/network.
const Request = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.String,
  params: Schema.optional(
    Schema.Struct({
      protocolVersion: Schema.optional(Schema.String),
      name: Schema.optional(Schema.String),
      arguments: Schema.optional(Schema.Struct({ value: Schema.String })),
    }),
  ),
})
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Request))

for await (const line of createInterface({ input: process.stdin })) {
  const request = decode(line)
  if (request.id === undefined) continue
  const result = await respond(request)
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`)
}

async function respond(request: typeof Request.Type) {
  if (request.method === "initialize") {
    return {
      protocolVersion: request.params?.protocolVersion ?? "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "altimate-workspace-spike", version: "1.0.0" },
    }
  }
  if (request.method === "tools/list") {
    await Bun.sleep(Number(process.env.ALTIMATE_MCP_CATALOG_DELAY_MS ?? 150))
    return {
      tools: [
        {
          name: "probe",
          description: "Echo a value from the workspace MCP stdio process.",
          inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
          outputSchema: { type: "object", properties: { echoed: { type: "string" } }, required: ["echoed"] },
        },
      ],
    }
  }
  if (request.method === "tools/call" && request.params?.name === "probe") {
    const output = { echoed: request.params.arguments?.value }
    return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output }
  }
  return {}
}
