import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { FreeTier } from "../../src/altimate/free/client"
import { FreeTierConsent } from "../../src/altimate/free/consent"
import { FreeTierStore } from "../../src/altimate/free/store"
import { isolateAltimateBaseHome } from "./_fixtures/altimate-base-harness"

isolateAltimateBaseHome("altimate-base-headless-disclosure")

// The headless notice (`run`, `serve`, `acp`, `web`) must reach a user whose registration finished
// in the background after the startup wait: that launch reported "pending" and every later launch
// reports "already registered", so neither passes `justRegistered`.
const marker = () => path.join(path.dirname(FreeTierStore.credentialPath()), "altimate-base-disclosure-shown.json")

describe("FreeTierConsent.printDisclosureOnceForHeadless", () => {
  let stderr: ReturnType<typeof spyOn>
  let registered: ReturnType<typeof spyOn>

  beforeEach(async () => {
    await fs.rm(marker(), { force: true })
    stderr = spyOn(console, "error").mockImplementation(() => {})
  })
  afterEach(async () => {
    stderr.mockRestore()
    registered?.mockRestore()
    await fs.rm(marker(), { force: true })
  })

  test("prints once when Base was registered by an earlier, backgrounded attempt", async () => {
    registered = spyOn(FreeTier, "isRegistered").mockResolvedValue(true)
    await FreeTierConsent.printDisclosureOnceForHeadless(false)
    await FreeTierConsent.printDisclosureOnceForHeadless(false)
    expect(stderr).toHaveBeenCalledTimes(1)
    expect(String(stderr.mock.calls[0]?.[0])).toStartWith("Altimate Base: ")
  })

  test("prints nothing while Base is not registered", async () => {
    registered = spyOn(FreeTier, "isRegistered").mockResolvedValue(false)
    await FreeTierConsent.printDisclosureOnceForHeadless(false)
    expect(stderr).not.toHaveBeenCalled()
  })
})
