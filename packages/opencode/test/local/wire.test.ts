import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parse } from "jsonc-parser"

import { readEgressGuard, wireLocalProvider, EGRESS_PERMISSIONS } from "../../src/local/wire"

const TIER = {
  ctx: 131072,
  parallel: 2,
  agent: { tool_retrieval: true, reasoning_effort: "medium" as const, temperature: 1 },
}

async function makeHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "altimate-wire-"))
  cleanup.push(home)
  return home
}

const cleanup: string[] = []
afterEach(async () => {
  while (cleanup.length) await fs.rm(cleanup.pop()!, { recursive: true, force: true })
})

function wire(home: string, overrides?: Partial<Parameters<typeof wireLocalProvider>[0]>) {
  return wireLocalProvider({
    baseURL: "http://127.0.0.1:42625/v1",
    modelID: "qwen3.8-27b",
    tier: TIER,
    env: {} as NodeJS.ProcessEnv,
    home,
    ...overrides,
  })
}

async function readConfig(file: string) {
  return parse(await fs.readFile(file, "utf8"), [], { allowTrailingComma: true }) as Record<string, any>
}

describe("wireLocalProvider egress guard", () => {
  test("adds ask rules for every network permission by default", async () => {
    const home = await makeHome()
    const wired = await wire(home)
    expect(wired.guarded).toEqual([...EGRESS_PERMISSIONS])
    const config = await readConfig(wired.file)
    for (const key of EGRESS_PERMISSIONS) expect(config.permission[key]).toBe("ask")
  })

  test("pins small_model to the local provider when unset", async () => {
    const home = await makeHome()
    const wired = await wire(home)
    const config = await readConfig(wired.file)
    expect(config.small_model).toBe("local/qwen3.8-27b")
  })

  test("never clobbers an existing user decision", async () => {
    const home = await makeHome()
    const dir = path.join(home, ".config", "altimate-code")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, "altimate-code.json"),
      JSON.stringify({ permission: { websearch: "allow" }, small_model: "anthropic/claude-haiku-4-5" }),
    )
    const wired = await wire(home)
    expect(wired.guarded).toEqual(["webfetch", "codesearch"])
    const config = await readConfig(wired.file)
    expect(config.permission.websearch).toBe("allow")
    expect(config.permission.webfetch).toBe("ask")
    expect(config.small_model).toBe("anthropic/claude-haiku-4-5")
  })

  test("egressGuard: false skips permission patches entirely", async () => {
    const home = await makeHome()
    const wired = await wire(home, { egressGuard: false })
    expect(wired.guarded).toEqual([])
    const config = await readConfig(wired.file)
    expect(config.permission).toBeUndefined()
  })

  test("readEgressGuard reports effective actions and no-rule fallback", async () => {
    const home = await makeHome()
    await wire(home)
    const guard = await readEgressGuard({} as NodeJS.ProcessEnv, home)
    for (const key of EGRESS_PERMISSIONS) expect(guard[key]).toBe("ask")

    const empty = await makeHome()
    const none = await readEgressGuard({} as NodeJS.ProcessEnv, empty)
    for (const key of EGRESS_PERMISSIONS) expect(none[key]).toBe("allow (no rule)")
  })

  test("guard is reversible: on → off → on", async () => {
    const home = await makeHome()
    const first = await wire(home)
    expect(first.guarded).toEqual([...EGRESS_PERMISSIONS])

    await wire(home, { egressGuard: false })
    const off = await readConfig(first.file)
    for (const key of EGRESS_PERMISSIONS) expect(off.permission?.[key]).toBeUndefined()

    const again = await wire(home)
    expect(again.guarded).toEqual([...EGRESS_PERMISSIONS])
    const on = await readConfig(first.file)
    for (const key of EGRESS_PERMISSIONS) expect(on.permission[key]).toBe("ask")
  })

  test("disabling the guard keeps custom user values", async () => {
    const home = await makeHome()
    const dir = path.join(home, ".config", "altimate-code")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "altimate-code.json"), JSON.stringify({ permission: { websearch: "deny" } }))
    const wired = await wire(home, { egressGuard: false })
    const config = await readConfig(wired.file)
    expect(config.permission.websearch).toBe("deny")
    expect(config.permission.webfetch).toBeUndefined()
  })

  test("wiring twice is idempotent", async () => {
    const home = await makeHome()
    const first = await wire(home)
    const before = await fs.readFile(first.file, "utf8")
    const second = await wire(home)
    expect(second.changed).toBe(false)
    expect(await fs.readFile(second.file, "utf8")).toBe(before)
  })
})
