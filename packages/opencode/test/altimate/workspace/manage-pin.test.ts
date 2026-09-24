// altimate_change - new file
//
// `/workspace` Sync follows the IDE extension's pin. `Manage.sync` read only the on-disk link, so a
// `serve` pinned by the extension answered "not linked" for the workspace it was pinned to, while
// the per-write mirror (which resolves through the pin) sent to it. These cover which binding the
// sweep runs against; the sweep itself is covered by manage.test.ts and memory-sync.test.ts.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
import path from "node:path"
import os from "node:os"

const ORIGINAL_XDG_STATE_HOME = process.env.XDG_STATE_HOME
const ORIGINAL_PILOT = process.env.ALTIMATE_WORKSPACE
const SANDBOX = path.join(os.tmpdir(), `altimate-manage-pin-test-${process.pid}-${Date.now()}`)
mkdirSync(path.join(SANDBOX, "state"), { recursive: true })
process.env.XDG_STATE_HOME = path.join(SANDBOX, "state")

const { recordApprovedBinding, __resetPinValidation } = await import("../../../src/altimate/workspace/state")
const { sync } = await import("../../../src/altimate/workspace/manage")
const { resetEnablementMemoForTests } = await import("../../../src/altimate/workspace/memory-sync")
const { AltimateApi } = await import("../../../src/altimate/api/client")
const { WorkspaceApi } = await import("../../../src/altimate/workspace/api-client")

const ROOT = path.join(SANDBOX, "project")
const OUTSIDE = path.join(SANDBOX, "elsewhere")
mkdirSync(ROOT, { recursive: true })
mkdirSync(OUTSIDE, { recursive: true })

const originalIsConfigured = AltimateApi.isConfigured
const originalGetCreds = AltimateApi.getCredentials
const originalList = WorkspaceApi.listDatamates
type Creds = Awaited<ReturnType<typeof AltimateApi.getCredentials>>

const PIN_VARS = [
  "ALTIMATE_CODE_SERVE",
  "ALTIMATE_PINNED_WORKSPACE_ID",
  "ALTIMATE_PINNED_WORKSPACE_NAME",
  "ALTIMATE_PINNED_WORKSPACE_ROOT",
]

/** The pinned workspace has memory ON and the project's own link has it OFF, so the gate reason
 * says which of the two the sweep ran against. */
const WORKSPACES = [
  { id: 42, name: "pinned-workspace", memoryEnabled: true },
  { id: 7, name: "project-link", memoryEnabled: false },
]

function setPin(id = "42") {
  process.env.ALTIMATE_CODE_SERVE = "1"
  process.env.ALTIMATE_PINNED_WORKSPACE_ID = id
  process.env.ALTIMATE_PINNED_WORKSPACE_NAME = "pinned-workspace"
  process.env.ALTIMATE_PINNED_WORKSPACE_ROOT = ROOT
}

function clearPin() {
  for (const k of PIN_VARS) delete process.env[k]
}

async function seedLocalLink(directory = ROOT) {
  await recordApprovedBinding(directory, {
    datamateId: 7,
    datamateName: "project-link",
    linkedAt: Date.now(),
    repoRemote: "git@example.com:acme/project.git",
    projectPath: null,
  } as never)
}

beforeEach(() => {
  process.env.ALTIMATE_WORKSPACE = "1"
  __resetPinValidation()
  resetEnablementMemoForTests()
  ;(AltimateApi as unknown as { isConfigured: () => Promise<boolean> }).isConfigured = async () => true
  ;(AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials = async () =>
    ({ altimateInstanceName: "acme", altimateUrl: "https://api.test", altimateApiKey: "k" }) as Creds
  ;(WorkspaceApi as unknown as { listDatamates: () => Promise<unknown> }).listDatamates = async () => WORKSPACES
  clearPin()
})

afterEach(() => {
  clearPin()
})

afterAll(() => {
  ;(AltimateApi as unknown as { isConfigured: typeof originalIsConfigured }).isConfigured = originalIsConfigured
  ;(AltimateApi as unknown as { getCredentials: typeof originalGetCreds }).getCredentials = originalGetCreds
  ;(WorkspaceApi as unknown as { listDatamates: typeof originalList }).listDatamates = originalList
  if (ORIGINAL_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = ORIGINAL_XDG_STATE_HOME
  if (ORIGINAL_PILOT === undefined) delete process.env.ALTIMATE_WORKSPACE
  else process.env.ALTIMATE_WORKSPACE = ORIGINAL_PILOT
  rmSync(SANDBOX, { recursive: true, force: true })
})

describe("sync under an IDE pin", () => {
  test("runs against the pinned workspace in a project that was never linked", async () => {
    setPin()
    const report = await sync(ROOT)
    expect(report.gated).toBe(false)
    expect(report.gatedBecause).toBeUndefined()
  })

  test("the pin outranks the project's own link", async () => {
    await seedLocalLink()
    setPin()
    // The local link (7) has memory off and would gate; the pin (42) has it on.
    expect((await sync(ROOT)).gated).toBe(false)
  })

  test("a pin naming a workspace this account cannot see fails closed, not onto the local link", async () => {
    await seedLocalLink()
    setPin("99")
    const report = await sync(ROOT)
    expect(report.gated).toBe(true)
    expect(report.gatedBecause).toBe("no-binding")
  })

  test("a directory outside the pinned root is not treated as pinned", async () => {
    setPin()
    const report = await sync(OUTSIDE)
    expect(report.gated).toBe(true)
    expect(report.gatedBecause).toBe("no-binding")
  })
})

describe("sync without a pin", () => {
  test("still reads the project's own link", async () => {
    await seedLocalLink()
    const report = await sync(ROOT)
    // Reached the sweep with link 7, whose memory is off.
    expect(report.gated).toBe(true)
    expect(report.gatedBecause).toBe("memory-off")
  })

  test("an unlinked project is still gated on the missing binding", async () => {
    // A directory no test links: the binding cache is process-memoized, so `ROOT` may still hold one.
    const report = await sync(OUTSIDE)
    expect(report.gatedBecause).toBe("no-binding")
  })
})
