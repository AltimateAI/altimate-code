import { describe, expect, test } from "bun:test"
import { providerListOrThrow } from "../../../src/cli/cmd/run/provider-list"

const MODEL = "test/test-model"

function failure(result: Parameters<typeof providerListOrThrow>[0]): string {
  try {
    providerListOrThrow(result, MODEL)
  } catch (error) {
    return (error as Error).message
  }
  throw new Error("expected providerListOrThrow to throw")
}

describe("run --model provider list check", () => {
  test("returns the providers from a successful list", () => {
    const all = [{ id: "test" }]
    expect(providerListOrThrow({ data: { all }, response: new Response(null, { status: 200 }) }, MODEL)).toBe(all)
  })

  test("an empty list is still a list, so an unknown model stays a model error", () => {
    expect(providerListOrThrow({ data: { all: [] }, response: new Response(null, { status: 200 }) }, MODEL)).toEqual([])
  })

  // Each failed call names the model and says what failed, never "Model not found".
  const cases: Array<[string, Parameters<typeof providerListOrThrow>[0], string]> = [
    [
      "a server error with a JSON body",
      { error: { name: "UnknownError", message: "boom" }, response: new Response(null, { status: 500 }) },
      'HTTP 500: {"name":"UnknownError","message":"boom"}',
    ],
    ["a request that never got a response", { error: new Error("socket closed") }, "no response: socket closed"],
    ["a request that failed without any detail", { error: {} }, "no response"],
    [
      "a 200 whose body is not the provider list",
      { data: "<html></html>" as never, response: new Response(null, { status: 200 }) },
      "HTTP 200: unexpected response body",
    ],
    ["a non-2xx with an empty body", { error: "", response: new Response(null, { status: 503 }) }, "HTTP 503"],
  ]
  for (const [name, result, detail] of cases) {
    test(name, () => {
      const message = failure(result)
      expect(message).toBe(`Could not load the provider list to check --model ${MODEL} (${detail})`)
      expect(message).not.toContain("Model not found")
    })
  }
})
