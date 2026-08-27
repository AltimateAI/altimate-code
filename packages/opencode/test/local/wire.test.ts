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

  // --no-egress-guard must only remove "ask" rules a prior `altimate local`
  // wiring actually set — never a value the user configured independently, and
  // never rules from a run that had the guard off in the first place.
  test("--no-egress-guard removes nothing when the guard was never applied", async () => {
    const home = await makeHome()
    const dir = path.join(home, ".config", "altimate-code")
    await fs.mkdir(dir, { recursive: true })
    // User (or some other tool) wrote "ask" rules directly, with no prior `altimate local` run.
    await fs.writeFile(
      path.join(dir, "altimate-code.json"),
      JSON.stringify({ permission: { websearch: "ask", webfetch: "ask" } }),
    )
    const wired = await wire(home, { egressGuard: false })
    const config = await readConfig(wired.file)
    expect(config.permission.websearch).toBe("ask")
    expect(config.permission.webfetch).toBe("ask")
  })

  test("--no-egress-guard removes nothing when the last wiring already had the guard off", async () => {
    const home = await makeHome()
    await wire(home, { egressGuard: false })
    const dir = path.join(home, ".config", "altimate-code")
    // Guard was never turned on, so nothing it owns exists — but simulate a
    // user-set "ask" value that must survive the (still off) --no-egress-guard run.
    const file = path.join(dir, "altimate-code.json")
    const contents = JSON.parse(await fs.readFile(file, "utf8"))
    contents.permission = { websearch: "ask" }
    await fs.writeFile(file, JSON.stringify(contents))
    const wired = await wire(home, { egressGuard: false })
    const config = await readConfig(wired.file)
    expect(config.permission.websearch).toBe("ask")
  })

  test("--no-egress-guard still removes guard-owned rules after a prior guard-on wiring", async () => {
    const home = await makeHome()
    await wire(home)
    const wired = await wire(home, { egressGuard: false })
    const config = await readConfig(wired.file)
    for (const key of EGRESS_PERMISSIONS) expect(config.permission?.[key]).toBeUndefined()
  })

  // Guard ownership is tracked per key (guarded_permissions), not just as a
  // boolean: a user rule the guard-on wiring SKIPPED adding (because it
  // already existed) must survive a later --no-egress-guard, even though the
  // guard was on and did add other keys.
  test("--no-egress-guard removes only the keys the guard actually added, keeping a user-set rule it skipped", async () => {
    const home = await makeHome()
    const dir = path.join(home, ".config", "altimate-code")
    await fs.mkdir(dir, { recursive: true })
    // User independently set websearch to "ask" before ever running `altimate local`.
    await fs.writeFile(path.join(dir, "altimate-code.json"), JSON.stringify({ permission: { websearch: "ask" } }))

    const on = await wire(home)
    expect(on.guarded).toEqual(["webfetch", "codesearch"]) // websearch skipped: already set

    const off = await wire(home, { egressGuard: false })
    const config = await readConfig(off.file)
    expect(config.permission.websearch).toBe("ask") // user's own rule survives
    expect(config.permission.webfetch).toBeUndefined() // guard-owned: removed
    expect(config.permission.codesearch).toBeUndefined() // guard-owned: removed
  })

  // Regression: a second guard-on run used to see every EGRESS_PERMISSIONS key already set to
  // "ask" (from the first run), skip re-adding all of them, and report `guarded: []` — which then
  // overwrote guarded_permissions in environment.json with an empty list. A later
  // --no-egress-guard read that empty list back as "the guard owns nothing" and removed nothing.
  test("--no-egress-guard still removes the rules after guard-on runs twice in a row", async () => {
    const home = await makeHome()
    const first = await wire(home)
    expect(first.guarded).toEqual([...EGRESS_PERMISSIONS])

    const second = await wire(home)
    expect(second.guarded).toEqual([...EGRESS_PERMISSIONS]) // ownership carried forward, not dropped

    const off = await wire(home, { egressGuard: false })
    const config = await readConfig(off.file)
    for (const key of EGRESS_PERMISSIONS) expect(config.permission?.[key]).toBeUndefined()
  })

  // A key a guard-on run carried forward as owned, but the user has since changed away from
  // "ask" (e.g. to "deny"), must not be re-claimed as guard-owned on the next guard-on run.
  test("a user override away from 'ask' drops that key from guard ownership on the next guard-on run", async () => {
    const home = await makeHome()
    const first = await wire(home)
    expect(first.guarded).toEqual([...EGRESS_PERMISSIONS])

    const dir = path.join(home, ".config", "altimate-code")
    const file = path.join(dir, "altimate-code.json")
    const contents = JSON.parse(await fs.readFile(file, "utf8"))
    contents.permission.webfetch = "deny"
    await fs.writeFile(file, JSON.stringify(contents))

    const second = await wire(home)
    expect(second.guarded).toEqual(["websearch", "codesearch"])

    const off = await wire(home, { egressGuard: false })
    const config = await readConfig(off.file)
    expect(config.permission.webfetch).toBe("deny") // user's override survives
    expect(config.permission.websearch).toBeUndefined()
    expect(config.permission.codesearch).toBeUndefined()
  })

  // The config schema accepts a bare `"permission": "deny"` shorthand string (normalized to
  // `{ "*": "deny" }` by ConfigPermissionV1's decoder), but wire.ts reads the raw JSON directly
  // and used to cast that string straight to a Record — Object.keys() on a string returns
  // character indices, and `key in permission` in resolveEgressAction throws on a primitive.
  test("a scalar permission shorthand (\"permission\": \"deny\") does not crash and is respected", async () => {
    const home = await makeHome()
    const dir = path.join(home, ".config", "altimate-code")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "altimate-code.json"), JSON.stringify({ permission: "deny" }))

    const wired = await wire(home)
    expect(wired.guarded).toEqual([]) // "*": "deny" already covers every egress key
    const config = await readConfig(wired.file)
    expect(config.permission).toBe("deny")

    const guard = await readEgressGuard({} as NodeJS.ProcessEnv, home)
    for (const key of EGRESS_PERMISSIONS) expect(guard[key]).toBe("deny")
  })

  test("respects a wildcard top-level rule instead of adding a more specific guard rule over it", async () => {
    const home = await makeHome()
    const dir = path.join(home, ".config", "altimate-code")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "altimate-code.json"), JSON.stringify({ permission: { "*": "deny" } }))
    const wired = await wire(home)
    expect(wired.guarded).toEqual([])
    const config = await readConfig(wired.file)
    expect(config.permission["*"]).toBe("deny")
    for (const key of EGRESS_PERMISSIONS) expect(config.permission[key]).toBeUndefined()
  })

  test("readEgressGuard resolves a wildcard rule instead of reporting allow (no rule)", async () => {
    const home = await makeHome()
    const dir = path.join(home, ".config", "altimate-code")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "altimate-code.json"), JSON.stringify({ permission: { "*": "deny" } }))
    const guard = await readEgressGuard({} as NodeJS.ProcessEnv, home)
    for (const key of EGRESS_PERMISSIONS) expect(guard[key]).toBe("deny")
  })
})

describe("wireLocalProvider config file precedence", () => {
  test("targets the higher-precedence .jsonc file when both .json and .jsonc already exist", async () => {
    const home = await makeHome()
    const dir = path.join(home, ".config", "altimate-code")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "altimate-code.json"), JSON.stringify({ model: "old-json" }))
    await fs.writeFile(path.join(dir, "altimate-code.jsonc"), JSON.stringify({}))
    const wired = await wire(home)
    // Config's own load order applies altimate-code.jsonc AFTER altimate-code.json,
    // so writes must land in .jsonc or they would be silently shadowed.
    expect(wired.file).toBe(path.join(dir, "altimate-code.jsonc"))
    const jsoncConfig = await readConfig(wired.file)
    expect(jsoncConfig.provider.local).toBeDefined()
    const jsonConfig = await readConfig(path.join(dir, "altimate-code.json"))
    expect(jsonConfig.provider).toBeUndefined()
  })
})

describe("wireLocalProvider agent tuning", () => {
  test("tunes the real 'builder' agent, not a phantom 'build' agent", async () => {
    const home = await makeHome()
    const wired = await wire(home)
    const config = await readConfig(wired.file)
    expect(config.agent.builder.temperature).toBe(TIER.agent.temperature)
    expect(config.agent.builder.options.reasoningEffort).toBe(TIER.agent.reasoning_effort)
    expect(config.agent.general.temperature).toBe(TIER.agent.temperature)
    expect(config.agent.build).toBeUndefined()
  })

  test("does not tune the shared builder/general agents when the user's cloud default model is kept", async () => {
    const home = await makeHome()
    const dir = path.join(home, ".config", "altimate-code")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "altimate-code.json"), JSON.stringify({ model: "anthropic/claude-sonnet-5" }))
    const wired = await wire(home)
    expect(wired.defaultModelIsLocal).toBe(false)
    const config = await readConfig(wired.file)
    expect(config.agent).toBeUndefined()
  })
})

describe("wireLocalProvider default model reporting", () => {
  test("reports the default model as local when it was unset (and got patched)", async () => {
    const home = await makeHome()
    const wired = await wire(home)
    expect(wired.defaultModelIsLocal).toBe(true)
  })

  test("reports the default model as local when it already pointed at this local model", async () => {
    const home = await makeHome()
    const dir = path.join(home, ".config", "altimate-code")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "altimate-code.json"), JSON.stringify({ model: "local/qwen3.8-27b" }))
    const wired = await wire(home)
    expect(wired.defaultModelIsLocal).toBe(true)
  })

  test("reports the default model as NOT local when the user's existing model is kept (never clobbered)", async () => {
    const home = await makeHome()
    const dir = path.join(home, ".config", "altimate-code")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "altimate-code.json"), JSON.stringify({ model: "anthropic/claude-sonnet-5" }))
    const wired = await wire(home)
    expect(wired.defaultModelIsLocal).toBe(false)
    const config = await readConfig(wired.file)
    expect(config.model).toBe("anthropic/claude-sonnet-5")
  })
})
