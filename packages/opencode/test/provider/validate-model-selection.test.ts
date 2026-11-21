// altimate_change - new file
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Provider, validateModelSelection } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { modelSelectionErrorText } from "../../src/altimate/provider/model-hint"

const mocks: { mockRestore(): void }[] = []
afterEach(() => mocks.splice(0).forEach((mock) => mock.mockRestore()))

const selection = (providerID: string, modelID: string) => ({
  providerID: ProviderID.make(providerID),
  modelID: ModelID.make(modelID),
})

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a rejection")
    },
    (error: unknown) => error,
  )

describe("validateModelSelection with an empty model id", () => {
  test("a missing provider keeps its connect guidance and the selection source", async () => {
    mocks.push(
      spyOn(Provider, "getModel").mockImplementation((async (providerID: string, modelID: string) => {
        throw new Provider.ModelNotFoundError({
          providerID: ProviderID.make(providerID),
          modelID: ModelID.make(modelID),
          suggestions: [],
          providerMissing: true,
        })
      }) as never),
    )
    const error = await rejection(validateModelSelection(selection("anthropic", ""), "config (model)"))
    expect(Provider.ModelNotFoundError.isInstance(error)).toBe(true)
    if (!Provider.ModelNotFoundError.isInstance(error)) return
    expect(error.data.providerMissing).toBe(true)
    expect(error.data.source).toBe("config (model)")
    const text = modelSelectionErrorText(error.data)
    expect(text).toContain('Empty model name in "anthropic/"')
    expect(text).toContain("/connect")
  })

  test("an empty model id is rejected even if the provider lists an empty-named model", async () => {
    mocks.push(spyOn(Provider, "getModel").mockResolvedValue({} as never))
    const error = await rejection(validateModelSelection(selection("test", ""), "CLI --model"))
    expect(Provider.ModelNotFoundError.isInstance(error)).toBe(true)
    if (Provider.ModelNotFoundError.isInstance(error)) expect(error.data.source).toBe("CLI --model")
  })
})
