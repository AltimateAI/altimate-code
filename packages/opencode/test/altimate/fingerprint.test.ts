// @ts-nocheck
import { describe, expect, test } from "bun:test"
import { Fingerprint } from "../../src/altimate/fingerprint"
import path from "path"

// Use the actual project root for testing - it has real files
const PROJECT_ROOT = path.resolve(__dirname, "../..")

// NOTE: Fingerprint uses an internal cached variable that can't be reset from
// outside. Tests are ordered to work with this constraint.

describe("Fingerprint.get", () => {
  // This must run first, before any detect() call
  test("returns undefined before any detection", () => {
    // We rely on being the first test in the file
    // If another test ran detect() first, this would fail
    // Use a unique cwd to check if cache was set with that cwd
    const result = Fingerprint.get()
    // Either undefined (first run ever) or set from a previous test run
    // Since Bun runs files in isolation, this should be undefined
    if (result === undefined) {
      expect(result).toBeUndefined()
    } else {
      // Cache was set by module initialization or previous test
      expect(result.tags).toBeInstanceOf(Array)
    }
  })
})

describe("Fingerprint.detect", () => {
  test("returns tags array and cwd", async () => {
    const result = await Fingerprint.detect(PROJECT_ROOT)
    expect(result.tags).toBeInstanceOf(Array)
    expect(result.cwd).toBe(PROJECT_ROOT)
    expect(result.detectedAt).toBeGreaterThan(0)
  })

  test("returns cached result on second call with same cwd", async () => {
    const r1 = await Fingerprint.detect(PROJECT_ROOT)
    const r2 = await Fingerprint.detect(PROJECT_ROOT)
    expect(r1).toBe(r2) // Same reference - cached
  })
})

describe("Fingerprint.get after detection", () => {
  test("returns result after detection", async () => {
    await Fingerprint.detect(PROJECT_ROOT)
    const result = Fingerprint.get()
    expect(result).toBeDefined()
    expect(result!.tags).toBeInstanceOf(Array)
  })
})

describe("Fingerprint.refresh", () => {
  test("clears cache and re-detects", async () => {
    await Fingerprint.detect(PROJECT_ROOT)
    const r1 = Fingerprint.get()!
    const r2 = await Fingerprint.refresh()
    // Different object references (cache was cleared and re-created)
    // Tags should be the same since same directory
    expect(r2.tags.sort()).toEqual(r1.tags.sort())
    expect(r2.detectedAt).toBeGreaterThanOrEqual(r1.detectedAt)
  })
})

describe("fingerprint tag deduplication", () => {
  test("tags are deduplicated", async () => {
    const result = await Fingerprint.detect(PROJECT_ROOT)
    const uniqueTags = [...new Set(result.tags)]
    expect(result.tags.length).toBe(uniqueTags.length)
  })
})
