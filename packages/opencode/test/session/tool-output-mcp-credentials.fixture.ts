// altimate_change — exercise the real MCP SDK with synthetic credentials.
import { expect, test } from "bun:test"
import { toolCredentialRedactor } from "@/altimate/tool-output-credentials"
import { MCP } from "@/mcp"
import { Instance } from "@/project/instance"
import { provideTestInstance, tmpdir } from "../fixture/fixture"

test("collects configured and command-resolved MCP authorization without changing ordinary headers", async () => {
  const configuredToken = "fixture-configured-token"
  const resolvedToken = "fixture-command-resolved-token"
  const traceHeader = "fixture-not-a-credential"
  const serverName = "fixture-output-redaction"
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 405 })
      const message = (await request.json()) as {
        id?: number
        method: string
        params?: { protocolVersion: string }
      }
      if (message.id === undefined) return new Response(null, { status: 202 })
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion,
          capabilities: {},
          serverInfo: { name: serverName, version: "1" },
        },
      })
    },
  })
  await using tmp = await tmpdir({
    config: {
      mcp: {
        configured: {
          type: "remote",
          enabled: false,
          url: String(server.url),
          headers: { Authorization: "Bearer " + configuredToken, "X-Trace-Id": traceHeader },
        },
      },
    },
  })
  await provideTestInstance({
    directory: tmp.path,
    fn: (instance) =>
      Instance.restore(instance, async () => {
        await MCP.add(serverName, {
          type: "remote",
          url: String(server.url),
          timeout: 1_000,
          headersCommand: {
            Authorization: [
              process.execPath,
              "-e",
              `process.stdout.write("Bearer " + ${JSON.stringify(resolvedToken)})`,
            ],
          },
        })
        try {
          expect((await MCP.status())[serverName]?.status).toBe("connected")
          const redact = await toolCredentialRedactor()
          for (const value of [configuredToken, resolvedToken, "Bearer " + resolvedToken]) {
            expect(redact.text(value)).toBe("[REDACTED]")
          }
          expect(redact.text(traceHeader)).toBe(traceHeader)
        } finally {
          await MCP.remove(serverName)
        }
        expect((await toolCredentialRedactor()).text(resolvedToken)).toBe(resolvedToken)
      }),
  })
}, 25_000)
