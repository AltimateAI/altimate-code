import { Plugin } from "@opencode/plugin"
import type { Mcp } from "@opencode/schema/mcp"

/** The workspace resolver supplies the server configuration and its required tool IDs. */
export function workspaceMcp(options: {
  name: string
  config: Mcp.ServerConfig
  tools: readonly string[]
  timeoutMs?: number
}) {
  return Plugin.define({
    id: `altimate.workspace-mcp.${options.name}`,
    async setup(ctx) {
      let registered = false
      await ctx.session.hook("prompt", async () => {
        const timeoutMs = options.timeoutMs ?? 10_000
        const deadline = performance.now() + timeoutMs
        const error = new Error(
          `Workspace MCP "${options.name}" tools were not ready before the deadline: ${options.tools.join(", ")}`,
        )
        const timeout = Promise.withResolvers<never>()
        const timer = setTimeout(() => timeout.reject(error), timeoutMs)
        // Transform/reload can await MCP startup. Bound admission as well as polling;
        // the public Promise API cannot cancel the underlying core reconciliation.
        await Promise.race([
          timeout.promise,
          (async () => {
            if (!registered) {
              await ctx.mcp.transform((editor) => editor.set(options.name, options.config))
              registered = true
            }
            if (performance.now() >= deadline) throw error
            await ctx.mcp.reload()
            // Connected MCP status precedes the debounced tool-registry update.
            while (performance.now() < deadline) {
              const tools = await ctx.tool.list()
              if (options.tools.every((name) => tools.some((tool) => tool.id === name))) return
              await Bun.sleep(10)
            }
            throw error
          })(),
        ]).finally(() => clearTimeout(timer))
      })
    },
  })
}
