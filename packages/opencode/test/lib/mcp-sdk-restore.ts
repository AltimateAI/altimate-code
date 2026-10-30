import { mock } from "bun:test"

const MODULES = [
  ...["stdio", "streamableHttp", "sse", "auth", "index"].map((name) => `@modelcontextprotocol/sdk/client/${name}.js`),
  "@modelcontextprotocol/sdk/types.js",
]

/** Captures the real MCP SDK client and type modules; the returned function reinstates them after a file mocks them. */
export async function snapshotMcpClientModules(): Promise<() => void> {
  const real = await Promise.all(MODULES.map(async (id) => ({ id, exports: { ...(await import(id)) } })))
  return () => {
    for (const item of real) mock.module(item.id, () => item.exports)
  }
}
