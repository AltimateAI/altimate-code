import { Effect } from "effect"
import { PluginV2 } from "../../plugin"

export const KiloPlugin = PluginV2.define({
  id: PluginV2.ID.make("kilo"),
  effect: Effect.gen(function* () {
    return {
      "catalog.transform": Effect.fn(function* (evt) {
        for (const item of evt.provider.list()) {
          if (item.provider.api.type !== "aisdk") continue
          if (item.provider.api.package !== "@ai-sdk/openai-compatible") continue
          if (item.provider.api.url !== "https://api.kilo.ai/api/gateway") continue
          evt.provider.update(item.provider.id, (provider) => {
            // altimate_change start — provider identity headers
            provider.request.headers["HTTP-Referer"] = "https://altimate.ai/"
            provider.request.headers["X-Title"] = "altimate-code"
            // altimate_change end
          })
        }
      }),
    }
  }),
})
