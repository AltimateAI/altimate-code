// Gate L2 repro 2 — NOT for commit.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { ensure, resetForTests, syncInternals, planForEntry, installWouldHelp, whenAttached, settledOutcome } from "../../../src/altimate/workspace/engine-sync"
import type { CachedBinding } from "../../../src/altimate/workspace/state"

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
  // ADAPTED ON LIFT: the finding is fixed. An entry MCP still knows about but
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
  // ADAPTED ON LIFT: the finding is fixed at its root rather than in the table.
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
  // GIVEN A REAL ASSERTION ON LIFT — it was a console.log, which is an
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
