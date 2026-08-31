// altimate_change - new file
//
// The "no usable engine" offer: which surface gets it, what the fallback
// emits when there is no surface, what the TUI re-derives, and the install
// path's gates and verification. Everything routes through `syncInternals`.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import {
  ENGINE_BINARY,
  ENGINE_PACKAGE,
  MIN_ENGINE_VERSION,
  beforeTurn,
  describeOffer,
  installCommand,
  installEngine,
  runInstall,
  installSpec,
  nodeMajor,
  DECLARED_RETRY_MS,
  resetForTests,
  settledOutcome,
  syncInternals,
  type EngineOffer,
  type Toast,
} from "../../../src/altimate/workspace/engine-overlay"
import { OFFER_RECHECK_MS, OFFER_SKIP_TTL_MS } from "../../../src/altimate/workspace/engine-offer"
import type { CachedBinding } from "../../../src/altimate/workspace/state"

const DIR = "/tmp/analytics"
const ORIGINAL_FLAG = process.env.ALTIMATE_WORKSPACE
const ORIGINAL_SPEC = process.env.ALTIMATE_ENGINE_INSTALL_SPEC

const binding: CachedBinding = {
  datamateId: 42,
  datamateName: "analytics",
  repoRemote: null,
  projectPath: DIR,
  linkedAt: 0,
} as CachedBinding

type Harness = { offers: EngineOffer[]; toasts: Toast[]; printed: string[]; published: number; publishedFor: string[] }

/** No engine on PATH (or an old one) plus captured surfaces. */
function install(opts: {
  which?: string | null
  version?: string | null
  declaredKeys?: string[]
  headless?: boolean
  bus?: boolean
  surface?: boolean
  bound?: boolean
}): Harness {
  const h: Harness = { offers: [], toasts: [], printed: [], published: 0, publishedFor: [] }
  process.env.ALTIMATE_WORKSPACE = "1"
  syncInternals.serve = () => false
  syncInternals.headless = () => opts.headless === true
  syncInternals.instanceDirectory = () => DIR
  syncInternals.resolveBinding = async () => (opts.bound === false ? null : binding)
  syncInternals.which = () => (opts.which === undefined ? null : opts.which)
  syncInternals.versionOf = async () => (opts.version === undefined ? null : opts.version)
  syncInternals.declared = async () => ({
    keys: opts.declaredKeys ?? ["dbt_build_model", "dbt_compile_model"],
    extensionKeys: [],
  })
  syncInternals.notify = async (toast) => {
    h.toasts.push(toast)
  }
  syncInternals.printLine = (line) => {
    h.printed.push(line)
  }
  syncInternals.publishOffer = async (sessionID) => {
    if (opts.bus === false) return false
    h.published += 1
    h.publishedFor.push(sessionID)
    return true
  }
  if (opts.surface) {
    syncInternals.offer = (offer) => {
      h.offers.push(offer)
      return true
    }
  }
  const config: { mcp?: Record<string, unknown> } = { mcp: {} }
  let loaded = false
  syncInternals.config = {
    invalidate: async () => {
      loaded = false
    },
    get: async () => {
      if (!loaded) {
        const { overlay } = await import("../../../src/altimate/workspace/engine-overlay")
        config.mcp = {}
        await overlay(DIR, config)
        loaded = true
      }
      return config
    },
  }
  syncInternals.mcp = {
    status: async () => ({ datamate: { status: "connected" } }),
    add: async () => {},
    remove: async () => {},
    tools: async () => ({}),
  }
  return h
}

beforeEach(() => resetForTests())
afterEach(() => {
  resetForTests()
  for (const key of Object.keys(syncInternals)) delete (syncInternals as Record<string, unknown>)[key]
  if (ORIGINAL_FLAG === undefined) delete process.env.ALTIMATE_WORKSPACE
  else process.env.ALTIMATE_WORKSPACE = ORIGINAL_FLAG
  if (ORIGINAL_SPEC === undefined) delete process.env.ALTIMATE_ENGINE_INSTALL_SPEC
  else process.env.ALTIMATE_ENGINE_INSTALL_SPEC = ORIGINAL_SPEC
})

describe("install command", () => {
  test("pins the minimum engine version by default", () => {
    delete process.env.ALTIMATE_ENGINE_INSTALL_SPEC
    expect(installSpec()).toBe(`${ENGINE_PACKAGE}@${MIN_ENGINE_VERSION}`)
    expect(installCommand()).toBe(`npm i -g ${ENGINE_PACKAGE}@${MIN_ENGINE_VERSION}`)
  })
  test("honours ALTIMATE_ENGINE_INSTALL_SPEC so E2E can point at a tarball", () => {
    process.env.ALTIMATE_ENGINE_INSTALL_SPEC = "/tmp/datamate.tgz"
    expect(installCommand()).toBe("npm i -g /tmp/datamate.tgz")
  })
})

describe("nodeMajor", () => {
  test("null when node is not on PATH", async () => {
    syncInternals.which = () => null
    expect(await nodeMajor()).toBeNull()
  })
})

describe("offer routing — engine missing", () => {
  test("a same-realm surface takes the offer and nothing else is emitted", async () => {
    const h = install({ surface: true })
    await beforeTurn("s1")
    expect(h.offers).toEqual([
      {
        reason: "engine-missing",
        workspaceId: "42",
        workspaceName: "analytics",
        declared: 2,
        command: installCommand(),
      },
    ])
    expect(h.published).toBe(0)
    expect(h.toasts).toEqual([])
    expect(h.printed).toEqual([])
    expect(settledOutcome("s1")).toEqual({ kind: "engine-missing", declared: 2 })
  })
  test("in a TUI the offer is published over the bus and nothing is printed or toasted", async () => {
    const h = install({})
    await beforeTurn("s1")
    expect(h.published).toBe(1)
    expect(h.toasts).toEqual([])
    expect(h.printed).toEqual([])
  })
  test("falls back to the toast only when the bus is unavailable", async () => {
    const h = install({ bus: false })
    await beforeTurn("s1")
    expect(h.published).toBe(0)
    expect(h.toasts).toHaveLength(1)
    expect(h.toasts[0].message).toContain(installCommand())
  })
  test("headless prints exactly one line naming workspace and command, and no toast", async () => {
    const h = install({ headless: true })
    await beforeTurn("s1")
    await beforeTurn("s1")
    expect(h.printed).toEqual([
      `Workspace "analytics": 2 integration tools need the local engine, which is not installed. Install it with: ${installCommand()}`,
    ])
    expect(h.toasts).toEqual([])
    expect(h.published).toBe(0)
  })
  test("singularises the tool count", async () => {
    const h = install({ headless: true, declaredKeys: ["dbt_build_model"] })
    await beforeTurn("s1")
    expect(h.printed[0]).toContain("1 integration tool needs")
  })
  test("the offer is raised once per session per verdict, naming the session it is for", async () => {
    const h = install({})
    await beforeTurn("s1")
    await beforeTurn("s1")
    expect(h.published).toBe(1)
    await beforeTurn("s2")
    expect(h.published).toBe(2)
    // An attached headless run reads every session's events for the directory
    // and prints only the offer raised for its own session.
    expect(h.publishedFor).toEqual(["s1", "s2"])
  })
  test("a session that outlives the Not-now latch is offered again", async () => {
    // The TUI re-checks its 7-day latch on every offer; the dedupe here must
    // not outlast that latch, or a long-lived session never sees the offer
    // return after "Not now" expires.
    let clock = 1_000_000
    syncInternals.now = () => clock
    const h = install({})
    await beforeTurn("s1")
    clock += OFFER_SKIP_TTL_MS - 1
    await beforeTurn("s1")
    expect(h.published).toBe(1)
    clock += 1
    await beforeTurn("s1")
    expect(h.published).toBe(2)
    await beforeTurn("s1")
    expect(h.published).toBe(2)
    // The latch runs from "Not now", which may come long after the offer was
    // raised, so once the window has passed the offer is re-raised hourly —
    // never held for another full window.
    clock += OFFER_RECHECK_MS - 1
    await beforeTurn("s1")
    expect(h.published).toBe(2)
    clock += 1
    await beforeTurn("s1")
    expect(h.published).toBe(3)
  })
  test("a count that arrives on a later turn does not re-raise the offer in the session", async () => {
    // Same verdict, better number: the dialog was already raised for it.
    const h = install({ surface: true })
    let clock = 1_000_000
    syncInternals.now = () => clock
    syncInternals.declared = async () => null
    await beforeTurn("s1")
    expect(h.offers).toHaveLength(1)
    expect(h.offers[0]).not.toHaveProperty("declared")
    clock += DECLARED_RETRY_MS + 1
    syncInternals.declared = async () => ({ keys: ["dbt_build_model", "dbt_compile_model"], extensionKeys: [] })
    await beforeTurn("s1")
    expect(h.offers).toHaveLength(1)
  })
  test("headless, two same-named workspaces in one process each print their line", async () => {
    // The title names the workspace, not its id; a second directory bound to
    // a different workspace with the same name is a different verdict.
    const h = install({ headless: true })
    await beforeTurn("s1")
    syncInternals.instanceDirectory = () => "/tmp/analytics-2"
    syncInternals.resolveBinding = async () => ({ ...binding, datamateId: 43, projectPath: "/tmp/analytics-2" })
    await beforeTurn("s2")
    expect(h.printed).toHaveLength(2)
  })
})

describe("offer routing — engine too old", () => {
  test("carries the found version and the update command", async () => {
    const h = install({ surface: true, which: "/usr/local/bin/datamate", version: "0.6.3" })
    await beforeTurn("s1")
    expect(h.offers).toEqual([
      {
        reason: "engine-too-old",
        workspaceId: "42",
        workspaceName: "analytics",
        declared: 2,
        found: "0.6.3",
        command: installCommand(),
      },
    ])
    expect(settledOutcome("s1")).toEqual({ kind: "engine-too-old", found: "0.6.3" })
  })
  test("headless, the printed line names the found version", async () => {
    const h = install({ headless: true, which: "/usr/local/bin/datamate", version: "0.6.3" })
    await beforeTurn("s1")
    expect(h.printed).toEqual([
      `Workspace "analytics": 2 integration tools need ${ENGINE_BINARY} ${MIN_ENGINE_VERSION}+ (found 0.6.3). Update with: ${installCommand()}`,
    ])
  })
  test("headless, a sub-agent's session in the same process prints nothing more", async () => {
    // One `run` is one process with one stderr: the task tool's child session
    // settles the same verdict and must not repeat the line.
    const h = install({ headless: true, which: "/usr/local/bin/datamate", version: "0.6.3" })
    await beforeTurn("parent")
    await beforeTurn("child")
    await beforeTurn("parent")
    expect(h.printed).toHaveLength(1)
  })
  test("headless, an unknown declared count is not printed as 0", async () => {
    const h = install({ headless: true })
    syncInternals.declared = async () => null
    await beforeTurn("s1")
    expect(h.printed).toEqual([
      `Workspace "analytics": its integration tools need the local engine, which is not installed. Install it with: ${installCommand()}`,
    ])
  })
  test("headless, a count that arrives with a later session's catalog prints nothing more", async () => {
    // The declared lookup can fail for the parent session and recover for the
    // task tool's child session once the retry window has passed. The verdict
    // is unchanged — only the number in the line — so the process still
    // prints once.
    const h = install({ headless: true })
    let clock = 1_000_000
    syncInternals.now = () => clock
    syncInternals.declared = async () => null
    await beforeTurn("parent")
    expect(h.printed).toHaveLength(1)
    clock += DECLARED_RETRY_MS + 1
    syncInternals.declared = async () => ({ keys: ["dbt_build_model", "dbt_compile_model"], extensionKeys: [] })
    await beforeTurn("child")
    expect(h.printed).toHaveLength(1)
  })
  test("a broken engine reports 'unknown' rather than a version", async () => {
    const h = install({ surface: true, which: "/usr/local/bin/datamate", version: null })
    await beforeTurn("s1")
    expect(h.offers[0]).toMatchObject({ reason: "engine-too-old", found: "unknown" })
  })
})

describe("offer is not raised when an engine is usable", () => {
  test("a healthy engine never reaches the offer path", async () => {
    const h = install({ surface: true, which: "/usr/local/bin/datamate", version: MIN_ENGINE_VERSION })
    await beforeTurn("s1")
    expect(h.offers).toEqual([])
    expect(h.published).toBe(0)
    expect(h.printed).toEqual([])
    expect(settledOutcome("s1")?.kind).toBe("attached")
  })
})

describe("describeOffer — the TUI re-derives its own detail", () => {
  test("describes a missing engine", async () => {
    install({})
    expect(await describeOffer(DIR)).toEqual({
      reason: "engine-missing",
      workspaceId: "42",
      workspaceName: "analytics",
      declared: 2,
      command: installCommand(),
    })
  })
  test("describes an engine below the floor, naming the version found", async () => {
    install({ which: "/usr/local/bin/datamate", version: "0.6.3" })
    expect(await describeOffer(DIR)).toMatchObject({ reason: "engine-too-old", found: "0.6.3" })
  })
  test("returns null when an engine already clears the floor", async () => {
    install({ which: "/usr/local/bin/datamate", version: MIN_ENGINE_VERSION })
    expect(await describeOffer(DIR)).toBeNull()
  })
  test("returns null when the project is not bound", async () => {
    install({ bound: false })
    expect(await describeOffer(DIR)).toBeNull()
  })
})

describe("headless notice stream", () => {
  test("the default printer writes to stderr, never stdout", async () => {
    const h = install({ headless: true })
    delete syncInternals.printLine
    const err = spyOn(process.stderr, "write").mockImplementation(() => true)
    const out = spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      await beforeTurn("s1")
      expect(err).toHaveBeenCalledTimes(1)
      expect(String(err.mock.calls[0]?.[0])).toContain(installCommand())
      expect(out).not.toHaveBeenCalled()
    } finally {
      err.mockRestore()
      out.mockRestore()
    }
    expect(h.printed).toEqual([])
  })
})

describe("install deadline", () => {
  const posix = process.platform !== "win32"
  test.skipIf(!posix)("settles on the child's exit even when a descendant keeps stderr open", async () => {
    // npm forks a tree; a straggler holding the pipe must not hold the run.
    const t0 = Date.now()
    const run = await runInstall(["sh", "-c", "sleep 5 >&2 2>/dev/null & exit 0"], 4_000, 200)
    expect(run.code).toBe(0)
    expect(run.timedOut).toBe(false)
    expect(Date.now() - t0).toBeLessThan(2_000)
  })
  test.skipIf(!posix)("the deadline terminates a tree that ignores SIGTERM and reports the timeout", async () => {
    const t0 = Date.now()
    const run = await runInstall(["sh", "-c", "trap '' TERM; sleep 30"], 200, 200)
    expect(run.timedOut).toBe(true)
    expect(Date.now() - t0).toBeLessThan(3_000)
  })
  test.skipIf(!posix)("a descendant that ignores SIGTERM is still killed after the leader exits", async () => {
    // npm (the leader) dies on the deadline's SIGTERM; the escalation must
    // survive its exit and reach the straggler.
    const marker = `31.${process.pid}`
    const run = await runInstall(["sh", "-c", `(trap '' TERM; exec sleep ${marker}) & sleep 30`], 200, 300)
    expect(run.timedOut).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 600))
    const survivors = Bun.spawnSync(["pgrep", "-f", `sleep ${marker}`])
      .stdout.toString()
      .trim()
    expect(survivors).toBe("")
  })
  test("a timed-out run is reported as such, not as an npm failure", async () => {
    syncInternals.runInstall = async () => ({ code: null, timedOut: true, stderr: "" })
    const result = await installEngine()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("did not finish within")
  })
})

describe("install success is verified, not assumed", () => {
  test("a zero exit with the engine still absent from PATH is a failure", async () => {
    syncInternals.which = () => null
    syncInternals.runInstall = async () => ({ code: 0, timedOut: false, stderr: "" })
    const result = await installEngine()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("not on PATH")
  })
  test("a zero exit with a below-floor engine on PATH is a failure", async () => {
    syncInternals.which = () => "/usr/local/bin/datamate"
    syncInternals.versionOf = async () => "0.6.3"
    syncInternals.runInstall = async () => ({ code: 0, timedOut: false, stderr: "" })
    const result = await installEngine()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("0.6.3")
  })
  test("a non-zero exit reports npm's last lines", async () => {
    syncInternals.runInstall = async () => ({ code: 1, timedOut: false, stderr: "boom\nEACCES denied" })
    expect(await installEngine()).toEqual({ ok: false, error: "boom EACCES denied" })
  })
})
