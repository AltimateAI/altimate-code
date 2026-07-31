import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer } from "effect"
import open from "open"

export interface Interface {
  readonly open: (url: string) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/McpBrowser") {}

const layer = Layer.succeed(
  Service,
  Service.of({
    open: Effect.fn("McpBrowser.open")(function* (url: string) {
      const subprocess = yield* Effect.tryPromise({
        try: () => open(url),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      })
      yield* Effect.callback<void, Error>((resume) => {
        const timer = setTimeout(() => resume(Effect.void), 500)
        subprocess.on("error", (error) => {
          clearTimeout(timer)
          resume(Effect.fail(error))
        })
        subprocess.on("exit", (code) => {
          if (code === null || code === 0) return
          clearTimeout(timer)
          resume(Effect.fail(new Error(`Browser open failed with exit code ${code}`)))
        })
      })
    }),
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [] })

// altimate_change start — upstream_fix: restore defaultLayer for the fork's Promise-facade
// consumer (mcp/index.ts). Removed upstream in the makeGlobalNode migration.
export const defaultLayer = layer
// altimate_change end

export * as McpBrowser from "./browser"
