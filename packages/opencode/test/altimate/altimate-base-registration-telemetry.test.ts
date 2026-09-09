// altimate_change start — first-run health: every Altimate Base registration reports its outcome and
// wall time through `altimate_base_registration`, regardless of whether the TUI or the HTTP consent
// route triggered it.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { consented, isolateAltimateBaseHome, resetGatewayEnv } from "./_fixtures/altimate-base-harness"
import { FakeGateway, GATEWAY_URL } from "./_fixtures/fake-gateway"
import { Telemetry } from "../../src/altimate/telemetry"

// Harness contract: isolate the Altimate Base home BEFORE importing src/altimate/free/*.
isolateAltimateBaseHome("altimate-base-registration-telemetry")

const { FreeTier } = await import("../../src/altimate/free/client")
const { FreeTierStore } = await import("../../src/altimate/free/store")

type Registration = Extract<Telemetry.Event, { type: "altimate_base_registration" }>

const gateway = new FakeGateway()
let events: Telemetry.Event[] = []
let spy: ReturnType<typeof spyOn> | undefined
const GATEWAY_ENV = ["ALTIMATE_BASE_GATEWAY_URL", "ALTIMATE_FREE_GATEWAY_URL"] as const
let savedEnv: Record<string, string | undefined> = {}

/**
 * reportRegistration tracks from a `.then` attached to `Telemetry.init()` BEFORE the registration
 * promise settles for the caller. init() is idempotent and returns that same promise, so awaiting it
 * here queues our continuation behind the track callback: no sleep, no poll, deterministic order.
 */
async function reported(): Promise<Registration[]> {
  await Telemetry.init()
  return registrations()
}

function registrations(): Registration[] {
  return events.filter((e): e is Registration => e.type === "altimate_base_registration")
}

beforeEach(async () => {
  savedEnv = Object.fromEntries(GATEWAY_ENV.map((key) => [key, process.env[key]]))
  gateway.install()
  gateway.reset()
  await FreeTier.logout()
  await FreeTierStore.remove()
  resetGatewayEnv(GATEWAY_URL)
  events = []
  spy = spyOn(Telemetry, "track").mockImplementation((event) => {
    events.push(event)
  })
})

afterEach(() => {
  spy?.mockRestore()
  gateway.restore()
  for (const key of GATEWAY_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

describe("altimate_base_registration", () => {
  test("a successful registration reports success with a duration", async () => {
    gateway.registerNext({ kind: "ok" })
    await FreeTier.registerAfterConsent(consented())
    const reports = await reported()
    expect(reports).toHaveLength(1)
    expect(reports[0].result).toBe("success")
    expect(reports[0].duration_ms).toBeGreaterThanOrEqual(0)
    expect(reports[0].status).toBeUndefined()
  })

  test("an HTTP rejection reports the status", async () => {
    gateway.registerNext({ kind: "http", status: 429 })
    await expect(FreeTier.registerAfterConsent(consented())).rejects.toBeInstanceOf(FreeTier.RegistrationError)
    const reports = await reported()
    expect(reports).toHaveLength(1)
    expect(reports[0].result).toBe("http")
    expect(reports[0].status).toBe(429)
  })

  test("a misconfigured gateway URL reports result configuration", async () => {
    process.env.ALTIMATE_BASE_GATEWAY_URL = "ftp://not-a-gateway"
    await expect(FreeTier.registerAfterConsent(consented())).rejects.toBeInstanceOf(
      FreeTier.ConfigurationError,
    )
    expect((await reported()).map((r) => r.result)).toEqual(["configuration"])
  })

  test("a network failure reports result network", async () => {
    gateway.registerNext({ kind: "network" })
    await expect(FreeTier.registerAfterConsent(consented())).rejects.toBeInstanceOf(FreeTier.RegistrationError)
    expect((await reported()).map((r) => r.result)).toEqual(["network"])
  })

  test("a caller abort before the request reports result cancelled", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(FreeTier.registerAfterConsent(consented(), { signal: controller.signal })).rejects.toBeDefined()
    expect((await reported()).map((r) => r.result)).toEqual(["cancelled"])
  })

  test("an expired consent token reports result cancelled", async () => {
    await expect(FreeTier.registerAfterConsent("not-a-consent-token")).rejects.toBeInstanceOf(
      FreeTier.RegistrationError,
    )
    expect((await reported()).map((r) => r.result)).toEqual(["cancelled"])
  })
})
// altimate_change end
