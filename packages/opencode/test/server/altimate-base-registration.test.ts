import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"
import { FreeTierConsent } from "../../src/altimate/free/consent"
import { FreeTierHost } from "../../src/altimate/free/host"
import { resetDatabase } from "./db"
import { disposeAllInstances } from "../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

function app() {
  return Server.Default()
}

// TOPOLOGY NOTE — this file is order-dependent, deliberately.
//
// `FreeTierHost.provide()` installs process-wide module state and is single-shot (a second call
// throws, matching `issueArmer`/`issueRedeemer` next door). `bun test` can load several suite files
// into ONE worker process, so the "no gate injected" case can only be observed before anything in
// the process provides one. The 501 block therefore runs first, and the gate is installed exactly
// once in `beforeAll` of the block after it.
//
// No other file calls `provide` — `cli/cmd/serve.ts` does it inside its command handler, not at
// import — so importing the server here does not arm anything on its own.

describe("Altimate Base registration — no gate injected (the TUI-worker shape)", () => {
  // Ordering: must precede the provided-gate block below.
  test("GET /altimate/base/disclosure serves 501 rather than a disclosure", async () => {
    const response = await app().request("/altimate/base/disclosure")
    expect(response.status).toBe(501)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("cannot register") })
  })

  test("POST /altimate/base/register serves 501 rather than registering", async () => {
    const response = await app().request("/altimate/base/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ acceptedDisclosureSha256: FreeTierConsent.disclosureHash() }),
    })
    expect(response.status).toBe(501)
  })
})

describe("Altimate Base registration — gate injected (the `serve` shape)", () => {
  // Records what the route asked the gate to do, so the test can assert the route mints/arms/
  // redeems in one operation instead of handing a token to the client.
  const armed: string[] = []
  const redeemed: string[] = []
  let outcome: Awaited<ReturnType<FreeTierHost.Registration["register"]>> = { ok: true }

  beforeAll(() => {
    FreeTierHost.provide({
      setToken({ token }) {
        armed.push(token)
      },
      async register({ token }) {
        redeemed.push(token)
        return outcome
      },
    })
  })

  test("provide() is single-shot", () => {
    expect(() =>
      FreeTierHost.provide({ setToken() {}, register: async () => ({ ok: true }) }),
    ).toThrow(/already provided/)
  })

  test("GET disclosure is read-only: returns text, hint and hash, and arms no token", async () => {
    const before = armed.length
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
    expect(typeof body.registered).toBe("boolean")
    // The regression this guards: arming here started the consent store's 30s TTL when the
    // disclosure was fetched, so a user who read it before consenting was rejected.
    expect(armed.length).toBe(before)
  })

  test("register mints, arms and redeems the same token in one operation", async () => {
    armed.length = 0
    redeemed.length = 0
    outcome = { ok: true }
    const response = await app().request("/altimate/base/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ acceptedDisclosureSha256: FreeTierConsent.disclosureHash() }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(armed).toHaveLength(1)
    expect(armed[0]).toMatch(/^[0-9a-f]{64}$/)
    expect(redeemed).toEqual(armed)
  })

  test("a stale or absent disclosure hash is refused without touching the gate", async () => {
    armed.length = 0
    redeemed.length = 0
    const response = await app().request("/altimate/base/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ acceptedDisclosureSha256: "0".repeat(64) }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: false, result: "error" })
    expect(armed).toHaveLength(0)
    expect(redeemed).toHaveLength(0)
  })

  test("the hash comparison is case-insensitive on the client's hex", async () => {
    armed.length = 0
    outcome = { ok: true }
    const response = await app().request("/altimate/base/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ acceptedDisclosureSha256: FreeTierConsent.disclosureHash().toUpperCase() }),
    })
    expect(await response.json()).toEqual({ ok: true })
    expect(armed).toHaveLength(1)
  })

  test("a browser-originated request is refused on an unsecured server", async () => {
    armed.length = 0
    const response = await app().request("/altimate/base/register", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ acceptedDisclosureSha256: FreeTierConsent.disclosureHash() }),
    })
    expect(response.status).toBe(403)
    // Nothing was minted: a CORS-allowed page cannot opt the installation into request logging.
    expect(armed).toHaveLength(0)
  })

  test("a gate failure is passed through with its result taxonomy intact", async () => {
    outcome = { ok: false, result: "rate_limited", message: "Too many requests." }
    const response = await app().request("/altimate/base/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ acceptedDisclosureSha256: FreeTierConsent.disclosureHash() }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: false,
      result: "rate_limited",
      message: "Too many requests.",
    })
    outcome = { ok: true }
  })

  test("a malformed body is rejected by the validator", async () => {
    const response = await app().request("/altimate/base/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nope: true }),
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
