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

const { resolveBindingOutcome, __resetPinValidation } = await import(
  "../../../src/altimate/workspace/state"
)
const { AltimateApi } = await import("../../../src/altimate/api/client")
const { WorkspaceApi } = await import("../../../src/altimate/workspace/api-client")

const ROOT = path.join(SANDBOX, "project")
mkdirSync(ROOT, { recursive: true })

const originalIsConfigured = AltimateApi.isConfigured
const originalGetCreds = AltimateApi.getCredentials
const originalList = WorkspaceApi.listDatamates
type Creds = Awaited<ReturnType<typeof AltimateApi.getCredentials>>

function stubCreds() {
  ;(AltimateApi as unknown as { isConfigured: () => Promise<boolean> }).isConfigured = async () => true
  ;(AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials = async () =>
    ({ altimateInstanceName: "acme", altimateUrl: "https://api.test", altimateApiKey: "k" }) as Creds
}

/** `listDatamates` verdict for a test: the rows it returns, or a thrown network failure. */
function stubList(rows: { id: number; name: string }[] | "unreachable") {
  ;(WorkspaceApi as unknown as { listDatamates: () => Promise<unknown> }).listDatamates = async () => {
    if (rows === "unreachable") throw new Error("network down")
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

function clearPin() {
  for (const k of [
    "ALTIMATE_CODE_SERVE",
    "ALTIMATE_PINNED_WORKSPACE_ID",
    "ALTIMATE_PINNED_WORKSPACE_NAME",
    "ALTIMATE_PINNED_WORKSPACE_ROOT",
  ])
    delete process.env[k]
}

beforeEach(() => {
  clearPin()
  __resetPinValidation()
  stubCreds()
  stubList([{ id: 237, name: "activity_test" }])
})

afterEach(() => clearPin())

afterAll(() => {
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

  test("unreachable AFTER a successful validation keeps serving the pin", async () => {
    setPin()
    expect((await resolveBindingOutcome(ROOT)).status).toBe("bound")
    stubList("unreachable")
    const out = await resolveBindingOutcome(ROOT)
    expect(out.status).toBe("bound")
    expect(out.status === "bound" && out.binding.datamateId).toBe(237)
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
