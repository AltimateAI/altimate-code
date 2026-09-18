// altimate_change - new file
//
// Runtime coverage for the IDE extension's pin inside `resolveBindingOutcome` — the one hook that
// makes the extension's selection govern skills and memory. `pin.test.ts` covers parsing; this
// covers precedence and the refusals, which is where the damage would be.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
import path from "node:path"
import os from "node:os"

const ORIGINAL_XDG_STATE_HOME = process.env.XDG_STATE_HOME
const SANDBOX = path.join(os.tmpdir(), `altimate-state-pin-test-${process.pid}-${Date.now()}`)
mkdirSync(path.join(SANDBOX, "state"), { recursive: true })
process.env.XDG_STATE_HOME = path.join(SANDBOX, "state")

const { resolveBindingOutcome, __resetPinValidation, PIN_VALIDATION_TTL_MS, PIN_STALE_IF_ERROR_MS } =
  await import("../../../src/altimate/workspace/state")
const { AltimateApi } = await import("../../../src/altimate/api/client")
const { WorkspaceApi, ForbiddenError, WorkspaceApiError } = await import(
  "../../../src/altimate/workspace/api-client"
)

const ROOT = path.join(SANDBOX, "project")
mkdirSync(ROOT, { recursive: true })

const originalIsConfigured = AltimateApi.isConfigured
const originalGetCreds = AltimateApi.getCredentials
const originalList = WorkspaceApi.listDatamates
type Creds = Awaited<ReturnType<typeof AltimateApi.getCredentials>>

function stubCreds(apiKey = "k") {
  ;(AltimateApi as unknown as { isConfigured: () => Promise<boolean> }).isConfigured = async () => true
  ;(AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials = async () =>
    ({ altimateInstanceName: "acme", altimateUrl: "https://api.test", altimateApiKey: apiKey }) as Creds
}

/** `listDatamates` rejecting with a specific error, for classifying refusals vs transport faults. */
function stubListError(err: unknown) {
  ;(WorkspaceApi as unknown as { listDatamates: () => Promise<unknown> }).listDatamates = async () => {
    throw err
  }
}

/** `listDatamates` verdict for a test: the rows it returns, or a thrown network failure. */
function stubList(rows: { id: number; name: string }[] | "unreachable") {
  ;(WorkspaceApi as unknown as { listDatamates: () => Promise<unknown> }).listDatamates = async () => {
    // What `api-client` actually throws when the host cannot be reached: a `WorkspaceApiError`
    // with no status. A plain `Error` would be classified as unclassifiable and fail closed —
    // correct behaviour, but it would not be simulating a transport failure.
    if (rows === "unreachable") throw new WorkspaceApiError("Cannot reach https://api.test: fetch failed")
    return rows
  }
}

function setPin(over: Record<string, string | undefined> = {}) {
  const base: Record<string, string | undefined> = {
    ALTIMATE_CODE_SERVE: "1",
    ALTIMATE_PINNED_WORKSPACE_ID: "237",
    ALTIMATE_PINNED_WORKSPACE_NAME: "activity_test",
    ALTIMATE_PINNED_WORKSPACE_ROOT: ROOT,
    ...over,
  }
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

const PIN_VARS = [
  "ALTIMATE_CODE_SERVE",
  "ALTIMATE_PINNED_WORKSPACE_ID",
  "ALTIMATE_PINNED_WORKSPACE_NAME",
  "ALTIMATE_PINNED_WORKSPACE_ROOT",
] as const

/** Captured once, before anything here touches them: the test process may itself have been
 * launched with a pin, and deleting unconditionally would strip it for every later suite. */
const ORIGINAL_PIN_ENV = Object.fromEntries(PIN_VARS.map((k) => [k, process.env[k]]))

function clearPin() {
  for (const k of PIN_VARS) delete process.env[k]
}

function restorePinEnv() {
  for (const k of PIN_VARS) {
    const v = ORIGINAL_PIN_ENV[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

/** Drives the module's validation clock so the TTL can be crossed without sleeping. */
let now = 1_000_000

beforeEach(() => {
  clearPin()
  now = 1_000_000
  __resetPinValidation(() => now)
  stubCreds()
  stubList([{ id: 237, name: "activity_test" }])
})

afterEach(() => clearPin())

afterAll(() => {
  restorePinEnv()
  __resetPinValidation()
  ;(AltimateApi as unknown as { isConfigured: typeof originalIsConfigured }).isConfigured =
    originalIsConfigured
  ;(AltimateApi as unknown as { getCredentials: typeof originalGetCreds }).getCredentials =
    originalGetCreds
  ;(WorkspaceApi as unknown as { listDatamates: typeof originalList }).listDatamates = originalList
  if (ORIGINAL_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = ORIGINAL_XDG_STATE_HOME
  rmSync(SANDBOX, { recursive: true, force: true })
})

describe("resolveBindingOutcome — extension pin", () => {
  test("a valid, account-visible pin binds, and is marked pinned", async () => {
    setPin()
    const out = await resolveBindingOutcome(ROOT)
    expect(out.status).toBe("bound")
    if (out.status !== "bound") return
    expect(out.binding.datamateId).toBe(237)
    expect(out.binding.pinned).toBe(true)
    // Never `adopted`: that is the marker for a binding the server volunteered, and it is what the
    // memory write guard keys on.
    expect(out.binding.adopted).toBeUndefined()
  })

  test("the server's name wins over a stale one in the environment", async () => {
    // The workspace can be renamed after the extension spawned this process.
    stubList([{ id: 237, name: "renamed_on_server" }])
    setPin({ ALTIMATE_PINNED_WORKSPACE_NAME: "old_name" })
    const out = await resolveBindingOutcome(ROOT)
    expect(out.status === "bound" && out.binding.datamateName).toBe("renamed_on_server")
  })

  test("a workspace the account cannot see fails closed", async () => {
    stubList([{ id: 999, name: "someone-elses" }])
    setPin()
    expect((await resolveBindingOutcome(ROOT)).status).toBe("unknown")
  })

  test("a directory outside the pinned root resolves nothing", async () => {
    // `serve` takes a per-request directory and runs unsecured; without this, another local caller
    // could have an unrelated tree's memory attributed to the pinned workspace.
    setPin()
    expect((await resolveBindingOutcome(path.join(SANDBOX, "elsewhere"))).status).toBe("unknown")
  })

  test("a partial pin fails closed rather than falling through to normal resolution", async () => {
    setPin({ ALTIMATE_PINNED_WORKSPACE_NAME: undefined })
    expect((await resolveBindingOutcome(ROOT)).status).toBe("unknown")
  })

  test("unreachable before ever validating is unknown — the env name is not authorization", async () => {
    stubList("unreachable")
    setPin()
    expect((await resolveBindingOutcome(ROOT)).status).toBe("unknown")
  })

  test("unreachable AFTER a successful validation keeps serving the pin, past the TTL", async () => {
    // The TTL must actually be crossed. Calling again immediately is a cache hit, so the earlier
    // version of this test passed even with the stale-on-error branch deleted.
    stubList([{ id: 237, name: "renamed_on_server" }])
    setPin({ ALTIMATE_PINNED_WORKSPACE_NAME: "old_env_name" })
    expect((await resolveBindingOutcome(ROOT)).status).toBe("bound")

    now += PIN_VALIDATION_TTL_MS + 1
    stubList("unreachable")
    const out = await resolveBindingOutcome(ROOT)
    expect(out.status).toBe("bound")
    // The server-confirmed name must survive, not regress to the environment's stale one.
    expect(out.status === "bound" && out.binding.datamateName).toBe("renamed_on_server")
  })

  test("an authorization failure fails closed even after a successful validation", async () => {
    setPin()
    expect((await resolveBindingOutcome(ROOT)).status).toBe("bound")

    now += PIN_VALIDATION_TTL_MS + 1
    // The REAL error the API throws for a 403. It carries no `status` field, which is exactly why
    // a status-based classifier mis-sorted it as transient.
    stubListError(new ForbiddenError())
    // A refusal is a real answer about access; only transport failures earn the offline grace.
    expect((await resolveBindingOutcome(ROOT)).status).toBe("unknown")
  })

  test("a real transport failure IS transient and keeps serving inside the window", async () => {
    setPin()
    expect((await resolveBindingOutcome(ROOT)).status).toBe("bound")

    now += PIN_VALIDATION_TTL_MS + 1
    // What `api-client` throws when the host cannot be reached: a WorkspaceApiError with no status.
    stubListError(new WorkspaceApiError("Cannot reach https://api.test: fetch failed"))
    expect((await resolveBindingOutcome(ROOT)).status).toBe("bound")
  })

  test("a 5xx IS transient", async () => {
    setPin()
    expect((await resolveBindingOutcome(ROOT)).status).toBe("bound")
    now += PIN_VALIDATION_TTL_MS + 1
    stubListError(new WorkspaceApiError("boom", 503))
    expect((await resolveBindingOutcome(ROOT)).status).toBe("bound")
  })

  test("the offline grace window is finite", async () => {
    setPin()
    expect((await resolveBindingOutcome(ROOT)).status).toBe("bound")

    now += PIN_STALE_IF_ERROR_MS + 1
    stubList("unreachable")
    // An endpoint that fails indefinitely must not grant an unbounded licence.
    expect((await resolveBindingOutcome(ROOT)).status).toBe("unknown")
  })

  test("a different credential in the same tenant does not inherit the authorization", async () => {
    setPin()
    expect((await resolveBindingOutcome(ROOT)).status).toBe("bound")

    // Same tenant and API URL, different key: the memo must not apply, so the new principal has to
    // demonstrate visibility itself — and here the server says it has none.
    stubCreds("different-key")
    stubList([{ id: 999, name: "not-yours" }])
    expect((await resolveBindingOutcome(ROOT)).status).toBe("unknown")
  })

  test("a validated pin is memoized — no probe per turn or per memory write", async () => {
    let calls = 0
    ;(WorkspaceApi as unknown as { listDatamates: () => Promise<unknown> }).listDatamates =
      async () => {
        calls++
        return [{ id: 237, name: "activity_test" }]
      }
    setPin()
    await resolveBindingOutcome(ROOT)
    await resolveBindingOutcome(ROOT)
    await resolveBindingOutcome(ROOT)
    expect(calls).toBe(1)
  })

  test("outside serve the pin is ignored entirely, so the TUI --workspace flow is untouched", async () => {
    setPin({ ALTIMATE_CODE_SERVE: undefined })
    // Falls through to ordinary resolution, which in this sandbox has no binding and no server.
    const out = await resolveBindingOutcome(ROOT)
    expect(out.status).not.toBe("bound")
  })
})
