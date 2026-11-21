/**
 * `prompt_async` skips its own error event only for model errors the prompt already reported with guidance.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { ModelMetadata } from "../../src/altimate/session/model-metadata"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { tmpdir } from "../fixture/fixture"

describe("prompt_async model errors", () => {
  let restore: (() => void) | undefined
  afterEach(() => restore?.())

  async function errorsFor(error: unknown) {
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async () => {
      throw error
    }) as unknown as typeof SessionPrompt.prompt)
    restore = () => prompt.mockRestore()
    const published: unknown[] = []
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "async model error" })
        // Subscribe once the instance is initialized; Bus.subscribe runs synchronously.
        const unsubscribe = Bus.subscribe(Session.Event.Error, (event) => {
          published.push(event.properties.error)
        })
        const response = await Server.Default().request(`/session/${session.id}/prompt_async`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencode-directory": tmp.path },
          body: JSON.stringify({ parts: [{ type: "text", text: "hello" }] }),
        })
        await response.text()
        await new Promise((resolve) => setTimeout(resolve, 100))
        unsubscribe()
      },
    })
    return published
  }

  const notFound = () =>
    new Provider.ModelNotFoundError({ providerID: ProviderID.make("missing"), modelID: ModelID.make("model") })

  test("an unreported model error is still published", async () => {
    expect(await errorsFor(notFound())).toHaveLength(1)
  })

  test("a model error the prompt already reported is not published twice", async () => {
    const error = notFound()
    ModelMetadata.markReported(error)
    expect(await errorsFor(error)).toHaveLength(0)
  })
})
