// altimate_change — regression test for the server-side wiring that produces `client_connected`.
//
// The telemetry unit tests (test/altimate/telemetry/first-run-health.test.ts) prove the
// `Telemetry.clientConnected()` latch, but nothing exercised the `.use` middleware in
// `Server.createApp` that actually calls it. Without this test, deleting the middleware, changing
// the `/event` / `/global/event` path literals, dropping the `GET` guard, or moving the hook ahead
// of basicAuth would all leave the suite green while silently killing the IDE-funnel signal.
//
// The middleware fires `void import("../altimate/telemetry").then((m) => m.Telemetry.clientConnected())`
// after next() is set up, so the call lands on a later microtask; each case waits a tick before
// asserting. We spy on `Telemetry.clientConnected` itself (not `track`) so the assertion is purely
// about the middleware deciding to call it — the once-per-process latch lives inside that function
// and is covered elsewhere.
//
// These cases catch deleting the middleware, changing the `/event` / `/global/event` path literals,
// and dropping the `GET` guard. The remaining regression the reviewer named — moving the hook above
// basicAuth so unauthenticated probes count — is not exercised here: auth is enforced by a separate
// `basicAuth` middleware gated on `Flag.OPENCODE_SERVER_PASSWORD`, which is a module-level const
// frozen at load (flag.ts), and CI runs the package in one Bun process, so a password set at test
// time can't drive basicAuth to 401. The ordering is enforced structurally: this hook is registered
// immediately after the basicAuth `.use` in `Server.createApp`.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Server } from "../../src/server/server"
import { Telemetry } from "../../src/altimate/telemetry"
import { resetDatabase } from "./db"
import { disposeAllInstances } from "../fixture/fixture"

const tick = () => new Promise((r) => setTimeout(r, 15))

async function cancelBody(response: Response) {
  await response.body?.cancel().catch(() => {})
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
  test("GET /event invokes Telemetry.clientConnected", async () => {
    const response = await Server.Default().request("/event")
    await cancelBody(response)
    await tick()
    expect(spy).toHaveBeenCalled()
  })

  test("GET /global/event invokes Telemetry.clientConnected", async () => {
    const response = await Server.Default().request("/global/event")
    await cancelBody(response)
    await tick()
    expect(spy).toHaveBeenCalled()
  })

  test("a non-event path does not invoke Telemetry.clientConnected", async () => {
    const response = await Server.Default().request("/config")
    await cancelBody(response)
    await tick()
    expect(spy).not.toHaveBeenCalled()
  })

  test("a non-GET request to /event does not invoke Telemetry.clientConnected", async () => {
    const response = await Server.Default().request("/event", { method: "POST" })
    await cancelBody(response)
    await tick()
    expect(spy).not.toHaveBeenCalled()
  })
})
