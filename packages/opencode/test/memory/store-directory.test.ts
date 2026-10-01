// The workspace flag is read at module load, so it must be set before the
// modules under test are imported -- and restored afterwards so it does not
// leak into unrelated suites sharing this process.
const ORIGINAL_WORKSPACE_FLAG = process.env.ALTIMATE_WORKSPACE
process.env.ALTIMATE_WORKSPACE = "1"

import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { MemoryStore } from "@/memory/store"

// Exercises the REAL store, unlike store.test.ts which re-implements its logic
// and so cannot catch path-resolution bugs. Callers outside an Instance context
// -- the `link` subcommand is one -- pass `directory` explicitly; every step of
// the read path has to honour it, not just the directory scan.
afterAll(() => {
  if (ORIGINAL_WORKSPACE_FLAG === undefined) delete process.env.ALTIMATE_WORKSPACE
  else process.env.ALTIMATE_WORKSPACE = ORIGINAL_WORKSPACE_FLAG
})

describe("MemoryStore project scope with an explicit directory", () => {
  let proj: string

  beforeEach(async () => {
    proj = await fs.mkdtemp(path.join(os.tmpdir(), "store-dir-"))
    const dir = path.join(proj, ".altimate-code", "memory")
    await fs.mkdir(dir, { recursive: true })
    const now = new Date().toISOString()
    await fs.writeFile(
      path.join(dir, "proj-block.md"),
      ["---", "id: proj-block", "scope: project", `created: ${now}`, `updated: ${now}`, "---", "", "A project fact.", ""].join("\n"),
    )
  })

  afterEach(async () => {
    await fs.rm(proj, { recursive: true, force: true })
  })

  test("list reads the blocks it scanned, not the ambient directory's", async () => {
    // Regression: `list` scanned `directory` but `read` re-resolved the path
    // from the ambient instance, so every block it found came back undefined.
    const blocks = await MemoryStore.list("project", { directory: proj })
    expect(blocks.map((b) => b.id)).toEqual(["proj-block"])
    expect(blocks[0].content).toBe("A project fact.")
  })

  test("read honours an explicit directory", async () => {
    const block = await MemoryStore.read("project", "proj-block", proj)
    expect(block?.content).toBe("A project fact.")
  })

  test("listAll surfaces project blocks with no instance context", async () => {
    const blocks = await MemoryStore.listAll({ directory: proj })
    expect(blocks.some((b) => b.id === "proj-block")).toBe(true)
  })

  test("listAll still returns global blocks when project scope cannot resolve", async () => {
    // No directory and no instance: project scope throws. It must not take
    // global memory down with it.
    const blocks = await MemoryStore.listAll()
    expect(Array.isArray(blocks)).toBe(true)
    expect(blocks.every((b) => b.scope === "global")).toBe(true)
  })

  // `remove` deletes a file, so its directory has to reach every step. These
  // run against the real store on purpose: the reaper's test seams stub the
  // removal out, so a wrong-directory unlink or a missing audit entry would
  // pass there. (review)
  test("remove with an explicit directory deletes that project's file and logs there", async () => {
    const removed = await MemoryStore.remove("project", "proj-block", proj)
    expect(removed).toBe(true);

    await expect(
      fs.access(path.join(proj, ".altimate-code", "memory", "proj-block.md"))
    ).rejects.toThrow()

    // The audit entry lands beside the file it describes. Resolved from the
    // ambient instance instead, it was written to whichever project happened to
    // be current — or threw, with the file already gone.
    const log = await fs.readFile(path.join(proj, ".altimate-code", "memory", ".log"), "utf-8")
    expect(log).toContain("DELETE project/proj-block")
  })

  test("remove with no instance context still records the deletion", async () => {
    // The headless refresh path has no instance. `auditLogPath` resolves project
    // scope through `Instance.directory`, which THROWS there — and it used to be
    // called outside the best-effort try, so the rejection escaped a function
    // that had already unlinked the file. (review)
    await expect(MemoryStore.remove("project", "proj-block", proj)).resolves.toBe(true)
    const log = await fs.readFile(path.join(proj, ".altimate-code", "memory", ".log"), "utf-8")
    expect(log).toContain("DELETE project/proj-block")
  })

  test("remove keeps a block that changed after the caller read it", async () => {
    // The caller decided from a value it read earlier; `write` renames a newer
    // file into place. Without the condition the newer edit is deleted.
    const stale = "2020-01-01T00:00:00.000Z"
    const removed = await MemoryStore.remove("project", "proj-block", proj, { expectUpdated: stale })

    expect(removed).toBe(false)
    const block = await MemoryStore.read("project", "proj-block", proj)
    expect(block?.content).toBe("A project fact.")
  })

  test("remove proceeds when the block is still what the caller read", async () => {
    const before = await MemoryStore.read("project", "proj-block", proj)
    const removed = await MemoryStore.remove("project", "proj-block", proj, {
      expectUpdated: before!.updated,
    })

    expect(removed).toBe(true)
    expect(await MemoryStore.read("project", "proj-block", proj)).toBeUndefined()
  })

  test("remove reports false for a block that is already gone", async () => {
    expect(await MemoryStore.remove("project", "no-such-block", proj)).toBe(false)
  })
})
