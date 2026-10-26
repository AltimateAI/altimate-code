// altimate_change — regression test for the server-side wiring that produces `client_connected`.
//
// The telemetry unit tests (test/altimate/telemetry/first-run-health.test.ts) prove the
// `Telemetry.clientConnected()` latch; this file proves the `.use` middleware in `Server.createApp`
// that calls it. Without it, deleting the middleware, changing the `/event` / `/global/event` path
// literals, dropping the `GET` guard, failing to skip the in-process trace consumer, or emitting on
// a non-2xx would all leave the suite green while breaking (or corrupting) the IDE-funnel signal.
//
// The middleware emits AFTER next() and only when the event route returned a 2xx, via
// `void import("../altimate/telemetry").then((m) => m.Telemetry.clientConnected())`. The call lands
// on a later microtask, so positive cases poll with a bounded timeout rather than sleeping a fixed
// amount. We spy on `Telemetry.clientConnected` itself so the assertion is purely about the
// middleware deciding to call it; the once-per-process latch lives inside that function and is
// covered elsewhere.
//
// Not exercised here: the "hook moved above basic-auth" case. Auth is a separate `basicAuth`
// middleware gated on `Flag.OPENCODE_SERVER_PASSWORD`, a module-level const frozen at load, and CI
// runs the package in one Bun process, so a password set at test time can't drive a 401. The order
// is enforced structurally: the hook is registered immediately after the basic-auth `.use`, and it
// now only counts a 2xx response, so an auth rejection (non-2xx) cannot trip it.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Server } from "../../src/server/server"
import { Telemetry } from "../../src/altimate/telemetry"
import { resetDatabase } from "./db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

async function cancelBody(response: Response) {
  await response.body?.cancel().catch(() => {})
}

// The emit is async (dynamic import + .then). Poll for it instead of sleeping a fixed amount.
async function waitForCall(spy: { mock: { calls: unknown[] } }, timeoutMs = 1000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (spy.mock.calls.length > 0) return true
    await new Promise((r) => setTimeout(r, 5))
  }
  return false
}

// A negative can't be proven instantly; give the microtask/import a real chance to fire first.
async function settle() {
  await new Promise((r) => setTimeout(r, 50))
}

let spy: ReturnType<typeof spyOn<typeof Telemetry, "clientConnected">>

beforeEach(() => {
  spy = spyOn(Telemetry, "clientConnected").mockImplementation(() => {})
})

afterEach(async () => {
  spy.mockRestore()
  await disposeAllInstances()
  await resetDatabase()
})

describe("client_connected server wiring", () => {
  test("GET /global/event (2xx) invokes Telemetry.clientConnected", async () => {
    const response = await Server.Default().request("/global/event")
    expect(response.ok).toBe(true)
    await cancelBody(response)
    expect(await waitForCall(spy)).toBe(true)
  })

  test("GET /event (2xx, resolved instance) invokes Telemetry.clientConnected", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const response = await Server.Default().request("/event", { headers: { "x-opencode-directory": tmp.path } })
    expect(response.ok).toBe(true)
    await cancelBody(response)
    expect(await waitForCall(spy)).toBe(true)
  })

  test("the in-process trace consumer (x-altimate-trace-consumer) is NOT counted", async () => {
    const response = await Server.Default().request("/global/event", {
      headers: { "x-altimate-trace-consumer": "1" },
    })
    expect(response.ok).toBe(true)
    await cancelBody(response)
    await settle()
    expect(spy).not.toHaveBeenCalled()
  })

  test("a non-event path does not invoke Telemetry.clientConnected", async () => {
    const response = await Server.Default().request("/global/config")
    await cancelBody(response)
    await settle()
    expect(spy).not.toHaveBeenCalled()
  })

  test("a non-GET request to /event does not invoke Telemetry.clientConnected", async () => {
    const response = await Server.Default().request("/event", { method: "POST" })
    await cancelBody(response)
    await settle()
    expect(spy).not.toHaveBeenCalled()
  })
})
