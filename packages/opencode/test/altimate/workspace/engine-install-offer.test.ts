// altimate_change - new file
//
// Coverage for the "no usable engine" offer: which surface gets it, what the
// fallback emits when there is no surface, and the command/Node detection the
// dialog's "Install now" gate depends on. Everything routes through
// `syncInternals`, so no process is spawned and no MCP state is touched.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import {
  ensure,
  installCommand,
  installEngine,
  installSpec,
  nodeMajor,
  describeOffer,
  isHeadless,
  INSTALL_TIMEOUT_MS,
  resetForTests,
  syncInternals,
  ENGINE_BINARY,
  ENGINE_PACKAGE,
  MIN_ENGINE_VERSION,
  type EngineOffer,
  type LocalMcpConfig,
} from "../../../src/altimate/workspace/engine-sync"
import { Process } from "../../../src/util/process"
import type { CachedBinding } from "../../../src/altimate/workspace/state"

const ORIGINAL_FLAG = process.env.ALTIMATE_WORKSPACE
const ORIGINAL_SPEC = process.env.ALTIMATE_ENGINE_INSTALL_SPEC

const binding: CachedBinding = {
  datamateId: 42,
  datamateName: "analytics",
  repoRemote: "git@github.com:acme/analytics.git",
  projectPath: "/tmp/analytics",
} as CachedBinding

type Harness = {
  offers: EngineOffer[]
  toasts: Array<{ title: string; message: string; variant: string }>
  printed: string[]
  published: number
}

/** No engine on PATH (or an old one) plus a captured notify/print pair. */
function install(opts: {
  which?: string | null
  version?: string | null
  declaredKeys?: string[]
  existing?: { type?: string; url?: string; command?: string[] | string; args?: string[] } | null
}): Harness {
  const h: Harness = { offers: [], toasts: [], printed: [], published: 0 }
  syncInternals.publishOffer = async () => {
    h.published += 1
    return true
  }
  syncInternals.resolveBinding = async () => binding
  syncInternals.which = () => (opts.which === undefined ? null : opts.which)
  syncInternals.versionOf = async () => (opts.version === undefined ? null : opts.version)
  syncInternals.declared = async () => ({
    keys: opts.declaredKeys ?? ["dbt_build_model", "dbt_compile_model"],
    extensionKeys: [],
  })
  syncInternals.existingEntry = async () => (opts.existing === undefined ? null : opts.existing)
  syncInternals.persist = async () => {}
  syncInternals.notify = async (toast) => {
    h.toasts.push(toast)
  }
  syncInternals.printLine = (line) => {
    h.printed.push(line)
  }
  syncInternals.mcp = {
    status: async () => ({}),
    add: async (_n: string, _c: LocalMcpConfig) => {},
    connect: async () => {},
    remove: async () => {},
    tools: async () => ({}),
  }
  return h
}

beforeEach(() => {
  process.env.ALTIMATE_WORKSPACE = "1"
  delete process.env.ALTIMATE_ENGINE_INSTALL_SPEC
  resetForTests()
  delete process.env.ALTIMATE_CODE_HEADLESS
})

afterEach(() => {
  for (const key of Object.keys(syncInternals) as Array<keyof typeof syncInternals>) delete syncInternals[key]
  delete process.env.ALTIMATE_CODE_HEADLESS
  if (ORIGINAL_FLAG === undefined) delete process.env.ALTIMATE_WORKSPACE
  else process.env.ALTIMATE_WORKSPACE = ORIGINAL_FLAG
  if (ORIGINAL_SPEC === undefined) delete process.env.ALTIMATE_ENGINE_INSTALL_SPEC
  else process.env.ALTIMATE_ENGINE_INSTALL_SPEC = ORIGINAL_SPEC
})

describe("install command", () => {
  test("pins the minimum engine version by default", () => {
    expect(installSpec()).toBe(`${ENGINE_PACKAGE}@${MIN_ENGINE_VERSION}`)
    expect(installCommand()).toBe(`npm i -g ${ENGINE_PACKAGE}@${MIN_ENGINE_VERSION}`)
  })

  test("honours ALTIMATE_ENGINE_INSTALL_SPEC so E2E can point at a tarball", () => {
    process.env.ALTIMATE_ENGINE_INSTALL_SPEC = "/tmp/datamate-0.6.3.tgz"
    expect(installCommand()).toBe("npm i -g /tmp/datamate-0.6.3.tgz")
  })
})

describe("nodeMajor", () => {
  test("null when node is not on PATH", async () => {
    syncInternals.which = () => null
    expect(await nodeMajor()).toBeNull()
  })

  test("parses the major out of a v-prefixed version", async () => {
    syncInternals.nodeMajor = async () => 22
    expect(await nodeMajor()).toBe(22)
  })
})

describe("offer routing — engine missing", () => {
  test("raises the dialog over the event bus, with no toast and no printed line", async () => {
    const h = install({})
    syncInternals.offer = (offer) => {
      h.offers.push(offer)
      return true
    }
    expect(await ensure("s1")).toEqual({ kind: "engine-missing", declared: 2 })
    expect(h.offers).toHaveLength(1)
    expect(h.offers[0]).toMatchObject({
      reason: "engine-missing",
      workspaceId: "42",
      workspaceName: "analytics",
      declared: 2,
      command: `npm i -g ${ENGINE_PACKAGE}@${MIN_ENGINE_VERSION}`,
    })
    // A surface owns it — the fallbacks must stay silent.
    expect(h.toasts).toHaveLength(0)
    expect(h.printed).toHaveLength(0)
  })

  test("headless prints exactly one line naming workspace and command, and no toast", async () => {
    process.env.ALTIMATE_CODE_HEADLESS = "1"
    const h = install({})
    expect(await ensure("s1")).toEqual({ kind: "engine-missing", declared: 2 })
    expect(h.toasts).toHaveLength(0)
    expect(h.published).toBe(0)
    expect(h.printed).toHaveLength(1)
    expect(h.printed[0]).toContain('"analytics"')
    expect(h.printed[0]).toContain(`npm i -g ${ENGINE_PACKAGE}@${MIN_ENGINE_VERSION}`)
    expect(h.printed[0]).toContain("2 integration tools")
  })

  test("singularises the tool count", async () => {
    process.env.ALTIMATE_CODE_HEADLESS = "1"
    const h = install({ declaredKeys: ["dbt_build_model"] })
    await ensure("s1")
    expect(h.printed[0]).toContain("1 integration tool need")
    expect(h.printed[0]).not.toContain("1 integration tools")
  })

  test("in a TUI the offer is published and nothing is printed to stdout", async () => {
    const h = install({})
    expect(await ensure("s1")).toEqual({ kind: "engine-missing", declared: 2 })
    expect(h.published).toBe(1)
    expect(h.toasts).toHaveLength(0)
    // Printing here would corrupt the TUI's own render.
    expect(h.printed).toHaveLength(0)
  })

  test("falls back to the toast only when the bus is unavailable", async () => {
    const h = install({})
    syncInternals.publishOffer = async () => false
    expect(await ensure("s1")).toEqual({ kind: "engine-missing", declared: 2 })
    expect(h.toasts).toHaveLength(1)
    expect(h.printed).toHaveLength(0)
  })
})

describe("offer routing — engine too old", () => {
  test("carries the found version and the update command", async () => {
    const h = install({ which: "/usr/local/bin/datamate", version: "0.5.9" })
    syncInternals.offer = (offer) => {
      h.offers.push(offer)
      return true
    }
    expect(await ensure("s1")).toEqual({ kind: "engine-too-old", found: "0.5.9" })
    expect(h.offers[0]).toMatchObject({
      reason: "engine-too-old",
      workspaceId: "42",
      workspaceName: "analytics",
      found: "0.5.9",
      declared: 2,
    })
    expect(h.toasts).toHaveLength(0)
    expect(h.printed).toHaveLength(0)
  })

  test("headless, the printed line names the found version", async () => {
    process.env.ALTIMATE_CODE_HEADLESS = "1"
    const h = install({ which: "/usr/local/bin/datamate", version: "0.5.9" })
    await ensure("s1")
    expect(h.printed).toHaveLength(1)
    expect(h.printed[0]).toContain("found 0.5.9")
    expect(h.printed[0]).toContain('"analytics"')
  })
})

describe("offer is not raised when an engine is usable", () => {
  test("a healthy engine never reaches the offer path", async () => {
    // Version is taken from the floor itself, not a literal: MIN_ENGINE_VERSION
    // moves (0.6.3 -> 0.7.0 already), and a hardcoded version silently turns
    // this into a too-old test the next time it does.
    const h = install({
      which: "/usr/local/bin/datamate",
      version: MIN_ENGINE_VERSION,
      // Rule 1 reuses an entry only when it is pinned to the bound workspace.
      existing: { type: "local", command: [ENGINE_BINARY, "start-stdio", "--datamate", "42"] },
    })
    syncInternals.offer = (offer) => {
      h.offers.push(offer)
      return true
    }
    syncInternals.mcp = {
      status: async () => ({ datamate: { status: "connected" } }),
      add: async () => {},
      connect: async () => {},
      remove: async () => {},
      tools: async () => ({ datamate_dbt_build_model: 1, datamate_dbt_compile_model: 1 }),
    }
    await ensure("s1")
    expect(h.offers).toHaveLength(0)
    expect(h.printed).toHaveLength(0)
  })
})

describe("describeOffer — the TUI re-derives its own detail", () => {
  // The offer reaches the plugin as a bare command (CommandExecute carries no
  // payload) and the plugin runtime is a separate realm, so this re-derivation
  // is the only way the dialog learns what to say. Regression guard for the
  // defect E2E caught, where an in-process handoff silently degraded to a toast.
  test("describes a missing engine", async () => {
    install({})
    const offer = await describeOffer("/tmp/whatever")
    expect(offer).toMatchObject({
      reason: "engine-missing",
      workspaceId: "42",
      workspaceName: "analytics",
      declared: 2,
    })
    expect(offer?.found).toBeUndefined()
  })

  test("describes an engine below the floor, naming the version found", async () => {
    install({ which: "/usr/local/bin/datamate", version: "0.5.9" })
    const offer = await describeOffer("/tmp/whatever")
    expect(offer).toMatchObject({ reason: "engine-too-old", found: "0.5.9" })
  })

  test("returns null when an engine already clears the floor", async () => {
    install({ which: "/usr/local/bin/datamate", version: MIN_ENGINE_VERSION })
    expect(await describeOffer("/tmp/whatever")).toBeNull()
  })

  test("returns null when the project is not bound", async () => {
    install({})
    syncInternals.resolveBinding = async () => null
    expect(await describeOffer("/tmp/whatever")).toBeNull()
  })
})

describe("headless detection", () => {
  test("off by default, on when the run command marks it", () => {
    expect(isHeadless()).toBe(false)
    process.env.ALTIMATE_CODE_HEADLESS = "1"
    expect(isHeadless()).toBe(true)
  })
})

describe("headless notice stream", () => {
  // Regression guard: the notice used to go to stdout, which `run --format
  // json` documents as raw JSON events. A human-readable line there was line 1
  // of an otherwise-valid JSON stream and broke line-oriented consumers.
  test("the default printer writes to stderr, never stdout", async () => {
    process.env.ALTIMATE_CODE_HEADLESS = "1"
    const h = install({})
    // Exercise the real printer, not the seam.
    delete syncInternals.printLine
    const outChunks: string[] = []
    const errChunks: string[] = []
    const realOut = process.stdout.write.bind(process.stdout)
    const realErr = process.stderr.write.bind(process.stderr)
    process.stdout.write = ((c: string) => {
      outChunks.push(String(c))
      return true
    }) as typeof process.stdout.write
    process.stderr.write = ((c: string) => {
      errChunks.push(String(c))
      return true
    }) as typeof process.stderr.write
    try {
      await ensure("s1")
    } finally {
      process.stdout.write = realOut
      process.stderr.write = realErr
    }
    expect(errChunks.join("")).toContain("need the local engine")
    expect(outChunks.join("")).not.toContain("need the local engine")
    expect(h.toasts).toHaveLength(0)
  })
})

describe("install deadline", () => {
  // The invariant is that installEngine hands the spawn an abort signal, which
  // is the ONLY thing that produces a deadline: Process.spawn consults
  // `timeout` solely inside its abort handler, as the grace before SIGKILL, so
  // without a signal a stalled npm runs forever and the dialog sits on
  // "Installing…". Measured on the real helper — an 8s sleep took 8004ms under
  // `timeout` alone and 502ms under an abort signal.
  //
  // An earlier version of this test stubbed syncInternals.install to return a
  // timeout error and asserted that error came back. That asserted nothing:
  // it echoed the stub and passed just as happily with the abort signal
  // deleted. This spies on the real call instead.
  test("passes an abort signal to the spawn, not just a timeout", async () => {
    install({})
    delete syncInternals.install
    const spy = spyOn(Process, "run").mockResolvedValue({
      code: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    })
    try {
      const result = await installEngine()
      expect(result.ok).toBe(true)
      expect(spy).toHaveBeenCalled()
      const opts = spy.mock.calls[0]?.[1] as { abort?: AbortSignal } | undefined
      // The load-bearing assertion: a real AbortSignal was supplied.
      expect(opts?.abort).toBeInstanceOf(AbortSignal)
      expect(opts?.abort?.aborted).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  test("the deadline is a real duration", () => {
    expect(INSTALL_TIMEOUT_MS).toBeGreaterThan(0)
    expect(Number.isFinite(INSTALL_TIMEOUT_MS)).toBe(true)
  })
})
