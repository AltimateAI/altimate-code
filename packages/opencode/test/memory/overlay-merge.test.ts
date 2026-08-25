// altimate_change - new file
// Covers the injection-side merge of workspace memory into local memory:
// which blocks survive, and the guard that keeps a cloud-sourced training
// block from writing to the local store.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import os from "node:os"

const ORIGINAL_DATA = process.env.XDG_DATA_HOME
const ORIGINAL_STATE = process.env.XDG_STATE_HOME
const ORIGINAL_FLAG = process.env.ALTIMATE_WORKSPACE
const SANDBOX = mkdtempSync(path.join(os.tmpdir(), `altimate-overlay-${process.pid}-`))
mkdirSync(path.join(SANDBOX, "data"), { recursive: true })
mkdirSync(path.join(SANDBOX, "state"), { recursive: true })
process.env.XDG_DATA_HOME = path.join(SANDBOX, "data")
process.env.XDG_STATE_HOME = path.join(SANDBOX, "state")
process.env.ALTIMATE_WORKSPACE = "1"

afterAll(() => {
  if (ORIGINAL_DATA === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = ORIGINAL_DATA
  if (ORIGINAL_STATE === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = ORIGINAL_STATE
  if (ORIGINAL_FLAG === undefined) delete process.env.ALTIMATE_WORKSPACE
  else process.env.ALTIMATE_WORKSPACE = ORIGINAL_FLAG
  try {
    rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

const { MemoryPrompt } = await import("../../src/memory/prompt")
const { MIRROR_SOURCE } = await import("../../src/altimate/workspace/memory-api")
const { hydrate, resetOverlay, syncInternals } = await import(
  "../../src/altimate/workspace/memory-sync"
)
const { TrainingStore } = await import("../../src/altimate/training/store")
const { Global } = await import("../../src/global")

/** Resolved from Global rather than assumed: whether the sandbox env is picked
 * up depends on when Global.Path is evaluated relative to module loading. */
const GLOBAL_MEMORY_DIR = path.join(Global.Path.data, "memory")

import { AltimateApi } from "../../src/altimate/api/client"

const originalIsConfigured = AltimateApi.isConfigured
const originalGetCreds = AltimateApi.getCredentials
const originalFetch = globalThis.fetch
const originalIncrement = TrainingStore.incrementApplied

const SES = "ses_overlay"
const NOW = "2026-08-19T00:00:00.000Z"
const BINDING = {
  datamateId: 7,
  datamateName: "acme",
  repoRemote: "ssh://git@github.com/acme/analytics.git",
  projectPath: "/work/analytics",
  linkedAt: 1,
}

let listResponse: any[] = []
let incrementCalls: string[] = []

/** Writes a real block to the sandboxed global memory directory. */
function writeLocalBlock(id: string, content: string, tags: string[] = []) {
  const dir = path.join(GLOBAL_MEMORY_DIR, ...id.split("/").slice(0, -1))
  mkdirSync(dir, { recursive: true })
  const frontmatter = [
    "---",
    `id: ${id}`,
    "scope: global",
    `created: ${NOW}`,
    `updated: ${NOW}${tags.length ? `\ntags: ${JSON.stringify(tags)}` : ""}`,
    "---",
    "",
    content,
    "",
  ].join("\n")
  writeFileSync(path.join(GLOBAL_MEMORY_DIR, `${id}.md`), frontmatter)
}

beforeEach(() => {
  listResponse = []
  incrementCalls = []
  ;(AltimateApi as any).isConfigured = async () => true
  ;(AltimateApi as any).getCredentials = async () => ({
    altimateInstanceName: "acme",
    altimateUrl: "https://api.example.com",
    altimateApiKey: "key",
  })
  globalThis.fetch = (async (input: any) => {
    const url = String(input)
    const payload = url.includes("/datamates/memory/list")
      ? listResponse
      : url.includes("/datamates/")
        ? { datamates: [{ id: 7, name: "acme", memory_enabled: true }] }
        : { message: "ok" }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof fetch
  ;(TrainingStore as any).incrementApplied = async (_s: string, _k: string, name: string) => {
    incrementCalls.push(name)
  }
  syncInternals.resolveBinding = async () => BINDING as any
  resetOverlay()
  MemoryPrompt.resetSession()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  ;(AltimateApi as any).isConfigured = originalIsConfigured
  ;(AltimateApi as any).getCredentials = originalGetCreds
  ;(TrainingStore as any).incrementApplied = originalIncrement
  delete syncInternals.resolveBinding
  rmSync(GLOBAL_MEMORY_DIR, { recursive: true, force: true })
})

const remote = (id: string, content: string, extra: Record<string, unknown> = {}) => ({
  id: `rec-${id}`,
  memory: content,
  created_at: NOW,
  updated_at: NOW,
  metadata: { source: MIRROR_SOURCE, block_id: id, block_scope: "global", ...extra },
})

describe("workspace memory in the injected prompt", () => {
  test("a cloud block with no local counterpart is injected", async () => {
    listResponse = [remote("warehouse/sizing", "ANALYTICS_WH must not be resized without asking.")]
    await hydrate(SES)
    const injected = await MemoryPrompt.inject(20000, { sessionID: SES })
    expect(injected).toContain("ANALYTICS_WH must not be resized")
  })

  test("the local copy wins when both hold the same block", async () => {
    // A cloud record may have been edited by a client that does not preserve
    // this CLI's metadata, so the file on disk is authoritative.
    writeLocalBlock("warehouse/sizing", "LOCAL: ask the data team before resizing.")
    listResponse = [remote("warehouse/sizing", "REMOTE: stale copy of the same block.")]
    await hydrate(SES)
    const injected = await MemoryPrompt.inject(20000, { sessionID: SES })
    expect(injected).toContain("LOCAL: ask the data team")
    expect(injected).not.toContain("REMOTE: stale copy")
  })

  test("a sibling project's block survives an id collision and is labelled", async () => {
    // Block ids are unique only within a project directory, so the same id in
    // two projects means two different blocks — not a duplicate.
    writeLocalBlock("warehouse/sizing", "LOCAL: this project's own note.")
    listResponse = [
      remote("warehouse/sizing", "SIBLING: another project's note.", {
        block_scope: "project",
        datamate_id: "7",
        repo_remote: "ssh://git@github.com/acme/other-repo.git",
      }),
    ]
    await hydrate(SES)
    const injected = await MemoryPrompt.inject(20000, { sessionID: SES })
    expect(injected).toContain("LOCAL: this project's own note")
    expect(injected).toContain("SIBLING: another project's note")
    expect(injected).toContain("other-repo")
  })

  test("no overlay is merged when the caller has no session", async () => {
    listResponse = [remote("warehouse/sizing", "REMOTE ONLY")]
    await hydrate(SES)
    const injected = await MemoryPrompt.inject(20000, {})
    expect(injected).not.toContain("REMOTE ONLY")
  })

  test("a sibling project's training entry is labelled with its origin", async () => {
    // mergeOverlay deliberately keeps both when a sibling shares an id with
    // this project's block, so an unlabelled entry leaves the model with two
    // identical headings it cannot tell apart. formatBlock labels these;
    // formatTrainingEntry has to as well.
    listResponse = [
      remote("training/rule/shared", "Partition by event_date.", {
        block_scope: "project",
        datamate_id: "7",
        repo_remote: "ssh://git@github.com/acme/other.git",
        block_tags: '["training","rule"]',
      }),
    ]
    await hydrate(SES)
    const injected = await MemoryPrompt.inject(20000, { sessionID: SES })
    expect(injected).toContain("Partition by event_date.")
    expect(injected).toContain("from workspace project")
  })

  test("a remote training block never drives the local applied counter", async () => {
    // incrementApplied writes to the LOCAL store; firing it for a block this
    // machine never had would fabricate a file from the cloud copy.
    writeLocalBlock("training/rule/local-one", "Always alias CTEs.", ["training", "rule"])
    listResponse = [
      remote("training/rule/remote-one", "Never use FLOAT for money.", {
        block_tags: "training,rule",
      }),
    ]
    await hydrate(SES)
    await MemoryPrompt.inject(20000, { sessionID: SES })
    expect(incrementCalls).toContain("local-one")
    expect(incrementCalls).not.toContain("remote-one")
  })
})
