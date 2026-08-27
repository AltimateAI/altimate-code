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
