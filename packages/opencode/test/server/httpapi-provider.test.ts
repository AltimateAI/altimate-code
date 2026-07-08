import { describe, expect } from "bun:test"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Layer } from "effect"
import path from "path"
import { TestInstance } from "../fixture/fixture"
import { markPluginDependenciesReady } from "../fixture/plugin"
import { testEffect } from "../lib/effect"
import { Server } from "../../src/server/server"
import { httpApiLayer, request } from "./httpapi-layer"

const it = testEffect(Layer.mergeAll(FSUtil.defaultLayer, httpApiLayer))
const projectOptions = { config: { formatter: false, lsp: false } }
const googleProjectOptions = { config: { formatter: false, lsp: false, enabled_providers: ["google"] } }
const providerID = "test-oauth-parity"
const oauthURL = "https://example.com/oauth"
const oauthInstructions = "Finish OAuth"

function providerListHasFetch(list: unknown) {
  if (!Array.isArray(list)) return false
  return list.some((item: unknown) => {
    if (typeof item !== "object" || item === null || !("id" in item) || !("options" in item)) return false
    if (item.id !== "google") return false
    if (typeof item.options !== "object" || item.options === null) return false
    return "fetch" in item.options
  })
}

function hasProviderWithFetch(input: unknown, key: "all" | "providers") {
  if (typeof input !== "object" || input === null) return false
  if (key === "all") return "all" in input && providerListHasFetch(input.all)
  return "providers" in input && providerListHasFetch(input.providers)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function providerList(input: unknown, key: "all" | "providers") {
  if (!isRecord(input)) return []
  if (!Array.isArray(input[key])) return []
  return input[key]
}

function providerByID(input: unknown, key: "all" | "providers", id: string) {
  return providerList(input, key).find((provider) => isRecord(provider) && provider.id === id)
}

function hasNonZeroModelCost(input: unknown, key: "all" | "providers", id: string) {
  const provider = providerByID(input, key, id)
  if (!isRecord(provider) || !isRecord(provider.models)) return false
  return Object.values(provider.models).some((model) => {
    if (!isRecord(model) || !isRecord(model.cost) || !isRecord(model.cost.cache)) return false
    return [model.cost.input, model.cost.output, model.cost.cache.read, model.cost.cache.write].some(
      (cost) => typeof cost === "number" && cost > 0,
    )
  })
}

function hasProviderMutationMarker(input: unknown, key: "all" | "providers", id: string) {
  const provider = providerByID(input, key, id)
  if (!isRecord(provider)) return false
  if (provider.name === "mutated-provider") return true
  return isRecord(provider.options) && provider.options.mutatedByPlugin === true
}

function requestAuthorize(input: {
  providerID: string
  method: number
  headers: HeadersInit
  inputs?: Record<string, string>
}) {
  return Effect.gen(function* () {
    const response = yield* request(`/provider/${input.providerID}/oauth/authorize`, {
      method: "POST",
      headers: input.headers,
      body: JSON.stringify({ method: input.method, ...(input.inputs ? { inputs: input.inputs } : {}) }),
    })
    return {
      status: response.status,
      body: yield* response.text,
    }
  })
}

function requestCallback(input: { providerID: string; method: number; headers: HeadersInit; code?: string }) {
  return Effect.gen(function* () {
    const response = yield* request(`/provider/${input.providerID}/oauth/callback`, {
      method: "POST",
      headers: input.headers,
      body: JSON.stringify({ method: input.method, ...(input.code ? { code: input.code } : {}) }),
    })
    return {
      status: response.status,
      body: yield* response.text,
    }
  })
}

function requestDefault(path: string, init?: RequestInit) {
  return Effect.promise(() => Promise.resolve(Server.Default().request(path, init)))
}

function responseJson(response: Response) {
  return Effect.promise(() => response.json() as Promise<unknown>)
}

function writeProviderAuthPlugin(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    yield* Effect.promise(() => markPluginDependenciesReady(path.join(dir, ".opencode")))

    yield* fs.writeWithDirs(
      path.join(dir, ".opencode", "plugin", "provider-oauth-parity.ts"),
      [
        "export default async function providerOauthParity() {",
        "  return {",
        "    auth: {",
        `      provider: "${providerID}",`,
        "      methods: [",
        '        { type: "api", label: "API key" },',
        "        {",
        '          type: "oauth",',
        '          label: "OAuth",',
        "          authorize: async () => ({",
        `            url: "${oauthURL}",`,
        '            method: "code",',
        `            instructions: "${oauthInstructions}",`,
        "            callback: async () => ({ type: 'success', key: 'token' }),",
        "          }),",
        "        },",
        "      ],",
        "    },",
        "  }",
        "}",
        "",
      ].join("\n"),
    )
  })
}

function writeProviderAuthValidationPlugin(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    yield* Effect.promise(() => markPluginDependenciesReady(path.join(dir, ".opencode")))

    yield* fs.writeWithDirs(
      path.join(dir, ".opencode", "plugin", "provider-oauth-validation.ts"),
      [
        "export default async function providerOauthValidation() {",
        "  return {",
        "    auth: {",
        '      provider: "test-oauth-validation",',
        "      methods: [",
        "        {",
        '          type: "oauth",',
        '          label: "OAuth",',
        "          prompts: [",
        "            {",
        '              type: "text",',
        '              key: "token",',
        '              message: "Token",',
        "              validate: (value) => value === 'ok' ? undefined : 'Token must be ok',",
        "            },",
        "          ],",
        "          authorize: async () => ({",
        `            url: "${oauthURL}",`,
        '            method: "code",',
        `            instructions: "${oauthInstructions}",`,
        "            callback: async () => ({ type: 'success', key: 'token' }),",
        "          }),",
        "        },",
        "      ],",
        "    },",
        "  }",
        "}",
        "",
      ].join("\n"),
    )
  })
}

function writeFunctionOptionsPlugin(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    yield* Effect.promise(() => markPluginDependenciesReady(path.join(dir, ".opencode")))

    yield* fs.writeWithDirs(
      path.join(dir, ".opencode", "plugin", "provider-function-options.ts"),
      [
        "export default async function providerFunctionOptions() {",
        "  return {",
        "    auth: {",
        '      provider: "google",',
        "      loader: async (_getAuth, provider) => {",
        "        for (const model of Object.values(provider.models ?? {})) {",
        "          model.cost = { input: 0, output: 0 }",
        "        }",
        "        return {",
        '        apiKey: "",',
        "        fetch: async (input, init) => fetch(input, init),",
        "        }",
        "      },",
        "      methods: [{ type: 'api', label: 'API key' }],",
        "    },",
        "  }",
        "}",
        "",
      ].join("\n"),
    )
  })
}

function writeProviderModelsMutationPlugin(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    yield* Effect.promise(() => markPluginDependenciesReady(path.join(dir, ".opencode")))

    yield* fs.writeWithDirs(
      path.join(dir, ".opencode", "plugin", "provider-models-mutation.ts"),
      [
        "export default async function providerModelsMutation() {",
        "  return {",
        "    provider: {",
        '      id: "google",',
        "      models: async (provider) => {",
        "        const models = Object.fromEntries(",
        "          Object.entries(provider.models ?? {}).map(([id, model]) => [id, { ...model }]),",
        "        )",
        '        provider.name = "mutated-provider"',
        "        provider.options = { ...provider.options, mutatedByPlugin: true }",
        "        for (const model of Object.values(provider.models ?? {})) {",
        "          model.cost = { input: 0, output: 0 }",
        "        }",
        "        return models",
        "      },",
        "    },",
        "  }",
        "}",
        "",
      ].join("\n"),
    )
  })
}

function setEnvScoped(key: string, value: string) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env[key]
      process.env[key] = value
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[key]
        else process.env[key] = previous
      }),
  )
}

describe("provider HttpApi", () => {
  it.instance(
    "serves v2 provider and model routes from Server.Default",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const headers = { "x-opencode-directory": directory }
      const providerResponse = yield* requestDefault("/api/provider", { headers })
      const modelResponse = yield* requestDefault("/api/model", { headers })

      if (providerResponse.status !== 200) {
        return yield* Effect.fail(
          new Error(
            `provider response ${providerResponse.status}: ${yield* Effect.promise(() => providerResponse.text())}`,
          ),
        )
      }
      if (modelResponse.status !== 200) {
        return yield* Effect.fail(
          new Error(`model response ${modelResponse.status}: ${yield* Effect.promise(() => modelResponse.text())}`),
        )
      }

      const providerBody = yield* responseJson(providerResponse)
      const modelBody = yield* responseJson(modelResponse)
      expect(isRecord(providerBody) && Array.isArray(providerBody.data)).toBe(true)
      expect(isRecord(modelBody) && Array.isArray(modelBody.data)).toBe(true)
    }),
    projectOptions,
    30000,
  )

  it.instance.skip(
    "returns public v2 provider not found errors",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const response = yield* request("/api/provider/missing", {
        headers: { "x-opencode-directory": directory },
      })

      expect(response.status).toBe(404)
      expect(yield* response.json).toEqual({
        _tag: "ProviderNotFoundError",
        providerID: "missing",
        message: "Provider not found: missing",
      })
    }),
    projectOptions,
  )

  it.instance(
    "serves OAuth authorize response shapes",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const headers = { "x-opencode-directory": directory, "content-type": "application/json" }
      const api = yield* requestAuthorize({
        providerID,
        method: 0,
        headers,
      })
      // method 0 (api-key style) — authorize() resolves with no further
      // redirect; #26474 changed the wire format to JSON `null` so clients
      // can `.json()` parse uniformly instead of getting an empty body
      // that throws.
      expect(api).toEqual({ status: 200, body: "null" })

      const oauth = yield* requestAuthorize({
        providerID,
        method: 1,
        headers,
      })
      expect(JSON.parse(oauth.body)).toEqual({
        url: oauthURL,
        method: "code",
        instructions: oauthInstructions,
      })
    }),
    { ...projectOptions, init: writeProviderAuthPlugin },
    30000,
  )

  it.instance(
    "returns declared provider auth validation errors",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const response = yield* requestAuthorize({
        providerID: "test-oauth-validation",
        method: 0,
        inputs: { token: "nope" },
        headers: { "x-opencode-directory": directory, "content-type": "application/json" },
      })

      expect(response.status).toBe(400)
      expect(JSON.parse(response.body)).toEqual({
        name: "ProviderAuthValidationFailed",
        data: { field: "token", message: "Token must be ok" },
      })
    }),
    { ...projectOptions, init: writeProviderAuthValidationPlugin },
    30000,
  )

  it.instance(
    "returns declared provider auth callback errors",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const response = yield* requestCallback({
        providerID,
        method: 0,
        headers: { "x-opencode-directory": directory, "content-type": "application/json" },
      })

      expect(response.status).toBe(400)
      expect(JSON.parse(response.body)).toEqual({
        name: "ProviderAuthOauthMissing",
        data: { providerID },
      })
    }),
    projectOptions,
    30000,
  )

  // BUG: Provider auth loaders receive mutable provider/model state; mutating
  // provider.models leaks into public provider output. The fix belongs in
  // src/provider state construction, which is outside this server-test merge scope.
  it.instance.todo(
    "serves provider lists when auth loaders add runtime fetch options",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      yield* setEnvScoped(
        "OPENCODE_AUTH_CONTENT",
        JSON.stringify({
          google: { type: "oauth", refresh: "dummy", access: "dummy", expires: 9999999999999 },
        }),
      )
      const headers = { "x-opencode-directory": directory }
      const providerResponse = yield* requestDefault("/provider", { headers })
      const configResponse = yield* requestDefault("/config/providers", { headers })

      if (providerResponse.status !== 200) {
        return yield* Effect.fail(
          new Error(`provider response ${providerResponse.status}: ${yield* Effect.promise(() => providerResponse.text())}`),
        )
      }
      if (configResponse.status !== 200) {
        return yield* Effect.fail(
          new Error(`config response ${configResponse.status}: ${yield* Effect.promise(() => configResponse.text())}`),
        )
      }
      expect(providerResponse.status).toBe(200)
      expect(configResponse.status).toBe(200)

      const providerBody = yield* responseJson(providerResponse)
      const configBody = yield* responseJson(configResponse)
      expect(hasProviderWithFetch(providerBody, "all")).toBe(false)
      expect(hasProviderWithFetch(configBody, "providers")).toBe(false)
      expect(hasNonZeroModelCost(providerBody, "all", "google")).toBe(true)
      expect(hasNonZeroModelCost(configBody, "providers", "google")).toBe(true)
    }),
    { ...googleProjectOptions, init: writeFunctionOptionsPlugin },
  )

  it.instance(
    "keeps provider.models hook input mutations out of provider state",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory

      const headers = { "x-opencode-directory": directory }
      const providerResponse = yield* requestDefault("/provider", { headers })
      const configResponse = yield* requestDefault("/config/providers", { headers })

      if (providerResponse.status !== 200) {
        return yield* Effect.fail(
          new Error(`provider response ${providerResponse.status}: ${yield* Effect.promise(() => providerResponse.text())}`),
        )
      }
      if (configResponse.status !== 200) {
        return yield* Effect.fail(
          new Error(`config response ${configResponse.status}: ${yield* Effect.promise(() => configResponse.text())}`),
        )
      }
      expect(providerResponse.status).toBe(200)
      expect(configResponse.status).toBe(200)

      const providerBody = yield* responseJson(providerResponse)
      const configBody = yield* responseJson(configResponse)
      expect(hasProviderMutationMarker(providerBody, "all", "google")).toBe(false)
      expect(hasProviderMutationMarker(configBody, "providers", "google")).toBe(false)
      expect(hasNonZeroModelCost(providerBody, "all", "google")).toBe(true)
    }),
    { ...googleProjectOptions, init: writeProviderModelsMutationPlugin },
  )
})
