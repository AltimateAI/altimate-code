// altimate_change - new file
import { afterEach, expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { Provider } from "@/provider/provider"
import { ProviderID } from "@/provider/schema"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Provider.defaultLayer)

afterEach(async () => {
  await disposeAllInstances()
})

it.instance(
  "defaultModel rejects a configured model even when another provider is available",
  () =>
    Effect.gen(function* () {
      const providers = yield* Provider.use.list()
      expect(providers[ProviderID.make("anthropic")]).toBeDefined()
      const exit = yield* Provider.use.defaultModel().pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          name: "ProviderModelNotFoundError",
          data: { providerID: "missing-provider", modelID: "missing-model", source: "project or global config (model)" },
        })
      }
    }),
  {
    config: {
      model: "missing-provider/missing-model",
      provider: { anthropic: { options: { apiKey: "test-api-key" } } },
    },
  },
)
