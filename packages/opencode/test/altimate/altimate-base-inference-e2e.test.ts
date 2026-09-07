// Altimate Base — full register -> provider-list -> authorizedFetch round trip against the shared
// hermetic `FakeGateway`, plus the security-critical placeholder-vs-real-key property and
// credential-storage isolation. This is Suite C from
// docs/internal/2026-09-04-altimate-base-e2e-harness-plan.md, Deliverable 1 "D" /
// Deliverable 3 row "C": the gap between `altimate-base.test.ts` (unit-level, mocks
// `credentialsForLoad`) and a genuine end-to-end contract test that goes through a real
// registration, a live `Provider.list()` instance, and `authorizedFetch` itself.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { consented, isolateAltimateBaseHome, resetGatewayEnv } from "./_fixtures/altimate-base-harness"
import { FakeGateway, GATEWAY_URL } from "./_fixtures/fake-gateway"
import { tmpdir } from "../fixture/fixture"

isolateAltimateBaseHome("altimate-base-inference-e2e")

const { FreeTier } = await import("../../src/altimate/free/client")
const { FreeTierStore } = await import("../../src/altimate/free/store")
const { Provider } = await import("../../src/provider/provider")
const { Instance } = await import("../../src/project/instance")
const { ProjectID } = await import("../../src/project/schema")

// This file plays the role of the TUI host, exactly like `altimate-base.test.ts` and
// `altimate-base-harness-smoke.test.ts` do. Minting a consent token goes through the shared
// `consented()` helper in `_fixtures/altimate-base-harness.ts`, which claims the process's ONE
// arming capability lazily and caches it — see that file for why (running multiple suite files in
// one `bun test` worker process means only the first call to `issueArmer()` may succeed).

// A registered API key that could never be confused with `FreeTier.MANAGED_API_KEY_PLACEHOLDER`
// ("altimate-base-managed") -- distinct enough that any accidental substring match is meaningful.
const REAL_API_KEY = "sk-altimate-base-real-managed-secret-000111222"

const gateway = new FakeGateway()

async function registerWithGateway() {
  gateway.registerNext({ kind: "ok", apiKey: REAL_API_KEY })
  return FreeTier.registerAfterConsent(consented())
}

// Mirrors `provideProviderTestInstance` from `test/provider/provider.test.ts` -- the established
// pattern for exercising `Provider.list()` against a real (non-mocked) `Instance` context.
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

function chatRequestInit() {
  return {
    method: "POST" as const,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: FreeTier.MODEL_ID, messages: [{ role: "user", content: "hi" }] }),
  }
}

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

describe("Altimate Base inference e2e — happy path", () => {
  test("register then authorizedFetch round-trips a chat completion", async () => {
    await registerWithGateway()

    gateway.chatNext({ kind: "ok", content: "the answer is 42" })
    const response = await FreeTier.authorizedFetch(`${GATEWAY_URL}/v1/chat/completions`, chatRequestInit())

    expect(response.status).toBe(200)
    const body = (await response.json()) as { choices: [{ message: { content: string } }] }
    expect(body.choices[0]?.message.content).toBe("the answer is 42")
    expect(gateway.chatCalls).toHaveLength(1)
  })

  test("the registered model is surfaced as connected by a live Provider.list()", async () => {
    await registerWithGateway()

    await using tmp = await tmpdir()
    await provideProviderTestInstance({
      directory: tmp.path,
      fn: async () => {
        const providers = await Provider.list()
        const base = providers[FreeTier.PROVIDER_ID]
        expect(base).toBeDefined()
        expect(base.options.baseURL).toBe(`${GATEWAY_URL}/v1`)
        // `provider.ts` wires `FreeTier.authorizedFetch` directly as the model's `fetch` option --
        // this is the exact seam a real inference call would use, so proving it's wired confirms
        // the "model is usable" claim without needing to drive the full AI SDK.
        expect(base.options.fetch).toBe(FreeTier.authorizedFetch)
        expect(base.models[FreeTier.MODEL_ID]).toBeDefined()
      },
    })
  })
})

describe("Altimate Base inference e2e — managed key placeholder never goes on the wire", () => {
  test("provider options carry ONLY the placeholder; authorizedFetch injects the REAL key", async () => {
    await registerWithGateway()

    // 1. Prove the placeholder -- not the real key -- is what a public provider API serializes.
    // `Provider.Info` is returned by public provider-listing endpoints, so anything that ends up
    // here is effectively exposed.
    await using tmp = await tmpdir()
    await provideProviderTestInstance({
      directory: tmp.path,
      fn: async () => {
        const providers = await Provider.list()
        const base = providers[FreeTier.PROVIDER_ID]
        expect(base.options.apiKey).toBe(FreeTier.MANAGED_API_KEY_PLACEHOLDER)
        expect(JSON.stringify(base)).not.toContain(REAL_API_KEY)
      },
    })

    // 2. Prove the REAL key -- not the placeholder -- is what actually reaches the gateway when
    // `authorizedFetch` (the function wired into those same provider options) is invoked. This is
    // the security-critical assertion: it inspects the literal `Authorization` header the fake
    // gateway received, not a mocked/assumed value.
    gateway.chatNext({ kind: "ok", content: "ok" })
    await FreeTier.authorizedFetch(`${GATEWAY_URL}/v1/chat/completions`, chatRequestInit())

    expect(gateway.chatCalls).toHaveLength(1)
    const sentAuthorization = gateway.chatCalls[0]?.authorization
    expect(sentAuthorization).toBe(`Bearer ${REAL_API_KEY}`)
    expect(sentAuthorization).not.toBe(`Bearer ${FreeTier.MANAGED_API_KEY_PLACEHOLDER}`)
    expect(sentAuthorization).not.toContain(FreeTier.MANAGED_API_KEY_PLACEHOLDER)
  })
})

describe("Altimate Base inference e2e — credential storage", () => {
  test("registered credential lives ONLY in the dedicated FreeTierStore, not the shared auth store", async () => {
    const sharedAuthPath = path.join(path.dirname(FreeTierStore.credentialPath()), "auth.json")
    const sharedAuthBefore = fs.existsSync(sharedAuthPath) ? fs.readFileSync(sharedAuthPath) : undefined

    const result = await registerWithGateway()

    // Dedicated store: correct file, correct fields.
    expect(path.basename(FreeTierStore.credentialPath())).toBe("altimate-base.json")
    const stored = await FreeTierStore.read()
    expect(stored?.apiKey).toBe(REAL_API_KEY)
    expect(stored?.baseURL).toBe(GATEWAY_URL)
    expect(stored?.apiKey).toBe(result.apiKey)

    // Restrictive perms: `store.ts` explicitly opens the temp file 0600 and chmods the final file
    // 0600 before/after the atomic rename.
    expect(fs.statSync(FreeTierStore.credentialPath()).mode & 0o777).toBe(0o600)

    // NOT in the shared provider auth store that lives right next to it: registration must leave
    // that file byte-for-byte unchanged (absent stays absent; present stays identical), and in
    // particular must never contain the real managed key.
    const sharedAuthAfter = fs.existsSync(sharedAuthPath) ? fs.readFileSync(sharedAuthPath) : undefined
    expect(sharedAuthAfter).toEqual(sharedAuthBefore)
    if (sharedAuthAfter) expect(sharedAuthAfter.toString("utf8")).not.toContain(REAL_API_KEY)
  })
})

describe("Altimate Base inference e2e — credential-not-present path", () => {
  test("authorizedFetch fails closed with no registered credential and never reaches the gateway", async () => {
    // beforeEach already logged out and removed the store, so this test starts unregistered.
    expect(await FreeTierStore.read()).toBeUndefined()

    await expect(FreeTier.authorizedFetch(`${GATEWAY_URL}/v1/chat/completions`, chatRequestInit())).rejects.toThrow(
      "Altimate Base credentials are unavailable. Set up the model again.",
    )

    // Fails closed before any network call -- the gateway never sees the request.
    expect(gateway.chatCalls).toHaveLength(0)
  })
})
