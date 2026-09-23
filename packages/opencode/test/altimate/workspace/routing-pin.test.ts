// altimate_change - new file
//
// The IDE extension's pin governs warehouse tool ROUTING, not just identity, skills and memory.
//
// `state-pin.test.ts` covers the pin inside `resolveBindingOutcome`, which is what skills, memory
// and the identity section read. Routing reads elsewhere — `engine-probes.resolveBinding` and
// `precedence.currentBinding` went straight to the on-disk cache — so a pinned session could name
// one workspace in the identity section and route warehouse calls at another (#1337). These cover
// the routing side of that precedence, and the refusal, which is where the damage would be.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
import path from "node:path"
import os from "node:os"

const ORIGINAL_XDG_STATE_HOME = process.env.XDG_STATE_HOME
const SANDBOX = path.join(os.tmpdir(), `altimate-routing-pin-test-${process.pid}-${Date.now()}`)
mkdirSync(path.join(SANDBOX, "state"), { recursive: true })
process.env.XDG_STATE_HOME = path.join(SANDBOX, "state")

const { resolvePinnedBindingForRouting, recordApprovedBinding, __resetPinValidation } = await import(
  "../../../src/altimate/workspace/state"
)
const { resolveBinding } = await import("../../../src/altimate/workspace/engine-probes")
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

function stubList(rows: { id: number; name: string }[]) {
  ;(WorkspaceApi as unknown as { listDatamates: () => Promise<unknown> }).listDatamates = async () => rows
}

const PIN_VARS = [
  "ALTIMATE_CODE_SERVE",
  "ALTIMATE_PINNED_WORKSPACE_ID",
  "ALTIMATE_PINNED_WORKSPACE_NAME",
  "ALTIMATE_PINNED_WORKSPACE_ROOT",
]

function setPin(over: Record<string, string | undefined> = {}) {
  const base: Record<string, string | undefined> = {
    ALTIMATE_CODE_SERVE: "1",
    ALTIMATE_PINNED_WORKSPACE_ID: "42",
    ALTIMATE_PINNED_WORKSPACE_NAME: "pinned-workspace",
    ALTIMATE_PINNED_WORKSPACE_ROOT: ROOT,
    ...over,
  }
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

function clearPin() {
  for (const k of PIN_VARS) delete process.env[k]
}

/** The project's own link, naming a DIFFERENT workspace than the pin — the returning-user case
 * from the report, where identity said one id and routing said another. */
async function seedLocalLink(datamateId = 7, datamateName = "project-link") {
  await recordApprovedBinding(ROOT, {
    datamateId,
    datamateName,
    linkedAt: Date.now(),
    repoRemote: "git@example.com:acme/project.git",
    // Both identity keys are written explicitly: the strict reader rejects a row where either is
    // `undefined` (it accepts `string | null`), so omitting one produces a cache the routing read
    // cannot parse — which looks like a product failure in a test that is only mis-seeded.
    projectPath: null,
  } as never)
}

beforeEach(() => {
  __resetPinValidation()
  stubCreds()
  stubList([
    { id: 42, name: "pinned-workspace" },
    { id: 7, name: "project-link" },
  ])
  clearPin()
})

afterEach(() => {
  clearPin()
  __resetPinValidation()
})

afterAll(() => {
  ;(AltimateApi as unknown as { isConfigured: unknown }).isConfigured = originalIsConfigured
  ;(AltimateApi as unknown as { getCredentials: unknown }).getCredentials = originalGetCreds
  ;(WorkspaceApi as unknown as { listDatamates: unknown }).listDatamates = originalList
  if (ORIGINAL_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = ORIGINAL_XDG_STATE_HOME
  rmSync(SANDBOX, { recursive: true, force: true })
})

describe("resolvePinnedBindingForRouting", () => {
  test("answers null with no pin, so unpinned sessions keep reading their own link", async () => {
    expect(await resolvePinnedBindingForRouting(ROOT)).toBeNull()
  })

  test("returns the pinned workspace when the account can see it", async () => {
    setPin()
    const outcome = await resolvePinnedBindingForRouting(ROOT)
    expect(outcome?.status).toBe("bound")
    expect(outcome?.status === "bound" && outcome.binding.datamateId).toBe(42)
  })

  test("refuses a malformed pin rather than falling through to the project's link", async () => {
    setPin({ ALTIMATE_PINNED_WORKSPACE_ID: "not-a-number" })
    expect((await resolvePinnedBindingForRouting(ROOT))?.status).toBe("unknown")
  })

  test("refuses a pin naming a workspace this account cannot see", async () => {
    stubList([{ id: 7, name: "project-link" }])
    setPin()
    expect((await resolvePinnedBindingForRouting(ROOT))?.status).toBe("unknown")
  })

  test("refuses a pin for a directory outside the pinned root", async () => {
    setPin()
    expect((await resolvePinnedBindingForRouting(path.join(SANDBOX, "elsewhere")))?.status).toBe("unknown")
  })
})

describe("engine-probes.resolveBinding — the routing read", () => {
  test("routes at the pin, not the project's own link", async () => {
    await seedLocalLink(7)
    setPin()
    const read = await resolveBinding(ROOT)
    expect(read.kind).toBe("bound")
    // The regression: this returned 7 — the identity section said 42 in the same prompt.
    expect(read.kind === "bound" && read.binding.datamateId).toBe(42)
  })

  test("still reads the project's own link when nothing is pinned", async () => {
    await seedLocalLink(7)
    const read = await resolveBinding(ROOT)
    expect(read.kind).toBe("bound")
    expect(read.kind === "bound" && read.binding.datamateId).toBe(7)
  })

  test("fails closed when the pin cannot be honoured, rather than routing at the project's link", async () => {
    await seedLocalLink(7)
    stubList([{ id: 7, name: "project-link" }])
    setPin()
    const read = await resolveBinding(ROOT)
    // Not `bound` at 7: falling back to the project's link is the confusion this prevents.
    expect(read.kind).toBe("failed")
  })

  test("carries the credential scope so the engine key stays account-partitioned", async () => {
    setPin()
    const read = await resolveBinding(ROOT)
    expect(read.kind === "bound" && read.binding.scope).toBe("acme|https://api.test")
  })
})
