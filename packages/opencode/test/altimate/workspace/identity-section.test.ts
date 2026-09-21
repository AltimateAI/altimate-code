// altimate_change - new file
//
// The async half of the workspace identity section: what `systemSection()` — the
// call `prompt.ts` makes on every step — renders for a real binding cache, a real
// instance context, and the pilot flag in each position. The pure `render()` is
// covered in identity.test.ts; this file is about the gate and the plumbing.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import path from "node:path"
import os from "node:os"

// Global.Path.state resolves at module load, so the sandbox must exist first.
const ORIGINAL_XDG_STATE_HOME = process.env.XDG_STATE_HOME
const ORIGINAL_PILOT = process.env.ALTIMATE_WORKSPACE
const SANDBOX = path.join(os.tmpdir(), `altimate-identity-${process.pid}-${Date.now()}`)
mkdirSync(path.join(SANDBOX, "state"), { recursive: true })
process.env.XDG_STATE_HOME = path.join(SANDBOX, "state")
process.env.ALTIMATE_WORKSPACE = "1"

afterAll(() => {
  if (ORIGINAL_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = ORIGINAL_XDG_STATE_HOME
  if (ORIGINAL_PILOT === undefined) delete process.env.ALTIMATE_WORKSPACE
  else process.env.ALTIMATE_WORKSPACE = ORIGINAL_PILOT
  try {
    rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

const { AltimateApi } = await import("../../../src/altimate/api/client")
const {
  systemSection,
  resetOutcomeMemoForTests,
  setClockForTests,
  identityInternals,
  OUTCOME_MEMO_MS,
  RESOLVE_DEADLINE_MS,
  FALLBACK_BUDGET_MS,
  FAILURE_MEMO_MS,
} = await import(
  "../../../src/altimate/workspace/identity",
)
const { recordApprovedBinding, clearLocalBinding, __resetPinValidation } = await import(
  "../../../src/altimate/workspace/state"
)
const { Instance } = await import("../../../src/project/instance")

type Creds = Awaited<ReturnType<typeof AltimateApi.getCredentials>>
const originalIsConfigured = AltimateApi.isConfigured
const originalGetCreds = AltimateApi.getCredentials
;(AltimateApi as unknown as { isConfigured: () => Promise<boolean> }).isConfigured = async () => true
;(AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials = async () =>
  ({ altimateInstanceName: "acme", altimateUrl: "https://api.example.com", altimateApiKey: "k" }) as Creds
afterAll(() => {
  ;(AltimateApi as unknown as { isConfigured: typeof originalIsConfigured }).isConfigured = originalIsConfigured
  ;(AltimateApi as unknown as { getCredentials: typeof originalGetCreds }).getCredentials = originalGetCreds
})

const originalFetch = globalThis.fetch
let projectDir = ""

beforeEach(() => {
  process.env.ALTIMATE_WORKSPACE = "1"
  resetOutcomeMemoForTests()
  projectDir = mkdtempSync(path.join(SANDBOX, "proj-"))
  // Nothing here should need the network; anything that asks gets an empty 200.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  // Also restores the clock, so a test that set one cannot leak it.
  resetOutcomeMemoForTests()
})

/** Bounded poll for a background side effect (a memo fill after the deadline
 * passed), instead of a fixed sleep that races the scheduler. */
async function eventually(check: () => Promise<boolean>, ms = 3_000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await check()) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  return check()
}

const inProject = <T>(fn: () => Promise<T>) => Instance.provide({ directory: projectDir, fn })

describe("systemSection", () => {
  test("names the linked workspace for a bound project", async () => {
    await recordApprovedBinding(
      projectDir,
      { datamateId: 42, datamateName: "Growth", repoRemote: null, projectPath: projectDir, linkedAt: Date.now() } as never,
      { awaitBackfill: true },
    )
    const out = await inProject(systemSection)
    expect(out).toContain("## Altimate Workspace")
    expect(out).toContain("This project is linked to Altimate Workspace id 42")
    expect(out).toContain('is "Growth"')
    expect(out).not.toContain("last known")
    expect(out).toContain("never substitute")
  })

  test("renders nothing when the workspace pilot is off", async () => {
    // A user outside the pilot has no Altimate Workspace to be linked to, and
    // must not be told every turn that none is linked and how to link one.
    await recordApprovedBinding(
      projectDir,
      { datamateId: 42, datamateName: "Growth", repoRemote: null, projectPath: projectDir, linkedAt: Date.now() } as never,
      { awaitBackfill: true },
    )
    delete process.env.ALTIMATE_WORKSPACE
    expect(await inProject(systemSection)).toBe("")
  })

  test("says none is linked, and how to link one, for an unlinked project", async () => {
    // A confirmed miss: the server answers 404 for this project, which is the
    // definite "no" the unbound copy needs.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ detail: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch
    const out = await inProject(systemSection)
    expect(out).toContain("No Altimate Workspace is linked to this project")
    expect(out).toContain("altimate-code link")
  })

  test("asserts nothing either way when the link cannot be verified", async () => {
    globalThis.fetch = (async () => {
      throw new Error("offline")
    }) as unknown as typeof fetch
    const out = await inProject(systemSection)
    expect(out).toContain("could not be verified")
    expect(out).not.toContain("No Altimate Workspace is linked")
    expect(out).not.toContain("linked to Altimate Workspace id")
  })

  test("an unreachable server is probed once per window, not once per step", async () => {
    // The section renders on every agent step. Without the memo, an outage
    // costs a `git remote` plus up to two 15-second requests before every
    // generation; with it, one resolve per `OUTCOME_MEMO_MS`.
    let attempts = 0
    globalThis.fetch = (async () => {
      attempts++
      throw new Error("offline")
    }) as unknown as typeof fetch
    expect(await inProject(systemSection)).toContain("could not be verified")
    const afterFirst = attempts
    expect(afterFirst).toBeGreaterThan(0)
    expect(await inProject(systemSection)).toContain("could not be verified")
    expect(await inProject(systemSection)).toContain("could not be verified")
    expect(attempts).toBe(afterFirst)
    // A new window asks again — the blip was never promoted to a remembered answer.
    resetOutcomeMemoForTests()
    await inProject(systemSection)
    expect(attempts).toBeGreaterThan(afterFirst)
    expect(OUTCOME_MEMO_MS).toBe(30_000)
  })

  test("a link or unlink in this process clears the memo, so the next step sees it", async () => {
    // Bound, memoised; then the binding is removed the way `/workspace` unlink
    // does it. Without the `onBindingChanged` hook the memo would keep naming
    // the workspace for up to a window after the user unlinked.
    await recordApprovedBinding(projectDir, {
      datamateId: 42,
      datamateName: "analytics",
      repoRemote: null,
      projectPath: projectDir,
      linkedAt: Date.now(),
    })
    expect(await inProject(systemSection)).toContain('is "analytics"')
    await clearLocalBinding(projectDir, { scope: { tenant: "acme", apiUrl: "https://api.example.com" } })
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ detail: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch
    // The unlink path memoises the miss in the resolver, so the wording is the
    // "as of the last check" one; what matters is that "analytics" is gone.
    const after = await inProject(systemSection)
    expect(after).toContain("No Altimate Workspace")
    expect(after).not.toContain('is "analytics"')
  })

  test("the definitive (unbound) answer is seen once the outage window ends", async () => {
    globalThis.fetch = (async () => {
      throw new Error("offline")
    }) as unknown as typeof fetch
    expect(await inProject(systemSection)).toContain("could not be verified")
    resetOutcomeMemoForTests()
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ detail: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch
    expect(await inProject(systemSection)).toContain("No Altimate Workspace is linked")
  })

  test("a binding change during an in-flight resolve is not overwritten by the stale outcome", async () => {
    // The resolve yields on the network; the user unlinks meanwhile. The memo was
    // cleared by `onBindingChanged`, and the pre-change outcome must not be
    // written back into it, or the next step names the old workspace for a window.
    await recordApprovedBinding(projectDir, {
      datamateId: 7,
      datamateName: "old",
      repoRemote: null,
      projectPath: projectDir,
      linkedAt: Date.now() - 10 * 60 * 1000,
    })
    const { expireValidationForTests } = await import("../../../src/altimate/workspace/state")
    expireValidationForTests?.(projectDir)
    let unlinkedMidFlight = false
    globalThis.fetch = (async () => {
      if (!unlinkedMidFlight) {
        unlinkedMidFlight = true
        await clearLocalBinding(projectDir, { scope: { tenant: "acme", apiUrl: "https://api.example.com" } })
      }
      throw new Error("offline")
    }) as unknown as typeof fetch
    await inProject(systemSection)
    // Next step: the memo must not hold the pre-unlink outcome. The server is
    // still offline, so the honest answer is "could not be verified", not "old".
    const next = await inProject(systemSection)
    expect(next).not.toContain('is "old"')
  })

  test("the memo is scoped to the account: a tenant switch does not inherit the other's answer", async () => {
    globalThis.fetch = (async () => {
      throw new Error("offline")
    }) as unknown as typeof fetch
    expect(await inProject(systemSection)).toContain("could not be verified")
    // Same directory, different tenant, server back: must resolve afresh.
    const getCreds = (AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials
    ;(AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials = async () =>
      ({ altimateInstanceName: "other", altimateUrl: "https://api.example.com", altimateApiKey: "k2" }) as Creds
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ detail: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch
    try {
      expect(await inProject(systemSection)).toContain("No Altimate Workspace is linked")
    } finally {
      ;(AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials = getCreds
    }
  })

  test("a cached binding the server cannot re-verify is stated as last known, not as fact", async () => {
    await recordApprovedBinding(projectDir, {
      datamateId: 9,
      datamateName: "Finance",
      repoRemote: null,
      projectPath: projectDir,
      linkedAt: Date.now() - 10 * 60 * 1000,
    })
    const { expireValidationForTests } = await import("../../../src/altimate/workspace/state")
    expireValidationForTests(projectDir)
    globalThis.fetch = (async () => {
      throw new Error("offline")
    }) as unknown as typeof fetch
    const out = await inProject(systemSection)
    expect(out).toContain("was last known to be linked to Altimate Workspace id 9")
    expect(out).toContain('is "Finance"')
    expect(out).toContain("could not be re-verified just now")
    expect(out).not.toContain("This project is linked to Altimate Workspace id 9")
  })

  test("concurrent steps share one resolve (single-flight)", async () => {
    let attempts = 0
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    globalThis.fetch = (async () => {
      attempts++
      await gate
      throw new Error("offline")
    }) as unknown as typeof fetch
    const a = inProject(systemSection)
    const b = inProject(systemSection)
    const c = inProject(systemSection)
    release()
    const outs = await Promise.all([a, b, c])
    for (const out of outs) expect(out).toContain("could not be verified")
    // One network attempt per identifier probe, not one per concurrent step.
    expect(attempts).toBeLessThanOrEqual(2)
  })

  test("a resolve slower than the deadline does not stall the step: last known is rendered, memo fills later", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    globalThis.fetch = (async () => {
      await gate
      return new Response(JSON.stringify({ detail: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch
    const started = Date.now()
    const out = await inProject(systemSection)
    const waited = Date.now() - started
    expect(out).toContain("could not be verified just now")
    expect(waited).toBeLessThan(RESOLVE_DEADLINE_MS + 500)
    // The resolve was not abandoned: once it settles, the next step has the answer.
    release()
    expect(
      await eventually(async () => (await inProject(systemSection)).includes("No Altimate Workspace is linked")),
    ).toBe(true)
  })

  test("a slow re-verification of a cached binding renders it as last known, not as a stall", async () => {
    await recordApprovedBinding(projectDir, {
      datamateId: 5,
      datamateName: "Ops",
      repoRemote: null,
      projectPath: projectDir,
      linkedAt: Date.now() - 10 * 60 * 1000,
    })
    const { expireValidationForTests } = await import("../../../src/altimate/workspace/state")
    expireValidationForTests(projectDir)
    // First step: bound (served from cache while the server is asked).
    globalThis.fetch = (async () => {
      throw new Error("offline")
    }) as unknown as typeof fetch
    expect(await inProject(systemSection)).toContain("last known")
    resetOutcomeMemoForTests()
    // Now a server that never answers: the deadline renders the binding the local
    // cache holds, as last known — not the unknown copy, and not a stall.
    globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch
    const started = Date.now()
    const out = await inProject(systemSection)
    expect(Date.now() - started).toBeLessThan(RESOLVE_DEADLINE_MS + 500)
    expect(out).toContain("was last known to be linked to Altimate Workspace id 5")
    expect(out).toContain('is "Ops"')
    expect(out).not.toContain("could not be verified just now")
  })

  test("two projects under one account keep separate answers", async () => {
    const other = mkdtempSync(path.join(SANDBOX, "proj-"))
    await recordApprovedBinding(other, {
      datamateId: 11,
      datamateName: "Other",
      repoRemote: null,
      projectPath: other,
      linkedAt: Date.now(),
    })
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ detail: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch
    expect(await inProject(systemSection)).toContain("No Altimate Workspace is linked")
    expect(await Instance.provide({ directory: other, fn: systemSection })).toContain('is "Other"')
    expect(await inProject(systemSection)).toContain("No Altimate Workspace is linked")
  })

  test("the memo expires on the clock, not only on reset", async () => {
    let t = 1_000_000
    setClockForTests(() => t)
    let attempts = 0
    globalThis.fetch = (async () => {
      attempts++
      throw new Error("offline")
    }) as unknown as typeof fetch
    await inProject(systemSection)
    const first = attempts
    t += OUTCOME_MEMO_MS - 1
    await inProject(systemSection)
    expect(attempts).toBe(first)
    t += 2
    await inProject(systemSection)
    expect(attempts).toBeGreaterThan(first)
  })

  test("a link made in this process is seen on the next step, inside the window", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ detail: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch
    expect(await inProject(systemSection)).toContain("No Altimate Workspace is linked")
    await recordApprovedBinding(projectDir, {
      datamateId: 3,
      datamateName: "Linked",
      repoRemote: null,
      projectPath: projectDir,
      linkedAt: Date.now(),
    })
    expect(await inProject(systemSection)).toContain('is "Linked"')
  })

  test("a step arriving after an unlink does not join the pre-unlink resolve", async () => {
    // Step 1's resolve is out on the wire and the server's (pre-unlink) answer
    // will be "bound to old". The user unlinks. Step 2 arrives while step 1 is
    // still pending: it must start its own resolve, not join step 1's and
    // render the workspace the user just left.
    await recordApprovedBinding(projectDir, {
      datamateId: 8,
      datamateName: "old",
      repoRemote: null,
      projectPath: projectDir,
      linkedAt: Date.now() - 10 * 60 * 1000,
    })
    const { expireValidationForTests } = await import("../../../src/altimate/workspace/state")
    expireValidationForTests(projectDir)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let firstStarted!: () => void
    const firstOnWire = new Promise<void>((r) => (firstStarted = r))
    let secondStarted!: () => void
    const secondOnWire = new Promise<void>((r) => (secondStarted = r))
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      if (calls === 1) {
        firstStarted()
        await gate
        return new Response(
          JSON.stringify({
            binding: { id: 1, datamate_id: 8, datamate_name: "old", repo_remote: null, project_path: projectDir },
            datamate: { id: 8, name: "old" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      secondStarted()
      return new Response(JSON.stringify({ detail: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch
    const first = inProject(systemSection)
    await firstOnWire // step 1's request is out and parked on the gate
    await clearLocalBinding(projectDir, { scope: { tenant: "acme", apiUrl: "https://api.example.com" } })
    const second = inProject(systemSection)
    await secondOnWire // step 2 made its OWN request while step 1 was still pending
    release()
    const [, next] = await Promise.all([first, second])
    expect(calls).toBe(2)
    expect(next).not.toContain('is "old"')
    expect(next).toContain("No Altimate Workspace")
  })

  test("an account switch during the resolve is not filed under the first account's key", async () => {
    // Scope A is captured for the key; credentials change while the server is
    // being asked; the answer belongs to B and must not be memoised, or
    // rendered, as A's.
    const setCreds = (tenant: string) => {
      ;(AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials = async () =>
        ({ altimateInstanceName: tenant, altimateUrl: "https://api.example.com", altimateApiKey: "k" }) as Creds
    }
    const original = (AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials
    try {
      setCreds("acme")
      globalThis.fetch = (async () => {
        setCreds("other") // the switch lands mid-resolve
        return new Response(JSON.stringify({ detail: "not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        })
      }) as unknown as typeof fetch
      const out = await inProject(systemSection)
      expect(out).toContain("could not be verified")
      // Back on A within the window: nothing was memoised for A, so the resolver
      // is asked again rather than the identity memo answering.
      setCreds("acme")
      const realResolve = identityInternals.resolveBindingOutcome
      let resolves = 0
      identityInternals.resolveBindingOutcome = async (dir) => {
        resolves++
        return realResolve(dir)
      }
      try {
        expect(await inProject(systemSection)).toContain("No Altimate Workspace")
        expect(resolves).toBe(1)
      } finally {
        identityInternals.resolveBindingOutcome = realResolve
      }
    } finally {
      ;(AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials = original
    }
  })

  test("a memoised miss is stated as of the last check, not as fact", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ detail: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch
    // First ask: the server itself answered — definitive.
    expect(await inProject(systemSection)).toContain("No Altimate Workspace is linked to this project.")
    // Past the 30 s memo but inside the resolver's 5-minute miss memo: the
    // answer comes from that memo, and the copy says so.
    resetOutcomeMemoForTests()
    const out = await inProject(systemSection)
    expect(out).toContain("as of the last check, up to five minutes ago")
    expect(out).not.toContain("No Altimate Workspace is linked to this project.")
    expect(out).toContain("say that none was linked as of the last check")
    expect(out).not.toContain("say plainly that none is linked yet")
  })

  test("the deadline fallback never surfaces another account's cached binding", async () => {
    // Account A's resolve is pending; the account switches to B, which has a
    // cached binding for this directory. A's prompt must not render B's workspace.
    const setCreds = (tenant: string) => {
      ;(AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials = async () =>
        ({ altimateInstanceName: tenant, altimateUrl: "https://api.example.com", altimateApiKey: "k" }) as Creds
    }
    const original = (AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials
    try {
      setCreds("other")
      await recordApprovedBinding(projectDir, {
        datamateId: 99,
        datamateName: "theirs",
        repoRemote: null,
        projectPath: projectDir,
        linkedAt: Date.now(),
      })
      setCreds("acme")
      let switched = false
      globalThis.fetch = (() =>
        new Promise(() => {
          if (!switched) {
            switched = true
            setCreds("other") // lands while A's request hangs
          }
        })) as unknown as typeof fetch
      const out = await inProject(systemSection)
      expect(out).not.toContain('is "theirs"')
      expect(out).toContain("could not be verified")
    } finally {
      ;(AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials = original
    }
  })

  test("an expired bound memo is not rendered after an account switch either", async () => {
    // A has a bound memo past its window; A's resolve hangs; the account
    // switches to B before the deadline. The fallback must not hand A's
    // remembered workspace to the step now running as B.
    const setCreds = (tenant: string) => {
      ;(AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials = async () =>
        ({ altimateInstanceName: tenant, altimateUrl: "https://api.example.com", altimateApiKey: "k" }) as Creds
    }
    const original = (AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials
    try {
      setCreds("acme")
      await recordApprovedBinding(projectDir, {
        datamateId: 21,
        datamateName: "mine",
        repoRemote: null,
        projectPath: projectDir,
        linkedAt: Date.now(),
      })
      let t = 5_000_000
      setClockForTests(() => t)
      expect(await inProject(systemSection)).toContain('is "mine"') // memo filled for A
      t += OUTCOME_MEMO_MS + 1 // expired, but retained
      const { expireValidationForTests } = await import("../../../src/altimate/workspace/state")
      expireValidationForTests(projectDir)
      globalThis.fetch = (() =>
        new Promise(() => {
          setCreds("other") // the switch lands while A's request hangs
        })) as unknown as typeof fetch
      const out = await inProject(systemSection)
      expect(out).not.toContain('is "mine"')
      expect(out).toContain("could not be verified")
    } finally {
      ;(AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials = original
    }
  })

  test("a resolver that throws is remembered as unknown, not re-attempted every step", async () => {
    const real = identityInternals.resolveBindingOutcome
    let attempts = 0
    identityInternals.resolveBindingOutcome = async () => {
      attempts++
      throw new Error("boom")
    }
    try {
      let t = 9_000_000
      setClockForTests(() => t)
      expect(await inProject(systemSection)).toContain("could not be verified")
      expect(await inProject(systemSection)).toContain("could not be verified")
      expect(attempts).toBe(1)
      // A failure is remembered for less than a settled answer: past the
      // failure window (but well inside the outcome window) it is retried.
      t += FAILURE_MEMO_MS + 1
      expect(FAILURE_MEMO_MS).toBeLessThan(OUTCOME_MEMO_MS)
      await inProject(systemSection)
      expect(attempts).toBe(2)
    } finally {
      identityInternals.resolveBindingOutcome = real
    }
  })

  test("the deadline is bounded even when the fallback's own reads hang", async () => {
    // A hung server AND a credentials read that never returns: the step still
    // renders inside RESOLVE_DEADLINE_MS + FALLBACK_BUDGET_MS, as unknown.
    const original = (AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials
    let reads = 0
    ;(AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials = async () => {
      reads++
      // The first read builds the key; every later one (resolver, fallback) hangs.
      if (reads === 1) return { altimateInstanceName: "acme", altimateUrl: "https://api.example.com", altimateApiKey: "k" } as Creds
      return new Promise(() => {})
    }
    globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch
    try {
      const started = Date.now()
      const out = await inProject(systemSection)
      expect(Date.now() - started).toBeLessThan(RESOLVE_DEADLINE_MS + FALLBACK_BUDGET_MS + 300)
      expect(out).toContain("could not be verified")
    } finally {
      ;(AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials = original
    }
  })

  test("two accounts on one tenant do not share a memo entry", async () => {
    // Same tenant and host, different API key: the resolver's pin cache keys on the
    // credential for this reason, and so must this memo.
    const setKey = (apiKey: string) => {
      ;(AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials = async () =>
        ({ altimateInstanceName: "acme", altimateUrl: "https://api.example.com", altimateApiKey: apiKey }) as Creds
    }
    const original = (AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials
    try {
      setKey("key-of-alice")
      globalThis.fetch = (async () => {
        throw new Error("offline")
      }) as unknown as typeof fetch
      expect(await inProject(systemSection)).toContain("could not be verified")
      // Bob, same tenant, server reachable: must resolve for himself, not inherit Alice's outage.
      setKey("key-of-bob")
      const realResolve = identityInternals.resolveBindingOutcome
      let resolves = 0
      identityInternals.resolveBindingOutcome = async (dir) => {
        resolves++
        return realResolve(dir)
      }
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ detail: "not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch
      try {
        expect(await inProject(systemSection)).toContain("No Altimate Workspace")
        expect(resolves).toBe(1)
      } finally {
        identityInternals.resolveBindingOutcome = realResolve
      }
    } finally {
      ;(AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials = original
    }
  })

  test("a pinned session is described as pinned, with the routing caveat, never as the project's link", async () => {
    // The project's own cache names workspace 12; the IDE pin names 237 and the
    // server confirms the account can see it.
    await recordApprovedBinding(projectDir, {
      datamateId: 12,
      datamateName: "project-link",
      repoRemote: null,
      projectPath: projectDir,
      linkedAt: Date.now(),
    })
    const saved: Record<string, string | undefined> = {}
    const pinEnv: Record<string, string> = {
      ALTIMATE_CODE_SERVE: "1",
      ALTIMATE_PINNED_WORKSPACE_ID: "237",
      ALTIMATE_PINNED_WORKSPACE_NAME: "pinned-ws",
      ALTIMATE_PINNED_WORKSPACE_ROOT: projectDir,
    }
    for (const [k, v] of Object.entries(pinEnv)) {
      saved[k] = process.env[k]
      process.env[k] = v
    }
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ datamates: [{ id: 237, name: "pinned-ws-server" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch
    try {
      const out = await inProject(systemSection)
      expect(out).toContain("This session is pinned by the IDE extension to Altimate Workspace id 237")
      expect(out).toContain('is "pinned-ws-server"')
      expect(out).toContain("warehouse tool routing still follows the project's own link")
      expect(out).not.toContain("id 12")
      expect(out).not.toContain("This project is linked to")
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  test("under a pin, the deadline fallback never renders the project's own cached link", async () => {
    // Cold memo, pinned session, server slow: the fallback must not reach for the
    // workspace the pin exists to override.
    await recordApprovedBinding(projectDir, {
      datamateId: 12,
      datamateName: "project-link",
      repoRemote: null,
      projectPath: projectDir,
      linkedAt: Date.now(),
    })
    const saved: Record<string, string | undefined> = {}
    const pinEnv: Record<string, string> = {
      ALTIMATE_CODE_SERVE: "1",
      ALTIMATE_PINNED_WORKSPACE_ID: "237",
      ALTIMATE_PINNED_WORKSPACE_NAME: "pinned-ws",
      ALTIMATE_PINNED_WORKSPACE_ROOT: projectDir,
    }
    for (const [k, v] of Object.entries(pinEnv)) {
      saved[k] = process.env[k]
      process.env[k] = v
    }
    __resetPinValidation() // the previous test validated 237; this one must have to ask
    globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch
    try {
      const out = await inProject(systemSection)
      expect(out).toContain("could not be verified")
      expect(out).not.toContain('is "project-link"')
      expect(out).not.toContain("id 12")
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  test("degrades to the unverified copy outside an instance context rather than throwing", async () => {
    // `Instance.directory` throws outside a context; prompt assembly must not.
    const out = await systemSection()
    expect(out).toContain("could not be verified")
  })
})
