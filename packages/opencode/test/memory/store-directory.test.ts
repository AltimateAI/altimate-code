// The workspace flag is read at module load, so it must be set before the
// modules under test are imported.
process.env.ALTIMATE_WORKSPACE = "1"

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { MemoryStore } from "@/memory/store"

// Exercises the REAL store, unlike store.test.ts which re-implements its logic
// and so cannot catch path-resolution bugs. Callers outside an Instance context
// -- the `link` subcommand is one -- pass `directory` explicitly; every step of
// the read path has to honour it, not just the directory scan.
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
})
