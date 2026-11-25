// altimate_change - new file
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { AltimateApi } from "../../../src/altimate/api/client"
import * as State from "../../../src/altimate/workspace/state"
import { WorkspaceByok } from "../../../src/altimate/workspace/byok"

const SECRET = "sk-workspace-secret-123"
const binding = { datamateId: 7, datamateName: "ws", repoRemote: null, projectPath: "/p", linkedAt: 1 }
const realFetch = globalThis.fetch
let spies: Array<{ mockRestore(): void }> = []
let output = ""

function capture() {
  const w = (c: any) => ((output += String(c)), true)
  spies.push(spyOn(process.stdout, "write").mockImplementation(w as any))
  spies.push(spyOn(process.stderr, "write").mockImplementation(w as any))
  for (const m of ["log", "info", "warn", "error", "debug"] as const)
    spies.push(spyOn(console, m).mockImplementation(((...a: any[]) => void (output += a.join(" "))) as any))
}

beforeEach(() => {
  output = ""
  capture()
  spies.push(spyOn(AltimateApi, "isConfigured").mockResolvedValue(true))
  spies.push(
    spyOn(AltimateApi, "getCredentials").mockResolvedValue({
      altimateUrl: "https://api.example.test",
      altimateInstanceName: "tenant",
      altimateApiKey: "gateway-key",
    } as any),
  )
  spies.push(spyOn(State, "readLocalBinding").mockResolvedValue(binding as any))
})
afterEach(() => {
  globalThis.fetch = realFetch
  spies.forEach((s) => s.mockRestore())
  spies = []
})

function respond(status: number, body?: unknown) {
  const f = mock(async (_url: any, _init?: any) => new Response(body === undefined ? "" : JSON.stringify(body), { status }))
  globalThis.fetch = f as any
  return f
}

const KEYS = {
  keys: [
    { provider: "anthropic", key: SECRET, created_at: "2026-01-01T00:00:00Z" },
    { provider: "openai", key: "  sk-openai-2  ", created_at: "2026-01-01T00:00:00Z" },
  ],
}

describe("WorkspaceByok", () => {
  test("returns each provider's key, pinned to the captured credential", async () => {
    const f = respond(200, KEYS)
    const out = await WorkspaceByok.resolve("/p")
    expect(out).toEqual({ anthropic: SECRET, openai: "sk-openai-2" })
    expect(String(f.mock.calls[0][0])).toBe("https://api.example.test/datamates/7/model-keys")
    expect(new Headers(f.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer gateway-key")
  })

  test("drops entries without a provider or a key", async () => {
    respond(200, { keys: [{ key: SECRET }, { provider: "x", key: "" }, { provider: "y" }, { provider: "z", api_key: SECRET }] })
    expect(await WorkspaceByok.resolve("/p")).toEqual({})
    respond(200, { keys: [] })
    expect(await WorkspaceByok.resolve("/p")).toEqual({})
    respond(200, {})
    expect(await WorkspaceByok.resolve("/p")).toEqual({})
  })

  test.each([404, 405, 500])("status %d leaves behaviour unchanged", async (status) => {
    respond(status, { detail: "nope" })
    expect(await WorkspaceByok.resolve("/p")).toEqual({})
  })

  test("network failure leaves behaviour unchanged", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("offline")
    }) as any
    expect(await WorkspaceByok.resolve("/p")).toEqual({})
  })

  test("unlinked project makes no request", async () => {
    ;(State.readLocalBinding as any).mockResolvedValue(null)
    const f = respond(200, KEYS)
    expect(await WorkspaceByok.resolve("/p")).toEqual({})
    expect(f).not.toHaveBeenCalled()
  })

  test("the keys are never logged or printed", async () => {
    respond(200, KEYS)
    await WorkspaceByok.resolve("/p")
    respond(500, { detail: SECRET })
    await WorkspaceByok.resolve("/p")
    expect(output).not.toContain(SECRET)
  })
})
