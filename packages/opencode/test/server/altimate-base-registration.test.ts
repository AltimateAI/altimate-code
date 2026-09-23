import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Server } from "../../src/server/server"
import { FreeTier } from "../../src/altimate/free/client"
import { FreeTierConsent } from "../../src/altimate/free/consent"
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

function mockRegister(impl: () => Promise<unknown>) {
  registerSpy = spyOn(FreeTier, "register").mockImplementation(impl as typeof FreeTier.register)
}

afterEach(async () => {
  registerSpy?.mockRestore()
  registerSpy = undefined
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
})

describe("disclosure hash", () => {
  test("is a stable hex sha256 of the canonical text", () => {
    expect(FreeTierConsent.disclosureHash()).toMatch(/^[0-9a-f]{64}$/)
    expect(FreeTierConsent.disclosureHash()).toBe(FreeTierConsent.disclosureHash())
  })
})
