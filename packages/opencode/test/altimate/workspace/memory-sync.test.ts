// altimate_change - new file
// Unit coverage for the workspace memory mirror
// (src/altimate/workspace/memory-{api,index,sync}.ts).
//
// Network is stubbed at globalThis.fetch, so assertions are about the requests
// the mirror actually issues — method, path, body — rather than a mock's call
// log. Cases claiming "nothing was sent" check a zero request count, not merely
// the absence of a throw.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, statSync } from "node:fs"
import path from "node:path"
import os from "node:os"

// Global.Path.state resolves at module load, so the sandbox must exist before
// the modules under test are imported.
const ORIGINAL_XDG_STATE_HOME = process.env.XDG_STATE_HOME
const ORIGINAL_WORKSPACE_FLAG = process.env.ALTIMATE_WORKSPACE
const SANDBOX = path.join(os.tmpdir(), `altimate-memsync-${process.pid}-${Date.now()}`)
mkdirSync(path.join(SANDBOX, "state"), { recursive: true })
process.env.XDG_STATE_HOME = path.join(SANDBOX, "state")
process.env.ALTIMATE_WORKSPACE = "1"

afterAll(() => {
  if (ORIGINAL_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = ORIGINAL_XDG_STATE_HOME
  if (ORIGINAL_WORKSPACE_FLAG === undefined) delete process.env.ALTIMATE_WORKSPACE
  else process.env.ALTIMATE_WORKSPACE = ORIGINAL_WORKSPACE_FLAG
  try {
    rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

const { indexKey, indexPath, readIndexEntry, recordIndexEntry } = await import(
  "../../../src/altimate/workspace/memory-index"
)
const {
  archiveBlock,
  backfill,
  belongsHere,
  buildMetadata,
  hydrate,
  isEnabled,
  mirrorBlock,
  overlayBlocks,
  resetOverlay,
  syncInternals,
  toBlock,
  whenHydrated,
} = await import("../../../src/altimate/workspace/memory-sync")
const { MIRROR_SOURCE, extractRecordId, LIST_LIMIT } = await import(
  "../../../src/altimate/workspace/memory-api"
)

import { AltimateApi } from "../../../src/altimate/api/client"

const originalIsConfigured = AltimateApi.isConfigured
const originalGetCreds = AltimateApi.getCredentials
type Creds = Awaited<ReturnType<typeof AltimateApi.getCredentials>>
function stubCreds(tenant: string, apiUrl: string, apiKey = "key-a") {
  ;(AltimateApi as unknown as { isConfigured: () => Promise<boolean> }).isConfigured = async () => true
  ;(AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials = async () =>
    ({ altimateInstanceName: tenant, altimateUrl: apiUrl, altimateApiKey: apiKey }) as Creds
}

interface Captured {
  method: string
  url: string
  body: any
}
const originalFetch = globalThis.fetch
let captured: Captured[] = []
let listResponse: any[] = []
let createResult: any = [{ id: "mem-new" }]
/** Workspaces returned by GET /datamates/ — drives the memory_enabled gate. */
let workspaces: any[] = [{ id: 42, name: "acme", memory_enabled: true }]
/** When set, GET /list fails -- used to prove a failed lookup never creates. */
let listFails = false

function stubFetch() {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input)
    const method = (init?.method ?? "GET").toUpperCase()
    captured.push({ method, url, body: init?.body ? JSON.parse(init.body) : undefined })
    if (listFails && url.includes("/datamates/memory/list")) {
      return new Response(JSON.stringify({ detail: "boom" }), { status: 500 })
    }
    const payload = (() => {
      // Server-side binding lookup, used when no local cache entry exists.
      if (url.includes("/datamate-project-bindings/by-")) {
        if (!serverBinding) return { detail: "not found" }
        return {
          binding: {
            id: 5,
            datamate_id: serverBinding.datamateId,
            datamate_name: serverBinding.datamateName,
            repo_remote: serverBinding.repoRemote,
            project_path: serverBinding.projectPath,
          },
          datamate: { id: serverBinding.datamateId, name: serverBinding.datamateName },
        }
      }
      if (url.includes("/datamates/memory/list")) return listResponse
      if (url.includes("/datamates/memory/")) {
        // A created record becomes visible to later reads, as it would on the
        // real service. Without this, anything that creates and then looks the
        // record up again sees an empty store.
        if (method === "POST") {
          const body = init?.body ? JSON.parse(init.body) : {}
          for (const rec of Array.isArray(createResult) ? createResult : []) {
            if (rec?.id) listResponse.push({ id: rec.id, memory: body.messages?.[0]?.content ?? "", metadata: body.metadata })
          }
        }
        return { message: "ok", result: createResult }
      }
      if (url.includes("/datamates/")) return { datamates: workspaces }
      return { message: "ok" }
    })()
    const status =
      url.includes("/datamate-project-bindings/by-") && !serverBinding ? 404 : 200
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof fetch
}

function callsTo(fragment: string, method?: string): Captured[] {
  return captured.filter((c) => c.url.includes(fragment) && (!method || c.method === method))
}

const SES = "ses_test"
const NOW = "2026-08-19T00:00:00.000Z"
function block(over: Partial<any> = {}): any {
  return {
    id: "warehouse/snowflake",
    scope: "global",
    tags: ["warehouse"],
    created: NOW,
    updated: NOW,
    content: "Snowflake account is acme-prod.",
    ...over,
  }
}

/** When set, the stubbed server reports this project as bound. Null means the
 * lookup 404s, exactly as an unbound remote does. */
let serverBinding: typeof BINDING | null = null

const BINDING = {
  datamateId: 42,
  datamateName: "acme",
  repoRemote: "ssh://git@github.com/acme/analytics.git",
  projectPath: "/work/analytics",
  linkedAt: 1,
}

beforeEach(() => {
  captured = []
  listResponse = []
  listFails = false
  createResult = [{ id: "mem-new" }]
  workspaces = [{ id: 42, name: "acme", memory_enabled: true }]
  serverBinding = null
  stubCreds("acme", "https://api.example.com")
  stubFetch()
  resetOverlay()
  syncInternals.resolveBinding = async () => BINDING as any
  // The store is not on disk in these tests; the delete-race guard has its
  // own coverage below.
  syncInternals.blockExists = async () => true
})

afterEach(() => {
  globalThis.fetch = originalFetch
  ;(AltimateApi as unknown as { isConfigured: typeof originalIsConfigured }).isConfigured =
    originalIsConfigured
  ;(AltimateApi as unknown as { getCredentials: typeof originalGetCreds }).getCredentials =
    originalGetCreds
  process.env.ALTIMATE_WORKSPACE = "1"
  delete syncInternals.resolveBinding
  delete syncInternals.blockExists
})

// ── record id extraction ────────────────────────────────────────────────────
describe("extractRecordId", () => {
  test("reads an id from each envelope the store is known to use", () => {
    expect(extractRecordId([{ id: "a" }])).toBe("a")
    expect(extractRecordId({ results: [{ id: "b" }] })).toBe("b")
    expect(extractRecordId({ memories: [{ id: "c" }] })).toBe("c")
    expect(extractRecordId({ data: [{ memory_id: "d" }] })).toBe("d")
  })

  test("reports nothing rather than guessing when no id is present", () => {
    // A declined create stores nothing and returns no usable id; inventing one
    // would index a record that does not exist.
    expect(extractRecordId(undefined)).toBeUndefined()
    expect(extractRecordId([])).toBeUndefined()
    expect(extractRecordId({ message: "nothing stored" })).toBeUndefined()
    expect(extractRecordId([{ nope: 1 }])).toBeUndefined()
  })
})

// ── index keying ────────────────────────────────────────────────────────────
describe("indexKey", () => {
  test("global keys ignore workspace and project", () => {
    expect(indexKey({ scope: "global", blockId: "b" })).toBe(
      indexKey({ scope: "global", blockId: "b", datamateId: 7, projectKey: "x" }),
    )
  })

  test("one block id in two projects of a workspace does not collide", () => {
    // Block ids are unique only within a project directory, so two bound
    // projects can each hold a 'warehouse/snowflake'.
    const a = indexKey({ scope: "project", blockId: "w/s", datamateId: 42, projectKey: "repo-a" })
    const b = indexKey({ scope: "project", blockId: "w/s", datamateId: 42, projectKey: "repo-b" })
    expect(a).not.toBe(b)
  })

  test("one project in two workspaces does not collide", () => {
    const a = indexKey({ scope: "project", blockId: "x", datamateId: 1, projectKey: "repo" })
    const b = indexKey({ scope: "project", blockId: "x", datamateId: 2, projectKey: "repo" })
    expect(a).not.toBe(b)
  })
})

describe("index persistence", () => {
  test("round-trips an entry and writes it 0600", async () => {
    const key = indexKey({ scope: "global", blockId: "round-trip" })
    await recordIndexEntry(key, { memoryId: "mem-1", contentHash: "h", syncedAt: 1 })
    expect((await readIndexEntry(key))?.memoryId).toBe("mem-1")
    expect(statSync(indexPath()).mode & 0o777).toBe(0o600)
  })

  test("a tenant switch invalidates the map", async () => {
    const key = indexKey({ scope: "global", blockId: "tenant-scoped" })
    await recordIndexEntry(key, { memoryId: "mem-tenant-a", contentHash: "h", syncedAt: 1 })
    stubCreds("other-tenant", "https://api.example.com")
    expect(await readIndexEntry(key)).toBeNull()
  })

  test("a different account on the same tenant does not inherit the map", async () => {
    // Records are per-user. Two people sharing a machine and a tenant would
    // otherwise update each other's records.
    const key = indexKey({ scope: "global", blockId: "account-scoped" })
    await recordIndexEntry(key, { memoryId: "mem-user-a", contentHash: "h", syncedAt: 1 })
    expect((await readIndexEntry(key))?.memoryId).toBe("mem-user-a")

    stubCreds("acme", "https://api.example.com", "key-b")
    expect(await readIndexEntry(key)).toBeNull()
  })
})

// ── gating ──────────────────────────────────────────────────────────────────
describe("gating", () => {
  test("disabled unless the pilot flag is set", () => {
    delete process.env.ALTIMATE_WORKSPACE
    expect(isEnabled()).toBe(false)
    process.env.ALTIMATE_WORKSPACE = "1"
    expect(isEnabled()).toBe(true)
  })

  test("a write issues no request at all when the flag is off", async () => {
    delete process.env.ALTIMATE_WORKSPACE
    await mirrorBlock(block({ id: "flag-off" }))
    expect(captured.length).toBe(0)
  })

  test("hydrate issues no request when the flag is off", async () => {
    delete process.env.ALTIMATE_WORKSPACE
    await hydrate("ses_flag_off")
    expect(captured.length).toBe(0)
    expect(overlayBlocks(SES)).toEqual([])
  })

  test("nothing is mirrored from an unbound directory, at either scope", async () => {
    // The mirror is inert until the user binds a project. Global blocks carry
    // no workspace themselves, but the binding is what makes the mirror active
    // and what carries the memory_enabled setting.
    syncInternals.resolveBinding = async () => null
    await mirrorBlock(block({ id: "unbound", scope: "project" }))
    await mirrorBlock(block({ id: "unbound-global", scope: "global" }))
    expect(captured.length).toBe(0)
  })

  test("hydration returns nothing from an unbound directory", async () => {
    syncInternals.resolveBinding = async () => null
    listResponse = [{ id: "1", memory: "x", metadata: { source: MIRROR_SOURCE, block_id: "x", block_scope: "global" } }]
    await hydrate(SES)
    expect(overlayBlocks(SES)).toEqual([])
  })
})

// ── metadata ────────────────────────────────────────────────────────────────
describe("buildMetadata", () => {
  test("project scope carries the workspace and the originating project", () => {
    const meta = buildMetadata(block({ scope: "project", tags: ["a", "b"] }), BINDING as any)
    expect(meta.datamate_id).toBe("42")
    expect(meta.datamate_name).toBe("acme")
    expect(meta.repo_remote).toBe(BINDING.repoRemote)
    expect(meta.project_path).toBe(BINDING.projectPath)
    expect(meta.source).toBe(MIRROR_SOURCE)
    expect(meta.block_scope).toBe("project")
    expect(meta.block_tags).toBe('["a","b"]')
  })

  test("global scope carries no workspace even when a binding exists", () => {
    // Global memory belongs to the account and applies in every workspace;
    // stamping a workspace would pin it to one and hide it from the others.
    const meta = buildMetadata(block({ scope: "global" }), BINDING as any)
    expect(meta.datamate_id).toBeUndefined()
    expect(meta.datamate_name).toBeUndefined()
    expect(meta.repo_remote).toBeUndefined()
    expect(meta.block_scope).toBe("global")
  })

  test("expiry is mirrored, so a TTL'd block can expire everywhere", () => {
    // Without this a TTL'd block lives forever in the workspace once it has
    // left the machine that wrote it, and is injected into every session.
    const meta = buildMetadata(block({ expires: "2027-01-01T00:00:00.000Z" }), null)
    expect(meta.block_expires).toBe("2027-01-01T00:00:00.000Z")
  })

  test("every record is marked private", () => {
    expect(buildMetadata(block(), null).visibility).toBe("private")
  })

  test("created and updated timestamps are carried", () => {
    const meta = buildMetadata(block({ created: NOW, updated: NOW }), null)
    expect(meta.block_created).toBe(NOW)
    expect(meta.block_updated).toBe(NOW)
  })
})

// ── write path ──────────────────────────────────────────────────────────────
describe("mirrorBlock", () => {
  test("a create is repaired with a verbatim update", async () => {
    // A create runs an extractor that rewrites the text; update() is verbatim,
    // so every create is followed by one.
    const b = block({ id: "repair-me" })
    createResult = [{ id: "mem-repair" }]
    await mirrorBlock(b)

    expect(callsTo("/datamates/memory/", "POST").length).toBe(1)
    const patches = callsTo("/datamates/memory/mem-repair", "PATCH")
    expect(patches.length).toBe(1)
    expect(patches[0].body.memory).toBe(b.content)
    expect(patches[0].body.metadata.block_id).toBe("repair-me")
  })

  test("a known block updates the record the index names", async () => {
    // The index supplies the id, so the update must never create. The record
    // set is still read: every safety check below the lookup needs it, and
    // when only `backfill` supplied one those checks were unreachable on the
    // ordinary per-save path.
    const b = block({ id: "known" })
    createResult = [{ id: "mem-known" }]
    await mirrorBlock(b)
    captured = []
    await mirrorBlock({ ...b, updated: "2026-08-20T00:00:00.000Z", content: "changed" })
    expect(callsTo("/datamates/memory/", "POST").length).toBe(0)
    expect(callsTo("/datamates/memory/mem-known", "PATCH").length).toBe(1)
  })

  test("a failed lookup defers instead of creating a duplicate", async () => {
    // Treating an unreadable record set as "no record exists" is how the same
    // block gets created twice.
    listFails = true
    await mirrorBlock(block({ id: "unreadable" }))
    expect(callsTo("/datamates/memory/", "POST").length).toBe(0)
  })

  test("a truncated read blocks a create on the ordinary save path", async () => {
    // The guard previously only ran under `backfill`, so per-save mirroring
    // still created duplicates of records sitting past the window.
    listResponse = Array.from({ length: LIST_LIMIT }, (_, i) => ({
      id: `mem-${i}`,
      memory: "other",
      metadata: { source: MIRROR_SOURCE, block_id: `other-${i}`, block_scope: "global" },
    }))
    await mirrorBlock(block({ id: "past-the-window" }))
    expect(callsTo("/datamates/memory/", "POST").length).toBe(0)
  })

  test("a record set larger than the limit is complete, not truncated", async () => {
    // The service ignores paging, so more rows than the limit proves the set
    // came back whole. Treating that as truncated would permanently block
    // creates for any user with a large workspace.
    listResponse = Array.from({ length: LIST_LIMIT + 1 }, (_, i) => ({
      id: `mem-${i}`,
      memory: "other",
      metadata: { source: MIRROR_SOURCE, block_id: `other-${i}`, block_scope: "global" },
    }))
    await mirrorBlock(block({ id: "still-creatable" }))
    expect(callsTo("/datamates/memory/", "POST").length).toBe(1)
  })

  test("the newer-remote guard applies on the ordinary save path", async () => {
    // Previously `remote` was only resolved from the backfill prefetch, so a
    // stale machine could overwrite a newer cloud value on every normal save.
    listResponse = [
      {
        id: "mem-newer",
        memory: "newer text from another machine",
        metadata: {
          source: MIRROR_SOURCE,
          block_id: "contested",
          block_scope: "global",
          block_updated: "2027-01-01T00:00:00.000Z",
        },
      },
    ]
    await mirrorBlock(block({ id: "contested", updated: NOW, content: "older local text" }))
    expect(callsTo("/datamates/memory/mem-newer", "PATCH").length).toBe(0)
  })

  test("an edit is still mirrored when its content collides under a 32-bit hash", async () => {
    // "fact loczw" and "fact vfbpa" share an FNV-1a 32-bit digest for the exact
    // payload contentHash builds. The hash is the only gate deciding whether a
    // save is sent, so under a 32-bit digest this edit is silently dropped with
    // no retry -- the block's cloud copy just stays wrong.
    const b = block({ id: "collide", tags: ["warehouse"], content: "fact loczw" })
    createResult = [{ id: "mem-collide" }]
    await mirrorBlock(b)
    captured = []
    await mirrorBlock({ ...b, content: "fact vfbpa", updated: "2026-08-20T00:00:00.000Z" })
    expect(callsTo("/datamates/memory/mem-collide", "PATCH").length).toBe(1)
  })

  test("the local-existence check uses the writing project, not the ambient one", async () => {
    // `mirrorBlock` is fire-and-forget: by the time it runs, the ambient
    // instance may be a different project. Resolving project scope from the
    // ambient directory then finds nothing and skips a perfectly good write as
    // "deleted". The directory captured at write time has to win.
    const seen: (string | undefined)[] = []
    const b = block({ id: "owned-elsewhere", scope: "project" })
    const { MemoryStore } = await import("../../../src/memory/store")
    const origRead = MemoryStore.read
    ;(MemoryStore as any).read = async (_s: string, _i: string, dir?: string) => {
      seen.push(dir)
      return b
    }
    delete syncInternals.blockExists
    try {
      await mirrorBlock(b, "/work/the-writing-project")
      expect(seen).toContain("/work/the-writing-project")
    } finally {
      ;(MemoryStore as any).read = origRead
      syncInternals.blockExists = async () => true
    }
  })

  test("a block deleted mid-sweep is not recreated", async () => {
    // `backfill` registers a block on the serialize queue only when a worker
    // dequeues it, so a delete issued during the sweep runs first. Without the
    // local-existence check this push creates a live record for a block the
    // user just deleted -- and indexes it, so no later sweep re-archives it.
    syncInternals.blockExists = async () => false
    await mirrorBlock(block({ id: "deleted-mid-sweep" }))
    expect(callsTo("/datamates/memory/", "POST").length).toBe(0)
  })

  test("a block deleted mid-sweep does not revive its archived record", async () => {
    const b = block({ id: "tombstoned" })
    createResult = [{ id: "mem-tomb" }]
    await mirrorBlock(b)
    // Archived remotely, and gone locally.
    listResponse = listResponse.map((r: any) =>
      r.id === "mem-tomb" ? { ...r, metadata: { ...r.metadata, archived: "true" } } : r,
    )
    syncInternals.blockExists = async () => false
    captured = []
    await mirrorBlock({ ...b, content: "changed", updated: "2027-01-01T00:00:00.000Z" })
    expect(callsTo("/datamates/memory/mem-tomb", "PATCH").length).toBe(0)
  })

  test("a recreated block gets a fresh record rather than un-archiving the old one", async () => {
    // `MemoryApi.update` replaces metadata wholesale, so updating the tombstone
    // would drop `archived` and bring the deleted record back to life.
    const b = block({ id: "reborn" })
    createResult = [{ id: "mem-old" }]
    await mirrorBlock(b)
    listResponse = listResponse.map((r: any) =>
      r.id === "mem-old" ? { ...r, metadata: { ...r.metadata, archived: "true" } } : r,
    )
    createResult = [{ id: "mem-new" }]
    captured = []
    await mirrorBlock({ ...b, content: "written again", updated: "2027-01-01T00:00:00.000Z" })
    expect(callsTo("/datamates/memory/mem-old", "PATCH").length).toBe(0)
    expect(callsTo("/datamates/memory/", "POST").length).toBe(1)
  })

  test("an unchanged block costs no read at all", async () => {
    // The content hash short-circuits before the record set is fetched, so a
    // no-op save stays free.
    const b = block({ id: "cheap" })
    createResult = [{ id: "mem-cheap" }]
    await mirrorBlock(b)
    captured = []
    await mirrorBlock(b)
    expect(callsTo("/datamates/memory/list").length).toBe(0)
    expect(callsTo("/datamates/memory/mem-cheap", "PATCH").length).toBe(0)
  })

  test("an unknown block looks for an existing record before creating one", async () => {
    // This is the convergence guarantee: a second machine, a reinstalled CLI,
    // or a create whose response was lost would otherwise duplicate the record.
    listResponse = [
      {
        id: "mem-elsewhere",
        memory: "written by another machine",
        metadata: { source: MIRROR_SOURCE, block_id: "converge", block_scope: "global" },
      },
    ]
    await mirrorBlock(block({ id: "converge" }))
    expect(callsTo("/datamates/memory/", "POST").length).toBe(0)
    expect(callsTo("/datamates/memory/mem-elsewhere", "PATCH").length).toBe(1)
  })

  test("re-saving an unchanged block sends nothing", async () => {
    const b = block({ id: "unchanged" })
    await mirrorBlock(b)
    captured = []
    await mirrorBlock(b)
    expect(captured.length).toBe(0)
  })

  test("a changed block updates the known record instead of creating a second", async () => {
    const b = block({ id: "changed" })
    createResult = [{ id: "mem-changed" }]
    await mirrorBlock(b)
    captured = []

    await mirrorBlock({ ...b, updated: "2026-08-20T00:00:00.000Z", content: "Now acme-staging." })
    expect(callsTo("/datamates/memory/", "POST").length).toBe(0)
    const patches = callsTo("/datamates/memory/mem-changed", "PATCH")
    expect(patches.length).toBe(1)
    expect(patches[0].body.memory).toBe("Now acme-staging.")
  })

  test("a block the store declines is not indexed, so a later edit retries", async () => {
    createResult = []
    await mirrorBlock(block({ id: "declined" }))
    expect(callsTo("/datamates/memory/", "POST").length).toBe(1)
    expect(captured.filter((c) => c.method === "PATCH").length).toBe(0)

    captured = []
    createResult = [{ id: "mem-later" }]
    await mirrorBlock(block({ id: "declined" }))
    expect(callsTo("/datamates/memory/", "POST").length).toBe(1)
  })

  test("an applied-count bump on a training block sends nothing", async () => {
    // incrementApplied rewrites a training block on EVERY session start to bump
    // a counter inside the content body. Mirroring that would cost a request
    // per training block per session.
    const meta = (applied: number) =>
      `<!-- training\nkind: rule\napplied: ${applied}\n-->\nAlways alias CTEs.`
    const b = block({ id: "training/rule/aliases", tags: ["training", "rule"], content: meta(1) })
    await mirrorBlock(b)
    captured = []
    await mirrorBlock({ ...b, updated: "2026-08-20T00:00:00.000Z", content: meta(2) })
    expect(captured.length).toBe(0)
  })

  test("a real edit to a training block still syncs", async () => {
    const meta = (n: number, body: string) => `<!-- training\nkind: rule\napplied: ${n}\n-->\n${body}`
    const b = block({ id: "training/rule/real", tags: ["training"], content: meta(1, "Alias CTEs.") })
    createResult = [{ id: "mem-real" }]
    await mirrorBlock(b)
    captured = []
    await mirrorBlock({ ...b, updated: "2026-08-20T00:00:00.000Z", content: meta(2, "Never alias.") })
    expect(callsTo("/datamates/memory/mem-real", "PATCH").length).toBe(1)
  })

  test("a tag-only change still syncs, since tags are mirrored", async () => {
    const b = block({ id: "tag-change" })
    createResult = [{ id: "mem-tags" }]
    await mirrorBlock(b)
    captured = []
    await mirrorBlock({ ...b, updated: "2026-08-20T00:00:00.000Z", tags: ["warehouse", "prod"] })
    expect(callsTo("/datamates/memory/mem-tags", "PATCH").length).toBe(1)
  })
})

// ── memory_enabled gate ─────────────────────────────────────────────────────
describe("memory_enabled", () => {
  test("nothing is written when the workspace has memory disabled", async () => {
    // The workspace app shows this as a toggle, so writing into a disabled
    // workspace would contradict what the user sees.
    workspaces = [{ id: 42, name: "acme", memory_enabled: false }]
    await mirrorBlock(block({ id: "disabled", scope: "global" }))
    expect(callsTo("/datamates/memory/", "POST").length).toBe(0)
  })

  test("enabling memory takes effect immediately, without waiting out a cache", async () => {
    // A workspace starts with memory disabled, so a user's first action is
    // often to switch it on. Caching the disabled verdict would ignore that
    // for a full TTL.
    workspaces = [{ id: 42, name: "acme", memory_enabled: false }]
    await mirrorBlock(block({ id: "before-enable" }))
    expect(callsTo("/datamates/memory/", "POST").length).toBe(0)

    workspaces = [{ id: 42, name: "acme", memory_enabled: true }]
  serverBinding = null
    captured = []
    await mirrorBlock(block({ id: "after-enable" }))
    expect(callsTo("/datamates/memory/", "POST").length).toBe(1)
  })

  test("the gate fails closed when the workspace cannot be read", async () => {
    workspaces = []
    await mirrorBlock(block({ id: "unknown-ws", scope: "global" }))
    expect(callsTo("/datamates/memory/", "POST").length).toBe(0)
  })
})

// ── read path ───────────────────────────────────────────────────────────────
describe("toBlock", () => {
  const record = (metadata: any, over: any = {}) => ({
    id: "rec",
    memory: "content here",
    created_at: NOW,
    updated_at: NOW,
    metadata,
    ...over,
  })

  test("maps metadata back onto block fields", () => {
    const b = toBlock(
      record({
        source: MIRROR_SOURCE,
        block_id: "warehouse/snowflake",
        block_scope: "project",
        block_updated: NOW,
        block_tags: "warehouse,prod",
      }),
      undefined,
    )
    expect(b?.id).toBe("warehouse/snowflake")
    expect(b?.scope).toBe("project")
    expect(b?.tags).toEqual(["warehouse", "prod"])
    expect(b?.content).toBe("content here")
    expect(b?.remote).toBe(true)
  })

  test("a record from a sibling project is labelled with its origin", () => {
    const b = toBlock(
      record({
        source: MIRROR_SOURCE,
        block_id: "x",
        block_scope: "project",
        repo_remote: "ssh://git@github.com/acme/other-repo.git",
      }),
      "ssh://git@github.com/acme/analytics.git",
    )
    expect(b?.origin).toBe("other-repo")
  })

  test("a record from this same project is not labelled", () => {
    const own = "ssh://git@github.com/acme/analytics.git"
    const b = toBlock(
      record({ source: MIRROR_SOURCE, block_id: "x", block_scope: "project", repo_remote: own }),
      own,
    )
    expect(b?.origin).toBeUndefined()
  })

  test("restores expiry from metadata", () => {
    const b = toBlock(
      record({
        source: MIRROR_SOURCE,
        block_id: "ttl",
        block_scope: "global",
        block_expires: "2027-01-01T00:00:00.000Z",
      }),
      undefined,
    )
    expect(b?.expires).toBe("2027-01-01T00:00:00.000Z")
  })

  test("rejects records that are not well-formed mirrored blocks", () => {
    expect(toBlock(record(null), undefined)).toBeNull()
    expect(toBlock(record({ source: MIRROR_SOURCE, block_scope: "global" }), undefined)).toBeNull()
    expect(toBlock(record({ source: MIRROR_SOURCE, block_id: "x", block_scope: "nope" }), undefined)).toBeNull()
    expect(
      toBlock(record({ source: MIRROR_SOURCE, block_id: "x", block_scope: "global" }, { memory: "" }), undefined),
    ).toBeNull()
  })
})

describe("tag encoding", () => {
  test("a tag containing a comma survives the round trip", () => {
    // The previous comma-joined form split this tag into two on read.
    const tags = ["warehouse", "owner: data, platform", "prod"]
    const meta = buildMetadata(block({ tags }), null)
    const back = toBlock(
      { id: "1", memory: "x", metadata: { ...meta, source: MIRROR_SOURCE } } as any,
      undefined,
    )
    expect(back?.tags).toEqual(tags)
  })

  test("records written in the legacy comma form still decode", () => {
    const back = toBlock(
      {
        id: "1",
        memory: "x",
        metadata: { source: MIRROR_SOURCE, block_id: "old", block_scope: "global", block_tags: "a,b" },
      } as any,
      undefined,
    )
    expect(back?.tags).toEqual(["a", "b"])
  })
})

describe("belongsHere", () => {
  const rec = (metadata: any) => ({ id: "r", memory: "m", metadata })

  test("global records apply everywhere, including with no workspace bound", () => {
    // Omitting this arm would make global memory write-only.
    expect(belongsHere(rec({ block_scope: "global" }), "42")).toBe(true)
    expect(belongsHere(rec({ block_scope: "global" }), undefined)).toBe(true)
  })

  test("a project record applies only to its own workspace", () => {
    expect(belongsHere(rec({ block_scope: "project", datamate_id: "42" }), "42")).toBe(true)
    expect(belongsHere(rec({ block_scope: "project", datamate_id: "99" }), "42")).toBe(false)
  })

  test("a project record is excluded when nothing is bound", () => {
    expect(belongsHere(rec({ block_scope: "project", datamate_id: "42" }), undefined)).toBe(false)
  })
})

describe("hydrate", () => {
  test("keeps only this CLI's records", async () => {
    // The discriminating case is the last one: block-shaped metadata written by
    // something else. Only the source check rejects it.
    listResponse = [
      { id: "1", memory: "cli", metadata: { source: MIRROR_SOURCE, block_id: "cli", block_scope: "global" } },
      { id: "2", memory: "chat", metadata: { datamate_id: "42" } },
      { id: "3", memory: "none", metadata: null },
      { id: "4", memory: "impostor", metadata: { block_id: "imp", block_scope: "global" } },
    ]
    await hydrate(SES)
    expect(overlayBlocks(SES).map((b) => b.id)).toEqual(["cli"])
  })

  test("drops records whose mirrored expiry has passed", async () => {
    // The cloud copy is not swept, so an expired block must be honoured on
    // read or it outlives its TTL on every other machine.
    listResponse = [
      { id: "1", memory: "live", metadata: { source: MIRROR_SOURCE, block_id: "live", block_scope: "global" } },
      {
        id: "2",
        memory: "stale",
        metadata: {
          source: MIRROR_SOURCE,
          block_id: "stale",
          block_scope: "global",
          block_expires: "2020-01-01T00:00:00.000Z",
        },
      },
    ]
    await hydrate(SES)
    expect(overlayBlocks(SES).map((b) => b.id)).toEqual(["live"])
  })

  test("drops archived records", async () => {
    listResponse = [
      { id: "1", memory: "live", metadata: { source: MIRROR_SOURCE, block_id: "live", block_scope: "global" } },
      { id: "2", memory: "gone", metadata: { source: MIRROR_SOURCE, block_id: "gone", block_scope: "global", archived: "true" } },
    ]
    await hydrate(SES)
    expect(overlayBlocks(SES).map((b) => b.id)).toEqual(["live"])
  })

  test("drops project records belonging to another workspace", async () => {
    listResponse = [
      { id: "1", memory: "g", metadata: { source: MIRROR_SOURCE, block_id: "g", block_scope: "global" } },
      { id: "2", memory: "other", metadata: { source: MIRROR_SOURCE, block_id: "other", block_scope: "project", datamate_id: "999" } },
    ]
    await hydrate(SES)
    expect(overlayBlocks(SES).map((b) => b.id)).toEqual(["g"])
  })

  test("opts in explicitly, or the backend returns nothing", async () => {
    // The backend excludes this client's records from list by default.
    listResponse = [{ id: "1", memory: "x", metadata: { source: MIRROR_SOURCE, block_id: "x", block_scope: "global" } }]
    await hydrate(SES)
    expect(callsTo("/datamates/memory/list")[0].url).toContain("include_sources=altimate-code")
  })

  test("is one-shot per session", async () => {
    listResponse = [{ id: "1", memory: "x", metadata: { source: MIRROR_SOURCE, block_id: "x", block_scope: "global" } }]
    await hydrate("ses_once")
    expect(callsTo("/datamates/memory/list").length).toBe(1)
    await hydrate("ses_once")
    expect(callsTo("/datamates/memory/list").length).toBe(1)
  })

  test("a failing fetch leaves an empty overlay rather than throwing", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down")
    }) as unknown as typeof fetch
    await hydrate(SES)
    expect(overlayBlocks(SES)).toEqual([])
  })

  test("returns nothing when the workspace has memory disabled", async () => {
    workspaces = [{ id: 42, name: "acme", memory_enabled: false }]
    listResponse = [{ id: "1", memory: "x", metadata: { source: MIRROR_SOURCE, block_id: "x", block_scope: "global" } }]
    await hydrate(SES)
    expect(overlayBlocks(SES)).toEqual([])
  })
})

describe("whenHydrated", () => {
  test("a hydration that blew its budget is not waited on again", async () => {
    // The promise stays unresolved, so without the timed-out latch every later
    // injection in the session would pay the full timeout again.
    let release: (() => void) | undefined
    const stall = new Promise<void>((r) => (release = r))
    const original = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: any) => {
      if (String(input).includes("/datamates/memory/list")) {
        await stall
      }
      return original(input, init)
    }) as typeof fetch

    try {
      void hydrate("stalled")
      const first = Date.now()
      await whenHydrated("stalled", 40)
      expect(Date.now() - first).toBeGreaterThanOrEqual(30)

      const second = Date.now()
      await whenHydrated("stalled", 40)
      expect(Date.now() - second).toBeLessThan(20)
    } finally {
      release?.()
      globalThis.fetch = original
    }
  })
})

describe("archiveBlock", () => {
  test("archives in place and never issues a DELETE", async () => {
    const b = block({ id: "to-archive" })
    createResult = [{ id: "mem-archive" }]
    await mirrorBlock(b)
    captured = []
    listResponse = [
      { id: "mem-archive", memory: b.content, metadata: { source: MIRROR_SOURCE, block_id: "to-archive", block_scope: "global" } },
    ]

    await archiveBlock("global", "to-archive")
    expect(captured.filter((c) => c.method === "DELETE").length).toBe(0)
    const patches = callsTo("/datamates/memory/mem-archive", "PATCH")
    expect(patches.length).toBe(1)
    expect(patches[0].body.metadata.archived).toBe("true")
    // Archiving hides a record from injection; it does not erase what it said.
    expect(patches[0].body.memory).toBe(b.content)
  })

  test("archives by logical identity when the local index cannot answer", async () => {
    // The index is per-machine and is discarded on account switch, corruption,
    // or a wiped state directory. Without this fallback a delete leaves the
    // record live and every later session re-injects it, with no way to remove it.
    listResponse = [
      {
        id: "mem-elsewhere",
        memory: "written by another machine",
        metadata: { source: MIRROR_SOURCE, block_id: "orphaned", block_scope: "global" },
      },
    ]
    await archiveBlock("global", "orphaned")
    const patches = callsTo("/datamates/memory/mem-elsewhere", "PATCH")
    expect(patches.length).toBe(1)
    expect(patches[0].body.metadata.archived).toBe("true")
  })

  test("does not archive another workspace's record with the same block id", async () => {
    listResponse = [
      {
        id: "mem-other-ws",
        memory: "different workspace",
        metadata: { source: MIRROR_SOURCE, block_id: "shared-id", block_scope: "project", datamate_id: "999" },
      },
    ]
    await archiveBlock("project", "shared-id")
    expect(captured.filter((c) => c.method === "PATCH").length).toBe(0)
  })

  test("does not archive a sibling project's record in the same workspace", async () => {
    // Same workspace, same block id, different project. Matching on workspace
    // alone would archive the wrong project's memory.
    listResponse = [
      {
        id: "mem-sibling",
        memory: "belongs to another project in this workspace",
        metadata: {
          source: MIRROR_SOURCE,
          block_id: "shared-id",
          block_scope: "project",
          datamate_id: "42",
          repo_remote: "ssh://git@github.com/acme/other.git",
        },
      },
    ]
    await archiveBlock("project", "shared-id")
    expect(captured.filter((c) => c.method === "PATCH").length).toBe(0)
  })

  test("archives this project's own record when the index is unavailable", async () => {
    listResponse = [
      {
        id: "mem-mine",
        memory: "belongs to this project",
        metadata: {
          source: MIRROR_SOURCE,
          block_id: "shared-id",
          block_scope: "project",
          datamate_id: "42",
          repo_remote: BINDING.repoRemote,
        },
      },
    ]
    await archiveBlock("project", "shared-id")
    expect(callsTo("/datamates/memory/mem-mine", "PATCH").length).toBe(1)
  })

  test("a delete issued during an in-flight mirror cannot resurrect the block", async () => {
    // Both hooks are fire-and-forget from the store. Unserialized, the archive
    // runs before the create it is meant to undo, and the mirror then leaves a
    // live record behind that later sessions rehydrate.
    const b = block({ id: "raced", scope: "global" })
    createResult = [{ id: "mem-raced" }]
    const mirroring = mirrorBlock(b)
    const archiving = archiveBlock("global", "raced")
    await Promise.all([mirroring, archiving])
    const patches = callsTo("/datamates/memory/mem-raced", "PATCH")
    const archivePatch = patches.find((c) => c.body?.metadata?.archived === "true")
    expect(archivePatch).toBeDefined()
  })

  test("an already-archived record is not archived again", async () => {
    listResponse = [
      {
        id: "mem-done",
        memory: "x",
        metadata: { source: MIRROR_SOURCE, block_id: "done", block_scope: "global", archived: "true" },
      },
    ]
    await archiveBlock("global", "done")
    expect(captured.filter((c) => c.method === "PATCH").length).toBe(0)
  })
})

describe("backfill", () => {
  // Ids are unique per test: the index file lives in the sandbox and persists
  // across tests, so reused ids would be skipped as already-synced rather than
  // exercising the path under test.
  const blocks = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) =>
      block({ id: `${prefix}/${i}`, content: `Block ${prefix} ${i} describes a warehouse convention.` }),
    )

  test("reads the record set once for the whole sweep, not once per block", async () => {
    // Every block in a first bind is an index miss, so resolving each through
    // its own lookup made a bind cost one full fetch per block.
    createResult = [{ id: "mem-x" }]
    await backfill(blocks("once", 5), BINDING as any)
    expect(callsTo("/datamates/memory/list").length).toBe(1)
  })

  test("counts declines separately from stored blocks", async () => {
    // Reporting a decline as success made a sweep claim it had seeded blocks
    // the service never kept.
    createResult = []
    const result = await backfill(blocks("declined", 3), BINDING as any)
    expect(result.declined).toBe(3)
    expect(result.ok).toBe(0)
  })

  test("skips blocks already synced at their current payload", async () => {
    createResult = [{ id: "mem-resume" }]
    const set = blocks("resume", 2)
    await backfill(set, BINDING as any)
    captured = []
    const second = await backfill(set, BINDING as any)
    expect(second.skipped).toBe(2)
    expect(callsTo("/datamates/memory/", "POST").length).toBe(0)
  })

  test("does nothing when the workspace has memory disabled", async () => {
    workspaces = [{ id: 42, name: "acme", memory_enabled: false }]
    const result = await backfill(blocks("disabled", 2), BINDING as any)
    expect(result.skipped).toBe(2)
    expect(callsTo("/datamates/memory/", "POST").length).toBe(0)
  })
})

describe("truncated reads", () => {
  test("refuses to create against a record set that hit the service limit", async () => {
    // The record may exist just beyond the window, so creating would duplicate
    // it. Leaving the block unindexed means a later save retries.
    listResponse = Array.from({ length: 200 }, (_, i) => ({
      id: `r${i}`,
      memory: "x",
      metadata: { source: MIRROR_SOURCE, block_id: `other/${i}`, block_scope: "global" },
    }))
    const result = await backfill([block({ id: "beyond/window" })], BINDING as any)
    expect(callsTo("/datamates/memory/", "POST").length).toBe(0)
    expect(result.skipped).toBeGreaterThan(0)
  })
})

describe("session isolation and turn behaviour", () => {
  test("a session hydrates once, however many turns it takes", async () => {
    // The caller's enclosing block runs on EVERY user turn, not once per
    // session. Without idempotence a 20-turn conversation costs 40 requests,
    // and the first injection of every turn blocks on them.
    listResponse = [
      { id: "1", memory: "x", metadata: { source: MIRROR_SOURCE, block_id: "x", block_scope: "global" } },
    ]
    await hydrate(SES)
    await hydrate(SES)
    await hydrate(SES)
    expect(callsTo("/datamates/memory/list").length).toBe(1)
    expect(overlayBlocks(SES).map((b) => b.id)).toEqual(["x"])
  })

  test("a second turn never empties the overlay while refetching", async () => {
    // Clearing before a refetch made workspace memory blink out of the prompt
    // on any turn whose fetch ran long.
    listResponse = [
      { id: "1", memory: "x", metadata: { source: MIRROR_SOURCE, block_id: "kept", block_scope: "global" } },
    ]
    await hydrate(SES)
    expect(overlayBlocks(SES).length).toBe(1)
    await hydrate(SES)
    expect(overlayBlocks(SES).length).toBe(1)
  })

  test("two concurrent sessions do not read each other's overlay", async () => {
    // A shared module-level overlay let a session in one workspace be injected
    // with another workspace's private memory.
    listResponse = [
      { id: "a", memory: "alpha", metadata: { source: MIRROR_SOURCE, block_id: "alpha", block_scope: "global" } },
    ]
    await hydrate("ses_a")

    listResponse = [
      { id: "b", memory: "beta", metadata: { source: MIRROR_SOURCE, block_id: "beta", block_scope: "global" } },
    ]
    await hydrate("ses_b")

    expect(overlayBlocks("ses_a").map((b) => b.id)).toEqual(["alpha"])
    expect(overlayBlocks("ses_b").map((b) => b.id)).toEqual(["beta"])
  })

  test("overlayBlocks returns a copy, so a caller cannot corrupt the cache", async () => {
    listResponse = [
      { id: "1", memory: "x", metadata: { source: MIRROR_SOURCE, block_id: "x", block_scope: "global" } },
    ]
    await hydrate(SES)
    overlayBlocks(SES).length = 0
    expect(overlayBlocks(SES).length).toBe(1)
  })

  test("resetting one session leaves the others intact", async () => {
    listResponse = [
      { id: "a", memory: "alpha", metadata: { source: MIRROR_SOURCE, block_id: "alpha", block_scope: "global" } },
    ]
    await hydrate("ses_a")
    await hydrate("ses_b")
    resetOverlay("ses_a")
    expect(overlayBlocks("ses_a")).toEqual([])
    expect(overlayBlocks("ses_b").map((b) => b.id)).toEqual(["alpha"])
  })
})

describe("whenHydrated", () => {
  test("returns immediately when no hydration is in flight", async () => {
    resetOverlay()
    const started = Date.now()
    await whenHydrated(SES, 5_000)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test("gives up on a hydration that never settles rather than blocking the prompt", async () => {
    globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch
    void hydrate("ses_stalled")
    const started = Date.now()
    await whenHydrated("ses_stalled", 150)
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(100)
    expect(elapsed).toBeLessThan(2_000)
  })
})

// ── binding resolution ──────────────────────────────────────────────────────
describe("binding resolution for the mirror", () => {
  test("mirrors from a directory bound only on the server", async () => {
    // The local cache is written only by an explicit link, so a directory
    // holding a repo that IS bound — a git worktree, a second clone, a
    // teammate's checkout — has no entry. Reading only that cache made the
    // mirror a silent no-op in every one of those.
    delete syncInternals.resolveBinding
    serverBinding = BINDING
    const dir = path.join(SANDBOX, "server-bound-proj")
    mkdirSync(dir, { recursive: true })

    await mirrorBlock(block(), dir)

    const posts = captured.filter(
      (c) => c.method === "POST" && c.url.includes("/datamates/memory/"),
    )
    expect(posts.length).toBe(1)
  })

  test("an unbound directory still mirrors nothing", async () => {
    // The fallback must not invent a binding: a 404 means unbound, and an
    // unbound directory has no workspace to attribute a memory to.
    delete syncInternals.resolveBinding
    serverBinding = null
    const dir = path.join(SANDBOX, "genuinely-unbound-proj")
    mkdirSync(dir, { recursive: true })

    await mirrorBlock(block(), dir)

    const posts = captured.filter(
      (c) => c.method === "POST" && c.url.includes("/datamates/memory/"),
    )
    expect(posts.length).toBe(0)
  })
})
