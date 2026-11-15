// altimate_change - new file
//
// `GET /altimate/provider/subscriptions`: the welcome picker's subscription suggestions. Covers the
// route only, with detection stubbed; detection itself is covered by
// test/altimate/provider/subscriptions.test.ts.
import { afterEach, expect, spyOn, test } from "bun:test"
import { Server } from "../../src/server/server"
import * as Subscriptions from "../../src/altimate/provider/subscriptions"

const ORIGINAL_FLAG = process.env.ALTIMATE_DISABLE_WORKSPACE
let spies: Array<{ mockRestore: () => void }> = []

afterEach(() => {
  for (const spy of spies) spy.mockRestore()
  spies = []
  if (ORIGINAL_FLAG === undefined) delete process.env.ALTIMATE_DISABLE_WORKSPACE
  else process.env.ALTIMATE_DISABLE_WORKSPACE = ORIGINAL_FLAG
})

const get = (headers: Record<string, string> = {}) =>
  Server.Default().request("/altimate/provider/subscriptions", { headers })

test("works with the workspace feature turned off", async () => {
  process.env.ALTIMATE_DISABLE_WORKSPACE = "1"
  spies.push(spyOn(Subscriptions, "detect").mockResolvedValue([{ subscription: "claude", source: "claude-code" }]))
  spies.push(spyOn(Subscriptions, "retiredAnthropicLogin").mockResolvedValue(false))
  const response = await get()
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    ok: true,
    found: [{ subscription: "claude", source: "claude-code" }],
    retiredAnthropicLogin: false,
  })
})

test("reports an old Anthropic login even when a Claude Code login is found", async () => {
  spies.push(spyOn(Subscriptions, "detect").mockResolvedValue([{ subscription: "claude", source: "claude-code" }]))
  spies.push(spyOn(Subscriptions, "retiredAnthropicLogin").mockResolvedValue(true))
  const response = await get()
  expect(((await response.json()) as { retiredAnthropicLogin: boolean }).retiredAnthropicLogin).toBe(true)
})

test("a detection failure answers none found", async () => {
  spies.push(spyOn(Subscriptions, "detect").mockRejectedValue(new Error("boom")))
  const response = await get()
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true, found: [], retiredAnthropicLogin: false })
})

test("a cross-site browser request is refused", async () => {
  const detect = spyOn(Subscriptions, "detect").mockResolvedValue([])
  spies.push(detect)
  const response = await get({ "sec-fetch-site": "cross-site" })
  expect(response.status).toBe(403)
  expect(detect).not.toHaveBeenCalled()
})
