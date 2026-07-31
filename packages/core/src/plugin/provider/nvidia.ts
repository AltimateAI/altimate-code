import { Effect } from "effect"
import { define } from "../internal"

export const NvidiaPlugin = define({
  id: "nvidia",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform(
      Effect.fn(function* (evt) {
        for (const item of evt.provider.list()) {
          if (item.provider.api.type !== "aisdk") continue
          if (item.provider.api.package !== "@ai-sdk/openai-compatible") continue
          if (item.provider.api.url !== "https://integrate.api.nvidia.com/v1") continue
          evt.provider.update(item.provider.id, (provider) => {
            // altimate_change start — provider identity headers
            provider.request.headers["HTTP-Referer"] = "https://altimate.ai/"
            provider.request.headers["X-Title"] = "altimate-code"
            provider.request.headers["X-BILLING-INVOKE-ORIGIN"] ??= "AltimateAI"
            // altimate_change end
          })
        }
      }),
    )
  }),
})
