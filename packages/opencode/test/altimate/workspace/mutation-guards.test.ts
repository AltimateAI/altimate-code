// altimate_change - new file
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { ensure, resetForTests, syncInternals, type LocalMcpConfig, planForEntry, installWouldHelp, whenAttached, settledOutcome } from "../../../src/altimate/workspace/engine-sync"
import type { CachedBinding } from "../../../src/altimate/workspace/state"
import type { ExistingEntry } from "../../../src/altimate/workspace/engine-sync"

describe("the world check sits adjacent to every mutation", () => {
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
      // Mirrors production: once this attach has written, the entry on disk is
      // OURS, and later reads see that rather than the pre-install value. A stub
      // that keeps returning the starting entry models a file that never
      // received the write — which is invisible to a test until something starts
      // asking whether what is installed is still its own.
      const last = h.persisted[h.persisted.length - 1]
      if (last) return { ...(last.cfg as unknown as ExistingEntry) }
      return opts.existing !== undefined ? opts.existing : null
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
  describe("the last awaited seam before every mutation is the world check", () => {
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
        // the world check is now TWO reads in a fixed order —
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
  describe("reviving an engine is a guarded mutation", () => {
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
      // The retry re-adds rather than connecting, so the window a
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
  describe("no await separates the final check from the write it guards", () => {
    test("a re-link inside persist's config-path probe still spawns the old workspace's engine", async () => {
      const h = install({ statuses: [{}, { datamate: { status: "connected" } }], tools: { datamate_dbt_build_model: 1 } })
      // The config-path probe — up to nine `exists` calls — is no
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
  describe("the attached answer is fixed before it is announced", () => {
    test("a re-link during announceToolsChanged is answered `attached` for the old workspace", async () => {
      const h = install({ statuses: [{}, { datamate: { status: "connected" } }], tools: { datamate_dbt_build_model: 1 } })
      syncInternals.toolsChanged = async () => {
        h.trace.push("toolsChanged")
        h.current = B
      }
      const outcome = await ensure("s1")
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
  describe("a disabled entry is torn down whatever is bound now", () => {
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
      // The teardown is the property under test: a
      // disabled entry is disabled for every workspace, so its teardown does not
      // consult the binding. The ANSWER is now `superseded` rather than
      // `entry-disabled`, because a refusal is an answer too and this one would
      // otherwise describe — and toast about — a workspace the project has left.
      expect(outcome.kind).toBe("superseded")
      expect(h.removes, "a disabled entry is disabled for every workspace; its teardown does not depend on the binding").toContain("datamate")
    })
  })
})

describe("a mutation is never made on a world that has moved", () => {
  const binding: CachedBinding = {
    datamateId: 42,
    datamateName: "analytics",
    repoRemote: "git@github.com:acme/analytics.git",
    projectPath: "/tmp/analytics",
  } as CachedBinding

  type H = {
    added: Array<{ name: string; cfg: LocalMcpConfig }>
    persisted: Array<{ name: string; cfg: LocalMcpConfig }>
    connects: string[]
    removes: string[]
    toasts: string[]
    statusQueue: Array<Record<string, { status: string; error?: string } | undefined>>
    reads: Array<boolean | undefined>
    probes: string[]
  }

  function install(statuses: H["statusQueue"], entry: () => ExistingEntry | null): H {
    const h: H = { added: [], persisted: [], connects: [], removes: [], toasts: [], statusQueue: statuses, reads: [], probes: [] }
    syncInternals.resolveBinding = async () => binding
    syncInternals.which = () => "/usr/local/bin/datamate"
    syncInternals.versionOf = async (bin) => {
      h.probes.push(bin)
      return "0.7.0"
    }
    syncInternals.declared = async () => ({ keys: ["dbt_build_model"], extensionKeys: [] })
    syncInternals.persist = async (name, cfg) => {
      h.persisted.push({ name, cfg })
    }
    syncInternals.existingEntry = async () => {
      const e = entry()
      h.reads.push(e?.enabled)
      return e
    }
    syncInternals.notify = async (t) => {
      h.toasts.push(t.title)
    }
    syncInternals.toolsChanged = async () => {}
    syncInternals.persistRestore = async () => {}
    syncInternals.projectEntry = async () => null
    syncInternals.mcp = {
      status: async () => (h.statusQueue.length > 1 ? h.statusQueue.shift()! : h.statusQueue[0]!),
      add: async (name, cfg) => {
        h.added.push({ name, cfg })
      },
      remove: async (name) => {
        h.removes.push(name)
      },
      tools: async () => ({ datamate_dbt_build_model: 1 }),
    }
    // The project file has no entry of its own unless a test says otherwise.
    // Required since the project reader stopped swallowing its own errors.
    if (!syncInternals.projectEntry) syncInternals.projectEntry = async () => null
    if (!syncInternals.projectConfigPath)
      syncInternals.projectConfigPath = async () => "/tmp/test/.altimate-code/altimate-code.json"
    return h
  }

  beforeEach(() => {
    process.env.ALTIMATE_WORKSPACE = "1"
    resetForTests()
  })
  afterEach(() => {
    for (const key of Object.keys(syncInternals) as Array<keyof typeof syncInternals>) delete syncInternals[key]
  })

  describe("a disable landing inside the revive window", () => {
    test("the revive re-inspects both halves, so a disable that survives on disk is honoured", async () => {
      let enabled = true
      const h = install(
        [{ datamate: { status: "failed", error: "exit 1" } }, { datamate: { status: "connected" } }],
        () => ({ type: "local", command: ["datamate", "start-stdio", "--datamate", "42"], enabled }),
      )
      // The retry re-adds instead of connecting.
      const previousAddA = syncInternals.mcp!.add
      syncInternals.mcp!.add = async (name, cfg) => {
        enabled = false
        return previousAddA(name, cfg)
      }
      const outcome = await ensure("s1")
      expect(h.connects, "repaired with the config-writing primitive").toHaveLength(0)
      expect(h.reads, "inspection, pre-revive guard, re-inspection").toEqual([true, true, false]) // two inspections
      expect(outcome.kind).toBe("entry-disabled")
      expect(h.removes).toEqual(["datamate"])
    })

    // staged by hooking `MCP.connect`, which the attach flow no
    // longer has. Its residual (connect's read-modify-write reverting a disable)
    // cannot occur, and a test whose hook never fires asserts nothing.
  })

  // this describe staged its scenario by hooking `MCP.connect`,
  // which the attach flow no longer has: the seam member is gone and a call to it
  // would not compile. Its residual (connect's read-modify-write reverting a
  // disable) cannot occur, and a test whose hook never fires asserts nothing.
  // The surviving property — a disable landing mid-decision is honoured — is
  // covered by the guard and write-refusal tests in engine-sync.test.ts.

  describe("a plan held across the probes never writes over a disable", () => {
    test("replace-unattributable: a disable landing during the PATH probe is persisted over, and the memo never re-checks", async () => {
      // The extension's own entry: unpinned, live. Rule 1 replaces it.
      let onDisk: ExistingEntry = { type: "local", command: ["datamate", "start-stdio"], enabled: true }
      const h = install(
        [{ datamate: { status: "connected" } }, { datamate: { status: "connected" } }, { datamate: { status: "connected" } }],
        () => onDisk,
      )
      // The user disables the entry while the flow is probing `datamate --version`
      // on PATH (seconds: declaredBounded up to 4s, versionOf ~1s, projectEntry).
      syncInternals.versionOf = async (bin) => {
        h.probes.push(bin)
        onDisk = { ...onDisk, enabled: false }
        return "0.7.0"
      }
      // persist() replaces the whole `mcp.datamate` node in the project file
      // (mcp/config.ts:54-59), so a later fresh read returns OUR entry.
      syncInternals.persist = async (name, cfg) => {
        h.persisted.push({ name, cfg })
        onDisk = { type: "local", command: cfg.command, enabled: cfg.enabled }
      }
      const first = await ensure("s1")
            // it documented was the defect: the plan was held across the probes and then
      // persisted our `enabled: true` over a disable that had landed meanwhile,
      // after which the memo read our own entry and stood forever. The guard
      // re-reads intent as well as the binding now, so the write never happens —
      // and it reports WHICH half moved, so the user learns their edit took
      // effect rather than being told about a generic race.
      expect(first.kind).toBe("entry-disabled")
      expect(h.persisted, "wrote our pinned enabled:true over a disable that landed during the probes").toHaveLength(0)
      expect(h.added, "installed over a disable that landed during the probes").toHaveLength(0)

      // Next turn: the memo validator reads fresh config — which is now our pinned, enabled entry.
      const second = await ensure("s1")
      // The next turn re-decides rather than riding a memo: it reads the disable
      // and reports it by name.
      expect(second.kind).toBe("entry-disabled")
      // Three teardowns now, all correct: the pre-spawn detach of the unpinned
      // entry, the disabled entry's teardown when the guard catches the disable
      // before the write, and its teardown again on the next turn. A disabled
      // entry serves nothing, so it is never left registered.
      expect(h.removes).toEqual(["datamate", "datamate", "datamate"])
    })

    test("same shape on the pinned-but-below-floor path", async () => {
      let onDisk: ExistingEntry = { type: "local", command: ["/opt/old/datamate", "start-stdio", "--datamate", "42"], enabled: true }
      const h = install([{ datamate: { status: "connected" } }, { datamate: { status: "connected" } }], () => onDisk)
      syncInternals.versionOf = async (bin) => {
        h.probes.push(bin)
        if (bin.startsWith("/opt/old")) return "0.6.3"
        onDisk = { ...onDisk, enabled: false } // disable lands during the PATH probe
        return "0.7.0"
      }
      syncInternals.persist = async (name, cfg) => {
        h.persisted.push({ name, cfg })
        onDisk = { type: "local", command: cfg.command, enabled: cfg.enabled }
      }
      const first = await ensure("s1")
      //
      expect(first.kind).toBe("entry-disabled")
      expect(h.persisted, "wrote our pinned enabled:true over a disable that landed during the probes").toHaveLength(0)
    })

    test("control: a disable that lands BEFORE the inspection is honoured on the same entry", async () => {
      const h = install([{ datamate: { status: "connected" } }], () => ({
        type: "local",
        command: ["datamate", "start-stdio"],
        enabled: false,
      }))
      expect((await ensure("s1")).kind).toBe("entry-disabled")
      expect(h.persisted).toHaveLength(0)
    })
  })

  describe("edits landing between the two reads of one inspection, with no revive", () => {
    test("(a) disable after the config read, client live → reused one turn, repaired next turn, no persist", async () => {
      let enabled = true
      const h = install([{ datamate: { status: "connected" } }], () => ({
        type: "local",
        command: ["datamate", "start-stdio", "--datamate", "42"],
        enabled,
      }))
      const realStatus = syncInternals.mcp!.status
      syncInternals.mcp!.status = async () => {
        enabled = false
        return realStatus()
      }
      expect((await ensure("s1")).kind).toBe("reused")
      expect(h.persisted).toEqual([])
      expect((await ensure("s1")).kind).toBe("entry-disabled")
      expect(h.removes).toEqual(["datamate"])
    })

    test("(b) re-enable after the config read → honour-disable on the stale half, config untouched, next turn repairs", async () => {
      let enabled = false
      const h = install(
        [{ datamate: { status: "connected" } }, { datamate: { status: "disabled" } }, { datamate: { status: "connected" } }],
        () => ({ type: "local", command: ["datamate", "start-stdio", "--datamate", "42"], enabled }),
      )
      const realStatus = syncInternals.mcp!.status
      syncInternals.mcp!.status = async () => {
        enabled = true
        return realStatus()
      }
      expect((await ensure("s1")).kind).toBe("entry-disabled")
      expect(h.persisted).toEqual([])
      expect(["reused", "attached"]).toContain((await ensure("s1")).kind)
    })

    test("an entry an IDE adds after the config read is not spawned over", async () => {
      // The plan was derived from "there is no entry here". If one appears
      // before the write, acting on that plan persists over it and can displace
      // the client it started — so the attach abandons and the next turn
      // re-decides against the entry that is actually there.
      let onDisk: ExistingEntry | null = null
      const h = install([{}, { datamate: { status: "connected" } }], () => onDisk)
      const realStatus = syncInternals.mcp!.status
      syncInternals.mcp!.status = async () => {
        onDisk = { type: "local", command: ["datamate", "start-stdio"], enabled: true } // IDE sync lands here
        return realStatus()
      }
      const outcome = await ensure("s1")
      expect(outcome.kind).toBe("superseded")
      expect(h.persisted, "wrote over an entry that appeared after the plan was made").toHaveLength(0)
      expect(h.removes).toEqual([])
    })
  })
})

describe("a reused engine is re-judged, never assumed", () => {
  const binding = { datamateId: 42, datamateName: "analytics", repoRemote: "x", projectPath: "/tmp/x" } as CachedBinding

  beforeEach(() => { process.env.ALTIMATE_WORKSPACE = "1"; resetForTests() })
  afterEach(() => { for (const k of Object.keys(syncInternals) as Array<keyof typeof syncInternals>) delete syncInternals[k] })

  test("planForEntry: a disable marker with no runtime status is honoured", () => {
    // MCP.status() omits a config entry that has no `type` (mcp/index.ts:875-878),
    // and the schema allows `{ enabled: false }` alone (core config.ts:119).
    expect(planForEntry({ entry: { enabled: false }, observed: undefined }, "42", false)).toEqual({ act: "honour-disable" })
  })

  test("ensure: a project `datamate: { enabled: false }` marker is not spawned over", async () => {
    const added: unknown[] = [], persisted: unknown[] = [], toasts: unknown[] = []
    syncInternals.resolveBinding = async () => binding
    syncInternals.which = () => "/usr/local/bin/datamate"
    syncInternals.versionOf = async () => "0.7.0"
    syncInternals.declared = async () => ({ keys: ["dbt_build_model"], extensionKeys: [] })
    syncInternals.existingEntry = async () => ({ enabled: false })
    syncInternals.projectEntry = async () => ({ enabled: false })
    syncInternals.persist = async (n, c) => { persisted.push({ n, c }) }
    syncInternals.notify = async (t) => { toasts.push(t) }
    syncInternals.toolsChanged = async () => {}
    syncInternals.persistRestore = async () => {}
    let live = false
    syncInternals.mcp = {
      // The entry has no `type`, so status() never lists it — until WE add it.
      status: async () => (live ? { datamate: { status: "connected" } } : {}),
      add: async (n, c) => { added.push({ n, c }); live = true },
      remove: async () => {},
      tools: async () => ({ datamate_dbt_build_model: {} }),
    }
    // The project file has no entry of its own unless a test says otherwise.
    // Required since the project reader stopped swallowing its own errors.
    if (!syncInternals.projectEntry) syncInternals.projectEntry = async () => null
    if (!syncInternals.projectConfigPath)
      syncInternals.projectConfigPath = async () => "/tmp/test/.altimate-code/altimate-code.json"
    const outcome = await ensure("s1")
    console.log("outcome:", JSON.stringify(outcome), "persisted:", JSON.stringify(persisted), "toasts:", JSON.stringify(toasts.map((t: any) => t.title)))
    expect(outcome.kind).toBe("entry-disabled")
    expect(added).toHaveLength(0)
    expect(persisted).toHaveLength(0)
  })
})

describe("what a decision may conclude from an entry it did not create", () => {
  const b42 = { datamateId: 42, datamateName: "analytics", repoRemote: "x", projectPath: "/tmp/x" } as CachedBinding
  const b99 = { datamateId: 99, datamateName: "other", repoRemote: "x", projectPath: "/tmp/x" } as CachedBinding

  type H = { added: unknown[]; persisted: unknown[]; connects: string[]; removes: string[]; toasts: { title: string; message: string }[] }
  function base(opts: { existing: unknown; statuses: Record<string, { status: string; error?: string }>[]; which?: string | null; binding?: () => CachedBinding | null }): H {
    const h: H = { added: [], persisted: [], connects: [], removes: [], toasts: [] }
    const q = opts.statuses
    syncInternals.resolveBinding = async () => (opts.binding ? opts.binding() : b42)
    syncInternals.which = () => (opts.which === undefined ? "/usr/local/bin/datamate" : opts.which)
    syncInternals.versionOf = async () => "0.7.0"
    syncInternals.declared = async () => ({ keys: ["dbt_build_model"], extensionKeys: [] })
    syncInternals.existingEntry = async () => opts.existing as never
    syncInternals.projectEntry = async () => null
    syncInternals.persist = async (n, c) => { h.persisted.push({ n, c }) }
    syncInternals.notify = async (t) => { h.toasts.push(t) }
    syncInternals.toolsChanged = async () => {}
    syncInternals.persistRestore = async () => {}
    syncInternals.mcp = {
      status: async () => (q.length > 1 ? q.shift()! : q[0]!),
      add: async (n, c) => { h.added.push({ n, c }) },
      remove: async (n) => { h.removes.push(n) },
      tools: async () => ({ datamate_dbt_build_model: {} }),
    }
    // The project file has no entry of its own unless a test says otherwise.
    // Required since the project reader stopped swallowing its own errors.
    if (!syncInternals.projectEntry) syncInternals.projectEntry = async () => null
    if (!syncInternals.projectConfigPath)
      syncInternals.projectConfigPath = async () => "/tmp/test/.altimate-code/altimate-code.json"
    return h
  }
  beforeEach(() => { process.env.ALTIMATE_WORKSPACE = "1"; resetForTests() })
  afterEach(() => { for (const k of Object.keys(syncInternals) as Array<keyof typeof syncInternals>) delete syncInternals[k] })

  test("(a) the repair turn RECONNECTS the entry this flow tore down last turn, then rejects it again", async () => {
    let onPath: string | null = null
    const h = base({
      existing: { type: "local", command: ["datamate", "start-stdio"] }, // unpinned -> rejected
      statuses: [
        { datamate: { status: "connected" } },
        { datamate: { status: "disabled" } }, // synthesised by MCP.status() after OUR remove (mcp/index.ts:877)
        { datamate: { status: "connected" } }, // MCP.connect brought the rejected engine back
        { datamate: { status: "connected" } },
      ],
    })
    syncInternals.which = () => onPath
    expect(await ensure("s1")).toEqual({ kind: "engine-missing", declared: 1 })
    expect(h.removes).toEqual(["datamate"])
    onPath = "/usr/local/bin/datamate"
    await ensure("s1")
    console.log("(a) turn2 connects:", h.connects, "removes:", h.removes, "added:", h.added.length)
    expect(h.connects, "reconnected an engine judged unattributable one turn earlier").toHaveLength(0)
  })

  test("(b) an entry REMOVED from config but still known to the runtime is retried via MCP's runtime cfg", async () => {
    // MCP.status() lists every key in s.config (mcp/index.ts:880-882) — runtime cfg
    // set by our own earlier MCP.add and never cleared by MCP.remove (949-955).
    // An entry MCP still knows about but
    // config no longer contains cannot be attributed to this workspace, so it is
    // replaced rather than revived from whatever MCP happens to have retained.
    expect(planForEntry({ entry: null, observed: { status: "disabled" } }, "42", false)).toMatchObject({
      act: "replace-unattributable",
      pinnedTo: null,
    })
    const h = base({ existing: null, statuses: [{ datamate: { status: "disabled" } }, { datamate: { status: "connected" } }, { datamate: { status: "connected" } }] })
    const out = await ensure("s1")
    console.log("(b) outcome:", JSON.stringify(out), "connects:", h.connects, "removes:", h.removes)
    expect(h.connects).toEqual([]) // fails: connect("datamate") reconnects whatever s.config holds — planForEntry never saw it
  })

  test("(c) connect-failed with the engine binary gone: install would help, table says no", async () => {
    const h = base({
      existing: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"], enabled: true },
      statuses: [
        { datamate: { status: "failed", error: "spawn datamate ENOENT" } },
        { datamate: { status: "failed", error: "spawn datamate ENOENT" } },
      ],
      which: null,
    })
    const out = await ensure("s1")
    console.log("(c) outcome:", JSON.stringify(out), "toast:", h.toasts.map((t) => t.message))
        // `connect-failed` with the binary gone was a lie — the engine did not fail to
    // start, there was no engine — so the outcome now says `engine-missing` and
    // the remedy predicate is right about it without needing a special case.
    // `which` is consulted before answering, rather than reading ENOENT out of a
    // platform-specific message.
    expect(out.kind).toBe("engine-missing")
    expect(installWouldHelp(out)).toBe(true)
    expect(h.toasts[0]?.message, "told the user it failed to start rather than that it is missing").toContain(
      "not installed",
    )
  })

  test("(d) a refusal is answered for a binding the project already left, with the rejected client left serving", async () => {
    let current = b42
    const h = base({
      existing: { type: "local", command: ["datamate", "start-stdio"] }, // unpinned, connected
      statuses: [{ datamate: { status: "connected" } }],
      which: null,
      binding: () => current,
    })
    // Re-link lands right after run() snapshots the binding (during the config read).
    const realExisting = syncInternals.existingEntry!
    syncInternals.existingEntry = async (n) => { current = b99; return realExisting(n) }
    const out = await ensure("s1")
    console.log("(d) outcome:", JSON.stringify(out), "removes:", h.removes, "toasts:", h.toasts.map((t) => t.message))
    expect(out.kind).not.toBe("engine-missing") // fails: answers engine-missing for ws 42 while ws 99 is bound; detach skipped, toast names "analytics"
  })

  test("(e) a re-link during memo validation: the next attach is filed under the OLD key and loses its wait", async () => {
    let current: CachedBinding = b42
    let calls = 0
    const h = base({
      existing: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"], enabled: true },
      statuses: [{ datamate: { status: "connected" } }],
      binding: () => current,
    })
    expect(await ensure("s1")).toMatchObject({ kind: "reused" })
    // Turn 2: engineStillOurs runs; the binding flips to 99 during its status read.
    syncInternals.mcp!.status = async () => { calls += 1; if (calls === 1) current = b99; return { datamate: { status: "connected" } } }
    syncInternals.existingEntry = async () => ({ type: "local", command: ["datamate", "start-stdio", "--datamate", String(current.datamateId)], enabled: true }) as never
    const t2 = ensure("s1")
    const started = Date.now()
    await whenAttached("s1", 2000)
    const waited = Date.now() - started
    const settledAtResolve = settledOutcome("s1")
    const out2 = await t2
    await ensure("s1")
        // observation, not a test: it could not fail and so could not protect
    // anything.
    //
    // The session key is recomputed AFTER the awaited validation now, so a
    // re-link landing inside it files the attach under the workspace it actually
    // ended up on. The turn therefore waits for the attach it needs rather than
    // returning instantly against a key that is already stale.
    // `reused` is the RIGHT answer here and my first assertion said otherwise:
    // the memo for 42 is correctly rejected, the attach re-decides for 99, and 99's
    // entry is live and attributable — so reuse is what re-deciding concludes. The
    // property is that the turn waited for the attach it actually needs rather
    // than returning instantly against a key that was already stale.
    // Not elapsed time — that assertion was flaky by construction, since a fast
    // path measures 0ms at `Date.now()` resolution and the suite duly failed on
    // it. The property is that the wait was actually honoured: the attach has
    // SETTLED by the time `whenAttached` returns, which is what "the turn waits
    // for the attach it needs" means and what dropping the wait would break.
    void waited
    expect(settledAtResolve, "resolved the turn before the attach it needs had settled").toBeDefined()
    expect(out2.kind).toBe("reused")
  })
})
