// altimate_change - new file
//
// The freshness invariant, asserted by OBSERVING staleness rather than by
// observing that a read went through the right function.
//
// The previous version of this check verified that config reads route through
// the refreshing accessor. That is a real property, but it is not the one the
// name claims — and deleting `Config.invalidate()` from the accessor, from
// `persist`, or from `persistRestore` left the whole suite green. A test named
// "every config read is fresh" that survives the removal of every invalidation
// is asserting something other than freshness.
//
// This file mocks `Config` with a cache that only updates when invalidated, so
// a stale read is directly observable: write to the "file", read, and see
// whether the write is visible.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Config } from "../../../src/config/config"
import { existingEntry } from "../../../src/altimate/workspace/engine-config"
import { syncInternals } from "../../../src/altimate/workspace/engine-seams"

// Spies rather than a module mock. `mock.module` is registered process-wide and
// cannot be unregistered, so mocking the config module from here took down every
// later test file in the run that builds a real Config layer — a test file that
// breaks unrelated suites is worse than the gap it closes.
let fileContents: { mcp?: Record<string, unknown> } = {}
let cached: { mcp?: Record<string, unknown> } | null = null
let invalidations = 0
let getSpy: ReturnType<typeof spyOn>
let invalidateSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  fileContents = {}
  cached = null
  invalidations = 0
  // Models the real thing: `get()` is cached per instance and does NOT see a
  // write made behind it until something invalidates.
  getSpy = spyOn(Config, "get").mockImplementation(async () => {
    if (cached === null) cached = structuredClone(fileContents)
    return cached as never
  })
  invalidateSpy = spyOn(Config, "invalidate").mockImplementation(async () => {
    invalidations += 1
    cached = null
  })
  delete syncInternals.existingEntry
  delete syncInternals.freshConfig
})

afterEach(() => {
  getSpy.mockRestore()
  invalidateSpy.mockRestore()
  for (const key of Object.keys(syncInternals) as Array<keyof typeof syncInternals>) delete syncInternals[key]
})

describe("INVARIANT — a config read observes writes made behind it", () => {
  test("an external write between two reads is visible to the second", async () => {
    fileContents = { mcp: { datamate: { type: "local", command: ["datamate", "start-stdio"], enabled: true } } }
    const before = await existingEntry("datamate")
    expect(before?.enabled).toBe(true)

    // An IDE, another process, or `/mcps disable` writes the file. Nothing tells
    // this process; the write never goes through `Config` at all.
    fileContents = { mcp: { datamate: { type: "local", command: ["datamate", "start-stdio"], enabled: false } } }

    const after = await existingEntry("datamate")
    expect(after?.enabled, "read a cached config and missed a write made behind it").toBe(false)
  })

  test("an entry added externally after the cache warmed is seen", async () => {
    fileContents = { mcp: {} }
    expect(await existingEntry("datamate")).toBeNull()
    fileContents = { mcp: { datamate: { type: "local", command: ["datamate", "start-stdio", "--datamate", "5"] } } }
    expect(await existingEntry("datamate"), "missed an entry an IDE added after the cache warmed").not.toBeNull()
  })

  test("freshness costs an invalidation per read, which is the trade being made", async () => {
    // Named rather than hidden: invalidating drops the per-instance cache for
    // every other Config consumer too. That is the price of not having a fourth
    // instance of the stale-read defect.
    fileContents = { mcp: {} }
    await existingEntry("datamate")
    await existingEntry("datamate")
    expect(invalidations).toBe(2)
  })
})

describe("INVARIANT #13 at the reader — a failed read propagates, never becomes null", () => {
  test("a config read that throws does not arrive at the caller as 'there is no entry'", async () => {
    // The layer that matters. A guard above this one was written to fail closed
    // on a throwing intent read — and could never fire, because this reader
    // caught the throw and returned `null`, which every caller reads as "there
    // is no entry": the guard as "nothing forbids this write", the inspection as
    // "nothing here, spawn". A rule enforced at one layer and undone at the
    // layer below is not enforced.
    //
    // Asserted HERE rather than through a stubbed seam, because a seam-level
    // test cannot see a swallow that happens beneath the seam — which is exactly
    // why the defect survived the invariant that was supposed to state it.
    getSpy.mockImplementation(async () => {
      throw new Error("EIO: config unreadable")
    })
    await expect(existingEntry("datamate")).rejects.toThrow("EIO")
  })

  test("a genuinely absent entry is still null, not an error", async () => {
    // The distinction is the whole point: absent and unreadable must stay
    // different answers, or the caller cannot act differently on them.
    fileContents = { mcp: {} }
    expect(await existingEntry("datamate")).toBeNull()
  })
})

describe("INVARIANT — the restore reports failure from the real write, not just the seam", () => {
  test("an unwritable config file yields 'failed', which is what raises the toast", async () => {
    // The suite's "undo that could not be confirmed" test stubs the seam to
    // RETURN "failed" — so the production path that decides to return it was
    // never exercised, and making it return "restored" instead left everything
    // green. Same layer-below shape that hid the reader's swallow.
    const { persistRestore } = await import("../../../src/altimate/workspace/engine-config")
    const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const path = await import("node:path")

    const dir = mkdtempSync(path.join(tmpdir(), "restore-"))
    const file = path.join(dir, "altimate-code.json")
    writeFileSync(file, JSON.stringify({ mcp: { datamate: { type: "local", command: ["datamate"] } } }, null, 2))
    chmodSync(file, 0o444)
    try {
      const result = await persistRestore("datamate", { type: "local", command: ["datamate", "old"] }, file)
      expect(result, "an unwritable file was reported as a successful restore").toBe("failed")
    } finally {
      chmodSync(file, 0o644)
    }
  })
})

describe("INVARIANT — the restore's write refuses on the same text, both ways", () => {
  async function tempConfig(entry: unknown): Promise<string> {
    const { mkdtempSync, writeFileSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const nodePath = await import("node:path")
    const dir = mkdtempSync(nodePath.join(tmpdir(), "restore-refuse-"))
    const file = nodePath.join(dir, "altimate-code.json")
    writeFileSync(file, JSON.stringify({ mcp: { datamate: entry } }, null, 2))
    return file
  }

  async function readBack(file: string): Promise<{ mcp: { datamate?: { enabled?: boolean } } }> {
    const { readFileSync } = await import("node:fs")
    return JSON.parse(readFileSync(file, "utf8"))
  }

  test("REPLACING does not overwrite a node the user has disabled", async () => {
    // The lifted real-file test pins the delete half and the failed-re-read
    // half; this is the third, which survived both. A restore that replaces is
    // still a write, and a disable landing before it is still the user's
    // instruction about that node.
    const { persistRestore } = await import("../../../src/altimate/workspace/engine-config")
    const file = await tempConfig({
      type: "local",
      command: ["datamate", "start-stdio", "--datamate", "42"],
      enabled: false,
    })
    await persistRestore("datamate", { type: "local", command: ["datamate", "start-stdio"] }, file)
    const after = await readBack(file)
    expect(after.mcp.datamate?.enabled, "the undo overwrote a disable the user had just made").toBe(false)
  })

  test("REMOVING does not delete a node the user has disabled", async () => {
    const { persistRestore } = await import("../../../src/altimate/workspace/engine-config")
    const file = await tempConfig({
      type: "local",
      command: ["datamate", "start-stdio", "--datamate", "42"],
      enabled: false,
    })
    await persistRestore("datamate", null, file)
    const after = await readBack(file)
    expect(after.mcp.datamate, "the undo deleted the node the user had just disabled").toBeDefined()
  })
})
