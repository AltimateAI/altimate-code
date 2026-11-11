// altimate_change - new file
//
// The once-per-workspace-per-machine claim behind `first_prompt_sent` and `first_job_completed`.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Telemetry } from "../../../src/altimate/telemetry"
import { AltimateApi } from "../../../src/altimate/api/client"
import { claim, resetForTest } from "../../../src/altimate/workspace/first-events"

type Creds = Awaited<ReturnType<typeof AltimateApi.getCredentials>>

let stateHome = ""
let restore: (() => void)[] = []
const originalStateHome = process.env.OPENCODE_TEST_STATE_HOME

const signInTo = (tenant: string, key = "k") => {
  const creds = spyOn(AltimateApi, "getCredentials").mockImplementation(
    async () => ({ altimateInstanceName: tenant, altimateUrl: "https://api.test", altimateApiKey: key }) as Creds,
  )
  restore.push(() => creds.mockRestore())
}

beforeEach(() => {
  stateHome = mkdtempSync(path.join(os.tmpdir(), "first-events-state-"))
  process.env.OPENCODE_TEST_STATE_HOME = stateHome
  resetForTest()
  const enabled = spyOn(Telemetry, "isEnabled").mockImplementation(() => true)
  const configured = spyOn(AltimateApi, "isConfigured").mockImplementation(async () => true)
  restore = [() => enabled.mockRestore(), () => configured.mockRestore()]
  signInTo("acme")
})

afterEach(() => {
  for (const undo of restore) undo()
  if (originalStateHome === undefined) delete process.env.OPENCODE_TEST_STATE_HOME
  else process.env.OPENCODE_TEST_STATE_HOME = originalStateHome
  rmSync(stateHome, { recursive: true, force: true })
})

describe("first-event claim", () => {
  test("claims once, in this process and in the next", async () => {
    expect(await claim("first_prompt_sent", 7)).toBe(true)
    expect(await claim("first_prompt_sent", 7)).toBe(false)
    resetForTest()
    expect(await claim("first_prompt_sent", 7)).toBe(false)
  })

  test("each event and each workspace has its own claim", async () => {
    expect(await claim("first_prompt_sent", 7)).toBe(true)
    expect(await claim("first_job_completed", 7)).toBe(true)
    expect(await claim("first_prompt_sent", 8)).toBe(true)
  })

  test("two claims racing with no shared memory, as two processes would, get one claim", async () => {
    const first = claim("first_prompt_sent", 7)
    resetForTest()
    const results = await Promise.all([first, claim("first_prompt_sent", 7)])
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  test("the same id in another tenant is another workspace", async () => {
    expect(await claim("first_prompt_sent", 7)).toBe(true)
    restore.pop()?.()
    signInTo("other")
    expect(await claim("first_prompt_sent", 7)).toBe(true)
  })

  test("a second person on the machine is the same machine", async () => {
    expect(await claim("first_prompt_sent", 7)).toBe(true)
    restore.pop()?.()
    signInTo("acme", "another-key")
    expect(await claim("first_prompt_sent", 7)).toBe(false)
  })

  test("a claim given the turn's account is that tenant's, not the credential read at claim time", async () => {
    // The turn resolved its workspace under acme; the machine has signed in to another tenant since.
    restore.pop()?.()
    signInTo("other")
    expect(await claim("first_prompt_sent", 7, { tenant: "acme", apiUrl: "https://api.test" })).toBe(true)
    // The same id under the credential read now is another tenant's workspace, still unclaimed.
    expect(await claim("first_prompt_sent", 7)).toBe(true)
    restore.pop()?.()
    signInTo("acme")
    expect(await claim("first_prompt_sent", 7)).toBe(false)
  })

  test("nothing is claimed while telemetry is off, so opting back in can still send", async () => {
    const off = spyOn(Telemetry, "isEnabled").mockImplementation(() => false)
    expect(await claim("first_prompt_sent", 7)).toBe(false)
    off.mockImplementation(() => true)
    expect(await claim("first_prompt_sent", 7)).toBe(true)
  })

  test("nothing is claimed with no account", async () => {
    restore.pop()?.()
    const none = spyOn(AltimateApi, "getCredentials").mockImplementation(async () => {
      throw new Error("no credentials")
    })
    restore.push(() => none.mockRestore())
    expect(await claim("first_prompt_sent", 7)).toBe(false)
  })

  test("a mark that can't be written claims nothing, and the next turn tries again", async () => {
    const blocked = path.join(stateHome, "altimate-workspace-first-events")
    writeFileSync(blocked, "not a directory")
    expect(await claim("first_prompt_sent", 7)).toBe(false)
    rmSync(blocked)
    expect(await claim("first_prompt_sent", 7)).toBe(true)
  })
})
