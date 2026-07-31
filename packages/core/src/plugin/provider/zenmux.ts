import { Effect } from "effect"
import { define } from "../internal"

export const ZenmuxPlugin = define({
  id: "zenmux",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform(
      Effect.fn(function* (evt) {
        for (const item of evt.provider.list()) {
          if (item.provider.api.type !== "aisdk") continue
          if (item.provider.api.package !== "@ai-sdk/openai-compatible") continue
          if (item.provider.api.url !== "https://zenmux.ai/api/v1") continue
          evt.provider.update(item.provider.id, (provider) => {
            // altimate_change start — provider identity headers
            provider.request.headers["HTTP-Referer"] ??= "https://altimate.ai/"
            // X-Title stays upstream: ZenMux keys allowlisted callers on this exact legacy value.
            provider.request.headers["X-Title"] ??= "opencode"
            // altimate_change end
          })
        }
      }),
    )
  }),
})
