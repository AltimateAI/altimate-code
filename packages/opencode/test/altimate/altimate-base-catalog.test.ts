// Suite B (Deliverable 3) of docs/internal/2026-09-04-altimate-base-e2e-harness-plan.md: the model
// catalog / provider-isolation layer for Altimate Base. This suite mostly exercises
// `src/provider/provider.ts` directly (via `Provider.list()`/`Provider.all()`/`Provider.defaultModel()`/
// `Provider.sort()`), not the gateway's chat route — registration goes through the real
// `FreeTier.registerAfterConsent()` + `FakeGateway` `/register` route so every test starts from a
// credential that was actually minted through the production consent path, not a mocked
// `credentialsForLoad()` return value (that mocked style is what `test/provider/provider.test.ts`
// already does for its own, broader defaultModel()/config-hostility coverage — this suite is the
// complementary hermetic-harness version, scoped to Deliverable 1 Suite C).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { consented, isolateAltimateBaseHome, resetGatewayEnv } from "./_fixtures/altimate-base-harness"
import { FakeGateway, GATEWAY_URL } from "./_fixtures/fake-gateway"
import { tmpdir } from "../fixture/fixture"

isolateAltimateBaseHome("altimate-base-catalog")

const { FreeTier } = await import("../../src/altimate/free/client")
const { FreeTierStore } = await import("../../src/altimate/free/store")
const { Auth } = await import("../../src/auth")
const { Provider } = await import("../../src/provider/provider")
const { ProviderID, ModelID } = await import("../../src/provider/schema")
const { Instance } = await import("../../src/project/instance")
const { ProjectID } = await import("../../src/project/schema")

// This file plays the role of the TUI host, exactly like `altimate-base.test.ts` and
// `altimate-base-harness-smoke.test.ts` do. Minting a consent token goes through the shared
// `consented()` helper in `_fixtures/altimate-base-harness.ts`, which claims the process's ONE
// arming capability lazily and caches it — see that file for why (running multiple suite files in
// one `bun test` worker process means only the first call to `issueArmer()` may succeed).

// Mirrors `provideProviderTestInstance` in test/provider/provider.test.ts — puts `Provider.list()`/
// `Provider.defaultModel()` inside an isolated project Instance so their memoized `state()` is
// fresh per test directory instead of leaking across tests in this file.
function provideProviderTestInstance<R>(input: { directory: string; fn: () => R | Promise<R> }) {
  const now = Date.now()
  return Instance.restore(
    {
      directory: input.directory,
      worktree: input.directory,
      project: {
        id: ProjectID.global,
        worktree: input.directory,
        time: { created: now, updated: now },
        sandboxes: [],
      },
    },
    input.fn,
  )
}

const gateway = new FakeGateway()

beforeEach(async () => {
  gateway.install()
  gateway.reset()
  await FreeTier.logout()
  await FreeTierStore.remove()
  resetGatewayEnv(GATEWAY_URL)
})

afterEach(() => {
  gateway.restore()
})

/** Registers a real credential through the production consent path against the fake gateway. */
async function registerCredential(): Promise<void> {
  gateway.registerNext({ kind: "ok" })
  await FreeTier.registerAfterConsent(consented())
}

describe("model catalog: altimate-free/altimate-base", () => {
  test("a registered credential surfaces the model with the gateway-pinned limit, zero cost, and its declared capabilities", async () => {
    await registerCredential()
    await using tmp = await tmpdir()
    await provideProviderTestInstance({
      directory: tmp.path,
      fn: async () => {
        const providers = await Provider.list()
        const base = providers[FreeTier.PROVIDER_ID]
        expect(base).toBeDefined()
        expect(base.name).toBe("Altimate")

        const model = base.models[FreeTier.MODEL_ID]
        expect(model).toBeDefined()
        expect(model.name).toBe("Altimate Base")
        // altimate_change — family is scrubbed to the generic "altimate" brand (bec2ae37c1); the
        // served model's underlying family is never disclosed publicly.
        expect(model.family).toBe("altimate")
        // This is the number this suite exists to guard: the offline/fallback contract must stay
        // equal to what the gateway currently serves (131072/65536), not drift silently.
        expect(model.limit).toEqual({ context: 131_072, output: 65_536 })
        expect(model.cost).toEqual({ input: 0, output: 0, cache: { read: 0, write: 0 } })
        expect(model.capabilities).toEqual({
          temperature: true,
          reasoning: true,
          attachment: false,
          toolcall: true,
          input: { text: true, audio: false, image: false, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: false,
        })
      },
    })
  })
})

describe("autoload gating", () => {
  test("with no credential, the loader returns autoload:false: the model is absent from the connected list even though the static catalog entry always exists", async () => {
    await using tmp = await tmpdir()
    await provideProviderTestInstance({
      directory: tmp.path,
      fn: async () => {
        const providers = await Provider.list()
        expect(providers[FreeTier.PROVIDER_ID]).toBeUndefined()

        // "Registered in the catalog" and "connected" are deliberately different: the static
        // database entry always exists so the model can be discovered/listed, but it only crosses
        // into the connected `providers` map once credentialsForLoad() resolves.
        const database = await Provider.all()
        expect(database[FreeTier.PROVIDER_ID]).toBeDefined()
        expect(database[FreeTier.PROVIDER_ID]!.models[FreeTier.MODEL_ID]).toBeDefined()
      },
    })
  })

  test("with a credential, the loader autoloads with the managed placeholder apiKey and authorizedFetch wired in as the fetch option", async () => {
    await registerCredential()
    await using tmp = await tmpdir()
    await provideProviderTestInstance({
      directory: tmp.path,
      fn: async () => {
        const providers = await Provider.list()
        const base = providers[FreeTier.PROVIDER_ID]
        expect(base).toBeDefined()
        expect(base.options.baseURL).toBe(`${GATEWAY_URL}/v1`)
        // The real managed key never enters Provider.Info/options — only the placeholder does, and
        // authorizedFetch is what actually injects the live credential per-request.
        expect(base.options.apiKey).toBe(FreeTier.MANAGED_API_KEY_PLACEHOLDER)
        expect(base.options.fetch).toBe(FreeTier.authorizedFetch)
        expect(JSON.stringify(base)).not.toContain("sk-altimate-base-fake")
      },
    })
  })
})

describe("defaultModel() and sort() for Altimate Base", () => {
  test("registered Altimate Base is selected only as the last resort, once every other provider is excluded as a candidate", async () => {
    await registerCredential()
    // Isolate the provider set down to just altimate-free so the ordinary "opencode"/free-model
    // candidates (which would otherwise always win first) cannot mask the last-resort branch.
    await using tmp = await tmpdir({ config: { enabled_providers: [FreeTier.PROVIDER_ID] } })
    await provideProviderTestInstance({
      directory: tmp.path,
      fn: async () => {
        const model = await Provider.defaultModel()
        expect(model).toEqual({
          providerID: ProviderID.make(FreeTier.PROVIDER_ID),
          modelID: ModelID.make(FreeTier.MODEL_ID),
        })
      },
    })
  })

  test("an unregistered Altimate Base is never selected, even with every other provider excluded", async () => {
    await using tmp = await tmpdir({ config: { enabled_providers: [FreeTier.PROVIDER_ID] } })
    await provideProviderTestInstance({
      directory: tmp.path,
      fn: async () => {
        const failure = await Provider.defaultModel().catch((error) => error)
        expect(failure).toBeInstanceOf(Error)
        expect(failure.message).toBe("no providers found")
      },
    })
  })

  test("a project provider allowlist naming Altimate Base cannot activate it as the default, even when it is the only registered candidate", async () => {
    await registerCredential()
    await using tmp = await tmpdir({ config: { provider: { [FreeTier.PROVIDER_ID]: {} } } })
    await provideProviderTestInstance({
      directory: tmp.path,
      fn: async () => {
        const failure = await Provider.defaultModel().catch((error) => error)
        expect(failure).toBeInstanceOf(Error)
        expect(failure.message).toBe("no providers found")
      },
    })
  })

  test("Provider.sort() ranks altimate-base ahead of both an unlisted model id and the retired 'big-pickle' priority slot", () => {
    const sorted = Provider.sort([
      { id: "opencode/big-pickle" },
      { id: "foo/unlisted-model" },
      { id: `${FreeTier.PROVIDER_ID}/${FreeTier.MODEL_ID}` },
    ])
    expect(sorted[0]!.id).toBe(`${FreeTier.PROVIDER_ID}/${FreeTier.MODEL_ID}`)
  })
})

describe("two-provider isolation: altimate-free vs. altimate-backend, and the dedicated credential store", () => {
  test("altimate-free ('Altimate') is a separate catalog record from the paid altimate-backend ('Altimate AI') provider", async () => {
    await registerCredential()
    await using tmp = await tmpdir()
    await provideProviderTestInstance({
      directory: tmp.path,
      fn: async () => {
        const database = await Provider.all()
        const base = database[FreeTier.PROVIDER_ID]
        const backend = database["altimate-backend"]
        expect(base).toBeDefined()
        expect(backend).toBeDefined()
        expect(base!.id).not.toBe(backend!.id)
        expect(base!.name).toBe("Altimate")
        expect(backend!.name).toBe("Altimate AI")
        // Distinct model namespaces: the free model id must not exist under the paid provider and
        // vice versa — these are two providers, not one provider with two auth paths.
        expect(backend!.models[FreeTier.MODEL_ID]).toBeUndefined()
        expect(base!.models["altimate-default"]).toBeUndefined()
      },
    })
  })

  test("a registered Altimate Base credential lives only in its dedicated store, never in the shared provider auth store", async () => {
    await registerCredential()
    const stored = await FreeTierStore.read()
    expect(stored?.apiKey).toBeDefined()

    // This is the deliberate design decision this suite guards: unlike altimate-backend (which can
    // read its key from the shared `Auth` store — see provider.ts's "path 2" fallback for
    // altimate-backend), altimate-free/Altimate Base has no such fallback. Its credential must never
    // appear under its provider id in the shared store the rest of the provider system reads.
    const sharedAuth = await Auth.all()
    expect(sharedAuth[FreeTier.PROVIDER_ID]).toBeUndefined()
    expect(JSON.stringify(sharedAuth)).not.toContain(stored!.apiKey)
  })
})
