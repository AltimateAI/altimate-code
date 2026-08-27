// Gate lens 1 — awaits between a binding guard and the mutation it protects.
// Disposable; lives only in the reviewer's checkout.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ensure, resetForTests, syncInternals, type LocalMcpConfig } from "../../../src/altimate/workspace/engine-sync"
import type { CachedBinding } from "../../../src/altimate/workspace/state"
import type { ExistingEntry } from "../../../src/altimate/workspace/engine-sync"

const ORIGINAL_FLAG = process.env.ALTIMATE_WORKSPACE

const A: CachedBinding = {
  datamateId: 42,
  datamateName: "analytics",
  repoRemote: "git@github.com:acme/analytics.git",
  projectPath: "/tmp/analytics",
} as CachedBinding
const B: CachedBinding = { ...A, datamateId: 99, datamateName: "other" } as CachedBinding

type Harness = {
  added: Array<{ name: string; cfg: LocalMcpConfig }>
  persisted: Array<{ name: string; cfg: LocalMcpConfig }>
  connects: string[]
  removes: string[]
  toasts: Array<{ title: string; message: string; variant: string }>
  restores: unknown[]
  statusQueue: Array<Record<string, { status: string; error?: string } | undefined>>
  tools: Record<string, unknown>
  /** Every awaited seam, in call order, with the binding it observed. */
  trace: string[]
  current: CachedBinding | null
}

function install(opts: {
  which?: string | null
  version?: string | null | ((bin: string) => string | null)
  statuses?: Harness["statusQueue"]
  tools?: Record<string, unknown>
  existing?: ExistingEntry | null
}): Harness {
  const h: Harness = {
    added: [],
    persisted: [],
    connects: [],
    removes: [],
    toasts: [],
    restores: [],
    statusQueue: opts.statuses ?? [{}],
    tools: opts.tools ?? {},
    trace: [],
    current: A,
  }
  const seam = (name: string) => h.trace.push(name)
  syncInternals.resolveBinding = async () => (seam("resolveBinding"), h.current)
  syncInternals.which = () => (opts.which === undefined ? "/usr/local/bin/datamate" : opts.which)
  syncInternals.versionOf = async (bin) => {
    seam("versionOf")
    if (typeof opts.version === "function") return opts.version(bin)
    return opts.version === undefined ? "0.7.0" : opts.version
  }
  syncInternals.declared = async () => (seam("declared"), { keys: ["dbt_build_model"], extensionKeys: [] })
  syncInternals.persist = async (name, cfg) => {
    seam("persist")
    h.persisted.push({ name, cfg })
  }
  syncInternals.projectEntry = async () => (seam("projectEntry"), null)
  syncInternals.existingEntry = async () => {
    seam("existingEntry")
    if (opts.existing !== undefined) return opts.existing
    const last = h.persisted[h.persisted.length - 1]
    return last ? ({ type: "local", command: last.cfg.command, enabled: true } as ExistingEntry) : null
  }
  syncInternals.notify = async (toast) => {
    seam("notify")
    h.toasts.push(toast)
  }
  syncInternals.toolsChanged = async () => {
    seam("toolsChanged")
  }
  syncInternals.persistRestore = async (_name, previous) => {
    seam("persistRestore")
    h.restores.push(previous ?? null)
  }
  // The project file has no entry of its own unless a test says otherwise.
  // Required since the project reader stopped swallowing its own errors.
  if (!syncInternals.projectEntry) syncInternals.projectEntry = async () => null
  if (!syncInternals.projectConfigPath)
    syncInternals.projectConfigPath = async () => "/tmp/test/.altimate-code/altimate-code.json"
  syncInternals.mcp = {
    status: async () => (seam("status"), h.statusQueue.length > 1 ? h.statusQueue.shift()! : h.statusQueue[0]!),
    add: async (name, cfg) => {
      seam("add")
      h.added.push({ name, cfg })
    },
    remove: async (name) => {
      seam("remove")
      h.removes.push(name)
    },
    tools: async () => (seam("tools"), h.tools),
  }
  return h
}

beforeEach(() => {
  process.env.ALTIMATE_WORKSPACE = "1"
  resetForTests()
})

afterEach(() => {
  for (const key of Object.keys(syncInternals) as Array<keyof typeof syncInternals>) delete syncInternals[key]
  if (ORIGINAL_FLAG === undefined) delete process.env.ALTIMATE_WORKSPACE
  else process.env.ALTIMATE_WORKSPACE = ORIGINAL_FLAG
})

// ---------------------------------------------------------------------------
// T1 — the property the author names, tested as a property: the seam awaited
// IMMEDIATELY before every mutation must be the binding read. Catches any
// awaited seam inserted between the guard and persist/add/remove/connect,
// which the existing first-call-flip tests cannot (they flip before the guard).
// ---------------------------------------------------------------------------
describe("T1 — the last awaited seam before every mutation is the binding read", () => {
  const MUTATIONS = new Set(["persist", "add", "remove", "connect", "persistRestore"])

  /** Which teardowns in a scenario are binding-DEPENDENT.
   *
   * The split is the point: a teardown that undoes what this attach created, or
   * that stops a disabled or below-floor engine, is right whatever the project
   * is bound to now — requiring a binding read before those would assert the
   * opposite of what they are for. Only acting on a pre-existing entry we did
   * not create depends on the binding. Scenarios declare which kind they
   * exercise, because the trace cannot tell them apart. */
  function violations(trace: string[], removesAreBindingDependent = true): string[] {
    const out: string[] = []
    for (let i = 0; i < trace.length; i++) {
      if (!MUTATIONS.has(trace[i])) continue
      // Walk back to the previous non-mutation seam.
      let j = i - 1
      while (j >= 0 && MUTATIONS.has(trace[j])) j--
      const before = trace[j]
      const beforeThat = trace[j - 1]
      // persist→add is the one sanctioned adjacency (persist has no seam of its own
      // to re-read after); everything else must sit directly on the world check.
      if (trace[i] === "add" && trace[i - 1] === "persist") continue
      // ADAPTED ON LIFT: the world check is now TWO reads in a fixed order —
      // binding, then intent — because a guard that confirms only the binding is
      // a guard on half the world. Intent goes last so the only thing between
      // confirming it and the write is the write's own read of the node it
      // replaces, which checks again where nothing can intervene.
      // A WRITE needs the whole world (intent forbids creating anything); a
      // TEARDOWN needs only the binding, since intent neither authorises nor
      // forbids stopping a client.
      const isWrite = trace[i] === "persist" || trace[i] === "add"
      if (isWrite && before === "resolveBinding" && beforeThat === "existingEntry") continue
      if (!isWrite && !removesAreBindingDependent) continue
      if (!isWrite && before === "resolveBinding") continue
      out.push(`${trace[i]} at #${i} follows ${beforeThat ?? "<start>"} -> ${before ?? "<start>"}`)
    }
    return out
  }

  test("fresh spawn", async () => {
    const h = install({ statuses: [{}, { datamate: { status: "connected" } }], tools: { datamate_dbt_build_model: 1 } })
    await ensure("s1")
    expect(violations(h.trace), h.trace.join(" > ")).toEqual([])
  })

  test("replace an unpinned live entry", async () => {
    const h = install({
      existing: { type: "local", command: ["datamate", "start-stdio"] },
      statuses: [{ datamate: { status: "connected" } }, { datamate: { status: "connected" } }],
      tools: { datamate_dbt_build_model: 1 },
    })
    await ensure("s1")
    expect(violations(h.trace), h.trace.join(" > ")).toEqual([])
  })

  // Its teardown is binding-INDEPENDENT: an engine below the floor serves
  // nobody correctly whatever is bound now.
  test("pinned-but-below-floor, PATH newer", async () => {
    const h = install({
      existing: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"] },
      statuses: [{ datamate: { status: "connected" } }, { datamate: { status: "connected" } }],
      version: (bin) => (bin === "datamate" ? "0.6.5" : "0.7.0"),
      tools: { datamate_dbt_build_model: 1 },
    })
    await ensure("s1")
    expect(violations(h.trace, false), h.trace.join(" > ")).toEqual([])
  })

  test("retry-connect of a down command entry", async () => {
    const h = install({
      existing: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"] },
      statuses: [{ datamate: { status: "failed", error: "closed" } }, { datamate: { status: "connected" } }],
      tools: { datamate_dbt_build_model: 1 },
    })
    await ensure("s1")
    expect(violations(h.trace), h.trace.join(" > ")).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// T2 — retry-connect on a stale binding, then the refusal skips teardown
// because the binding is stale: the engine THIS attach brought up stays.
// ---------------------------------------------------------------------------
describe("T2 — retry-connect is an MCP mutation with no guard", () => {
  test("a re-link before the retry: the engine we reconnected is left serving under the new binding", async () => {
    const h = install({
      // Pinned to 42, down, and (once revived) below the floor; PATH no better.
      existing: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"] },
      statuses: [{ datamate: { status: "failed", error: "closed" } }, { datamate: { status: "connected" } }],
      version: () => "0.6.5",
    })
    // The re-link lands while the config is being read — before the retry.
    syncInternals.existingEntry = async () => {
      h.trace.push("existingEntry")
      h.current = B
      return { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"] }
    }
    const outcome = await ensure("s1")
    // ADAPTED ON LIFT. The original asserted the revived engine gets torn down.
    // It is never started now: the retry is a guarded mutation, so a binding that
    // moved before it means we abandon rather than start-then-undo. Nothing
    // brought up is strictly better than something brought up and removed.
    expect(h.connects, "reconnected an entry for a workspace the project had already left").toEqual([])
    expect(h.added, "started an engine for a workspace the project had already left").toHaveLength(0)
    expect(outcome.kind).toBe("superseded")
  })

  test("a re-link DURING the retry's connect window: same result", async () => {
    const h = install({
      existing: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"] },
      statuses: [{ datamate: { status: "failed", error: "closed" } }, { datamate: { status: "connected" } }],
      version: () => "0.6.5",
    })
    // ADAPTED ON LIFT: the retry re-adds rather than connecting, so the window a
    // re-link can land in is `add`, not `connect`.
    const previousAdd = syncInternals.mcp!.add
    syncInternals.mcp!.add = async (name, cfg) => {
      h.trace.push("add")
      h.current = B // a TUI re-link inside the restart is the likely timing
      return previousAdd(name, cfg)
    }
    const outcome = await ensure("s1")
    // The engine THIS attach brought up is torn down whatever is bound now —
    // undoing what we created is binding-independent by definition.
    expect(h.removes, "the engine this attach brought up was left connected under binding 99").toContain("datamate")
    expect(outcome.kind).toBe("superseded")
  })
})

// ---------------------------------------------------------------------------
// T3 — production persist() awaits ~10 fs operations (resolveConfigPath's
// exists() loop, addMcpToConfig's exists+readText) before its write and before
// MCP.add. Model ONE of them in the seam and flip inside it.
// ---------------------------------------------------------------------------
describe("T3 — awaits inside persist() sit between the final guard and the install", () => {
  test("a re-link inside persist's config-path probe still spawns the old workspace's engine", async () => {
    const h = install({ statuses: [{}, { datamate: { status: "connected" } }], tools: { datamate_dbt_build_model: 1 } })
    // ADAPTED ON LIFT. The config-path probe — up to nine `exists` calls — is no
    // longer inside the write: it is resolved ABOVE the guard and handed in, so
    // this models it where it now lives. That is the fix; flipping inside the
    // resolved-path lookup must be caught by the guard, not undone after it.
    syncInternals.projectConfigPath = async () => {
      h.trace.push("resolveConfigPath")
      await Promise.resolve() // Filesystem.exists(candidate) #1 of up to 9
      h.current = B
      return "/tmp/test/.altimate-code/altimate-code.json"
    }
    const outcome = await ensure("s1")
    // Round 19's own standard: the late guard undoing it is the failure, not the fix.
    expect(h.added.filter((a) => a.cfg.command.includes("42")), "spawned workspace 42's engine after the re-link").toHaveLength(0)
    expect(h.persisted, "wrote workspace 42's pin after the re-link").toHaveLength(0)
    expect(outcome.kind).toBe("superseded")
  })

  test("a re-link inside the WRITE itself is undone rather than prevented — the named residual", async () => {
    // Nothing can guard the inside of the write. What must hold is that the
    // region gives back both halves of what it took.
    const h = install({ statuses: [{}, { datamate: { status: "connected" } }], tools: { datamate_dbt_build_model: 1 } })
    syncInternals.persist = async (name, cfg) => {
      h.persisted.push({ name, cfg })
      h.current = B
    }
    const outcome = await ensure("s1")
    expect(outcome.kind).toBe("superseded")
    expect(h.removes, "left the old workspace's engine registered").toContain("datamate")
    expect(h.restores.length, "left the old workspace's pin on disk").toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// T4 — answered after awaits that follow the final guard (announce, notify).
// ---------------------------------------------------------------------------
describe("T4 — the attached answer is given after two awaits past the last guard", () => {
  test("a re-link during announceToolsChanged is answered `attached` for the old workspace", async () => {
    const h = install({ statuses: [{}, { datamate: { status: "connected" } }], tools: { datamate_dbt_build_model: 1 } })
    syncInternals.toolsChanged = async () => {
      h.trace.push("toolsChanged")
      h.current = B
    }
    const outcome = await ensure("s1")
    // ADAPTED ON LIFT, and the residual is named rather than asserted away.
    // The answer is now fixed BEFORE the announcements rather than after them,
    // so the decision no longer straddles those awaits — but a re-link landing
    // inside the toast still leaves this turn holding `attached` for 42. It
    // cannot be guarded without either un-saying a toast already shown or
    // announcing a success we then retract.
    //
    // What must hold is that it does not OUTLIVE the turn: the memo is keyed to
    // the workspace it was taken for, so the next turn re-decides for 99 rather
    // than riding it.
    expect(outcome.kind).toBe("attached")
    const second = await ensure("s1")
    expect(second.kind, "rode a memo taken for the workspace the project had left").not.toBe("reused")
    expect(h.added.at(-1)?.cfg.command, "did not re-attach for the new binding").toEqual([
      "datamate",
      "start-stdio",
      "--datamate",
      "99",
    ])
  })
})

// ---------------------------------------------------------------------------
// T5 — the skip-teardown in detachRejected applies to binding-INDEPENDENT
// teardowns too: a disabled entry keeps serving for this turn after a re-link.
// ---------------------------------------------------------------------------
describe("T5 — a disabled entry's teardown is skipped on a stale binding", () => {
  test("re-link during the status read: the disabled-but-connected client is left serving", async () => {
    const h = install({
      existing: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"], enabled: false },
      statuses: [{ datamate: { status: "connected" } }],
    })
    syncInternals.mcp!.status = async () => {
      h.trace.push("status")
      h.current = B
      return { datamate: { status: "connected" } }
    }
    const outcome = await ensure("s1")
    // ADAPTED ON LIFT. The teardown is the property under test and it holds: a
    // disabled entry is disabled for every workspace, so its teardown does not
    // consult the binding. The ANSWER is now `superseded` rather than
    // `entry-disabled`, because a refusal is an answer too and this one would
    // otherwise describe — and toast about — a workspace the project has left.
    expect(outcome.kind).toBe("superseded")
    expect(h.removes, "a disabled entry is disabled for every workspace; its teardown does not depend on the binding").toContain("datamate")
  })
})
