import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Server } from "../../src/server/server"
import { FreeTier } from "../../src/altimate/free/client"
import { FreeTierConsent } from "../../src/altimate/free/consent"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { resetDatabase } from "./db"
import { disposeAllInstances } from "../fixture/fixture"

function app() {
  return Server.Default()
}

// Registration is no longer gated behind a provided capability — any server with a gateway
// configured can register, via `FreeTier.register({ origin: "server" })` called directly from the
// route. This file tests only the ROUTE's own behavior (Origin protection, hash handling, outcome
// passthrough, instance disposal on success) by mocking `FreeTier.register` directly rather than
// exercising a real gateway fetch — the registration function itself (network/HTTP/response
// mapping) is covered by test/altimate/altimate-base*.test.ts.
let registerSpy: ReturnType<typeof spyOn> | undefined
// altimate_change — Codex review finding: the route must skip instance-wide disposal when
// `FreeTier.register()` reported success but the credential on disk didn't actually change (its
// idempotent "already registered" fast path). The route detects this by comparing
// `FreeTier.credentials()` before/after, so these tests drive that comparison directly.
let credentialsSpy: ReturnType<typeof spyOn> | undefined

function mockRegister(impl: () => Promise<unknown>) {
  registerSpy = spyOn(FreeTier, "register").mockImplementation(impl as typeof FreeTier.register)
}

// altimate_change — see `credentialsSpy` above. Index-based (not `.shift() ?? ...`): the first
// value in the sequence is legitimately `undefined` (no credential yet), which `??` cannot tell
// apart from "queue exhausted".
function mockCredentialsSequence(...values: Array<Awaited<ReturnType<typeof FreeTier.credentials>>>) {
  let i = 0
  credentialsSpy = spyOn(FreeTier, "credentials").mockImplementation(async () => {
    const value = values[Math.min(i, values.length - 1)]
    i++
    return value
  })
}

afterEach(async () => {
  registerSpy?.mockRestore()
  registerSpy = undefined
  // altimate_change — see `credentialsSpy` above
  credentialsSpy?.mockRestore()
  credentialsSpy = undefined
  await disposeAllInstances()
  await resetDatabase()
})

describe("Altimate Base registration route", () => {
  test("GET disclosure returns text, hint, hash, and registration state", async () => {
    const isRegistered = spyOn(FreeTier, "isRegistered").mockResolvedValue(false)
    try {
      const response = await app().request("/altimate/base/disclosure")
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        disclosure: string
        hint: string
        sha256: string
        registered: boolean
      }
      expect(body.disclosure).toBe(FreeTierConsent.DISCLOSURE)
      expect(body.hint).toBe(FreeTierConsent.HINT)
      expect(body.sha256).toBe(FreeTierConsent.disclosureHash())
      expect(body.registered).toBe(false)
    } finally {
      isRegistered.mockRestore()
    }
  })

  test("register works without a hash", async () => {
    mockRegister(async () => ({ apiKey: "sk-fake", baseURL: "https://gateway.test", installSecret: "s" }))
    const response = await app().request("/altimate/base/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true })
    expect(registerSpy).toHaveBeenCalledTimes(1)
    expect(registerSpy).toHaveBeenCalledWith({ origin: "server" })
  })

  test("register accepts and ignores a stale or absent disclosure hash", async () => {
    mockRegister(async () => ({ apiKey: "sk-fake", baseURL: "https://gateway.test", installSecret: "s" }))
    const response = await app().request("/altimate/base/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ acceptedDisclosureSha256: "0".repeat(64) }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true })
    expect(registerSpy).toHaveBeenCalledTimes(1)
  })

  test("a browser-originated request is still refused on an unsecured server", async () => {
    mockRegister(async () => ({ apiKey: "sk-fake", baseURL: "https://gateway.test", installSecret: "s" }))
    const response = await app().request("/altimate/base/register", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(403)
    // Nothing was minted: a CORS-allowed page cannot opt the installation into request logging.
    expect(registerSpy).not.toHaveBeenCalled()
  })

  test("a gateway failure is passed through with its result taxonomy intact", async () => {
    mockRegister(async () => {
      throw new FreeTier.RegistrationError("Too many requests.", "http", 429)
    })
    const response = await app().request("/altimate/base/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: false, result: "rate_limited" })
  })

  test("a malformed body is rejected by the validator", async () => {
    const response = await app().request("/altimate/base/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    })
    expect(response.status).toBe(400)
  })

  // altimate_change start — Codex review finding: `FreeTier.register()` reports success whether
  // it minted/rotated a credential or just returned an existing valid one unchanged (its
  // idempotent fast path). Disposing every session/LSP/PTY/MCP connection in the process on the
  // idempotent path is pure disruption for zero benefit, since no provider loader has anything new
  // to re-read.
  test("disposes every instance when registration actually mints a new credential", async () => {
    mockCredentialsSequence(undefined, { apiKey: "sk-new", baseURL: "https://gateway.test", installSecret: "s" })
    mockRegister(async () => ({ apiKey: "sk-new", baseURL: "https://gateway.test", installSecret: "s" }))
    const disposeAll = spyOn(Instance, "disposeAll")
    try {
      const response = await app().request("/altimate/base/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ ok: true })
      expect(disposeAll).toHaveBeenCalledTimes(1)
    } finally {
      disposeAll.mockRestore()
    }
  })

  test("skips instance disposal once this process has reloaded for the unchanged credential", async () => {
    const existing = { apiKey: "sk-existing", baseURL: "https://gateway.test", installSecret: "s" }
    mockCredentialsSequence(existing)
    mockRegister(async () => existing)
    const disposeAll = spyOn(Instance, "disposeAll")
    const post = () =>
      app().request("/altimate/base/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
    try {
      // First call: unchanged on disk, but nothing yet shows this process's caches include it.
      expect(await (await post()).json()).toMatchObject({ ok: true })
      expect(disposeAll).toHaveBeenCalledTimes(1)
      // Second call: already reloaded for this credential, so there is nothing left to re-read,
      // and no reason to tear down live sessions/LSPs/PTYs/MCP connections again.
      expect(await (await post()).json()).toMatchObject({ ok: true })
      expect(disposeAll).toHaveBeenCalledTimes(1)
    } finally {
      disposeAll.mockRestore()
    }
  })

  test("reloads when an applied credential is renewed with the same key and URL", async () => {
    // An expired credential loads as absent, so directories opened after it expired cached no Base.
    // Renewing it can reissue the same key and URL with only a new expiry; that still has to reload.
    const expired = { apiKey: "sk-renew", baseURL: "https://gateway.test", installSecret: "s", expiresAt: "2026-01-01T00:00:00Z" }
    const renewed = { ...expired, expiresAt: "2099-01-01T00:00:00Z" }
    const disposeAll = spyOn(Instance, "disposeAll")
    const post = () =>
      app().request("/altimate/base/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
    try {
      mockCredentialsSequence(expired)
      mockRegister(async () => expired)
      await post()
      expect(disposeAll).toHaveBeenCalledTimes(1)
      credentialsSpy?.mockRestore()
      registerSpy?.mockRestore()
      mockCredentialsSequence(expired, renewed)
      mockRegister(async () => renewed)
      expect(await (await post()).json()).toMatchObject({ ok: true })
      expect(disposeAll).toHaveBeenCalledTimes(2)
    } finally {
      disposeAll.mockRestore()
    }
  })

  test("reloads when the same credential is reissued after a logout in another process", async () => {
    // Logout rotates the nonce; directories opened while logged out cached no Base. A later
    // registration can reissue the identical key, URL and expiry, so only the nonce differs.
    const first = { apiKey: "sk-aba", baseURL: "https://gateway.test", installSecret: "s", logoutNonce: "n1" }
    const reissued = { ...first, logoutNonce: "n2" }
    const disposeAll = spyOn(Instance, "disposeAll")
    const post = () =>
      app().request("/altimate/base/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
    try {
      mockCredentialsSequence(first)
      mockRegister(async () => first)
      await post()
      expect(disposeAll).toHaveBeenCalledTimes(1)
      credentialsSpy?.mockRestore()
      registerSpy?.mockRestore()
      mockCredentialsSequence(reissued)
      mockRegister(async () => reissued)
      expect(await (await post()).json()).toMatchObject({ ok: true })
      expect(disposeAll).toHaveBeenCalledTimes(2)
    } finally {
      disposeAll.mockRestore()
    }
  })

  test("reloads for a credential registered in the background, even if one directory already sees Base", async () => {
    // A startup auto-registration that finished after the server started leaves the file unchanged
    // across this request, while caches built earlier (another directory, or the /api registry)
    // still predate it. Whether this request's own directory lists Base says nothing about those.
    const late = { apiKey: "sk-late", baseURL: "https://gateway.test", installSecret: "s" }
    mockCredentialsSequence(late)
    mockRegister(async () => late)
    const list = spyOn(Provider, "list").mockResolvedValue({
      [FreeTier.PROVIDER_ID]: {},
    } as unknown as Awaited<ReturnType<typeof Provider.list>>)
    const disposeAll = spyOn(Instance, "disposeAll")
    try {
      const response = await app().request("/altimate/base/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ ok: true })
      expect(disposeAll).toHaveBeenCalledTimes(1)
    } finally {
      disposeAll.mockRestore()
      list.mockRestore()
    }
  })
  // altimate_change end
})

describe("disclosure hash", () => {
  test("is a stable hex sha256 of the canonical text", () => {
    expect(FreeTierConsent.disclosureHash()).toMatch(/^[0-9a-f]{64}$/)
    expect(FreeTierConsent.disclosureHash()).toBe(FreeTierConsent.disclosureHash())
  })
})
