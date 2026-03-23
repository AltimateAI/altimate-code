// altimate_change start — recap: adversarial pagination tests
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Recap, FileExporter, type TraceFile } from "../../src/altimate/observability/tracing"
import { tmpdir } from "../fixture/fixture"

function makeStepFinish() {
  return {
    id: "step-1",
    reason: "stop",
    cost: 0.005,
    tokens: { input: 1500, output: 300, reasoning: 100, cache: { read: 200, write: 50 } },
  }
}

/** Create N traces with distinct timestamps (5ms apart) */
async function createTraces(dir: string, count: number) {
  for (let i = 0; i < count; i++) {
    const exporter = new FileExporter(dir)
    const tracer = Recap.withExporters([exporter])
    tracer.startTrace(`ses_${String(i).padStart(3, "0")}`, { title: `Session ${i}` })
    tracer.logStepStart({ id: "step-1" })
    tracer.logStepFinish(makeStepFinish())
    await tracer.endTrace()
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** Write a raw TraceFile JSON to disk — used for controlling startedAt exactly */
async function writeRawTrace(dir: string, sessionId: string, startedAt: string) {
  const trace: TraceFile = {
    version: 2,
    traceId: `trace_${sessionId}`,
    sessionId,
    startedAt,
    endedAt: startedAt,
    metadata: { title: sessionId, prompt: "" },
    spans: [],
    summary: {
      status: "completed",
      duration: 100,
      totalTokens: 100,
      totalCost: 0.01,
      totalToolCalls: 1,
      totalGenerations: 1,
      tokens: { input: 50, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    },
  }
  await fs.writeFile(path.join(dir, `${sessionId}.json`), JSON.stringify(trace))
}

// ---------------------------------------------------------------------------
// 1. Boundary values for offset and limit
// ---------------------------------------------------------------------------

describe("listTraces pagination — boundary values", () => {
  test("offset=0, limit=0 returns empty items with correct total", async () => {
    await using tmp = await tmpdir()
    await createTraces(tmp.path, 3)

    const { items, total } = await Recap.listTraces(tmp.path, { offset: 0, limit: 0 })
    expect(items).toEqual([])
    expect(total).toBe(3)
  })

  test("negative offset is clamped to 0", async () => {
    await using tmp = await tmpdir()
    await createTraces(tmp.path, 3)

    const { items: neg } = await Recap.listTraces(tmp.path, { offset: -5, limit: 2 })
    const { items: zero } = await Recap.listTraces(tmp.path, { offset: 0, limit: 2 })
    expect(neg.map((t) => t.sessionId)).toEqual(zero.map((t) => t.sessionId))
  })

  test("negative limit is clamped to 0", async () => {
    await using tmp = await tmpdir()
    await createTraces(tmp.path, 3)

    const { items, total } = await Recap.listTraces(tmp.path, { offset: 0, limit: -10 })
    expect(items).toEqual([])
    expect(total).toBe(3)
  })

  test("offset equals total returns empty items", async () => {
    await using tmp = await tmpdir()
    await createTraces(tmp.path, 5)

    const { items, total } = await Recap.listTraces(tmp.path, { offset: 5, limit: 10 })
    expect(items).toEqual([])
    expect(total).toBe(5)
  })

  test("offset far exceeds total", async () => {
    await using tmp = await tmpdir()
    await createTraces(tmp.path, 3)

    const { items, total } = await Recap.listTraces(tmp.path, { offset: 99999, limit: 10 })
    expect(items).toEqual([])
    expect(total).toBe(3)
  })

  test("limit exceeds remaining items returns only what's left", async () => {
    await using tmp = await tmpdir()
    await createTraces(tmp.path, 5)

    const { items, total } = await Recap.listTraces(tmp.path, { offset: 3, limit: 100 })
    expect(items.length).toBe(2)
    expect(total).toBe(5)
  })

  test("MAX_SAFE_INTEGER offset and limit do not crash", async () => {
    await using tmp = await tmpdir()
    await createTraces(tmp.path, 2)

    const { items, total } = await Recap.listTraces(tmp.path, {
      offset: Number.MAX_SAFE_INTEGER,
      limit: Number.MAX_SAFE_INTEGER,
    })
    expect(items).toEqual([])
    expect(total).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 2. Non-integer and special numeric values
// ---------------------------------------------------------------------------

describe("listTraces pagination — non-integer/special values", () => {
  test("NaN offset is treated as 0", async () => {
    await using tmp = await tmpdir()
    await createTraces(tmp.path, 3)

    const { items: nan } = await Recap.listTraces(tmp.path, { offset: NaN, limit: 2 })
    const { items: zero } = await Recap.listTraces(tmp.path, { offset: 0, limit: 2 })
    expect(nan.map((t) => t.sessionId)).toEqual(zero.map((t) => t.sessionId))
  })

  test("NaN limit returns all items (treated as no limit)", async () => {
    await using tmp = await tmpdir()
    await createTraces(tmp.path, 3)

    const { items } = await Recap.listTraces(tmp.path, { offset: 0, limit: NaN })
    expect(items.length).toBe(3)
  })

  test("Infinity offset is treated as 0 (non-finite fallback)", async () => {
    await using tmp = await tmpdir()
    await createTraces(tmp.path, 3)

    // Infinity is not finite, so offset falls back to 0
    const { items: inf } = await Recap.listTraces(tmp.path, { offset: Infinity, limit: 2 })
    const { items: zero } = await Recap.listTraces(tmp.path, { offset: 0, limit: 2 })
    expect(inf.map((t) => t.sessionId)).toEqual(zero.map((t) => t.sessionId))
  })

  test("Infinity limit returns all items from offset", async () => {
    await using tmp = await tmpdir()
    await createTraces(tmp.path, 3)

    // Infinity is not finite, so limit should be treated as undefined (no limit)
    const { items } = await Recap.listTraces(tmp.path, { offset: 1, limit: Infinity })
    expect(items.length).toBe(2)
  })

  test("-Infinity offset is clamped to 0", async () => {
    await using tmp = await tmpdir()
    await createTraces(tmp.path, 3)

    const { items: neg } = await Recap.listTraces(tmp.path, { offset: -Infinity, limit: 2 })
    const { items: zero } = await Recap.listTraces(tmp.path, { offset: 0, limit: 2 })
    expect(neg.map((t) => t.sessionId)).toEqual(zero.map((t) => t.sessionId))
  })

  test("floating point offset is floored", async () => {
    await using tmp = await tmpdir()
    await createTraces(tmp.path, 5)

    const { items: floored } = await Recap.listTraces(tmp.path, { offset: 2.7, limit: 2 })
    const { items: exact } = await Recap.listTraces(tmp.path, { offset: 2, limit: 2 })
    expect(floored.map((t) => t.sessionId)).toEqual(exact.map((t) => t.sessionId))
  })

  test("floating point limit is floored", async () => {
    await using tmp = await tmpdir()
    await createTraces(tmp.path, 5)

    const { items } = await Recap.listTraces(tmp.path, { offset: 0, limit: 1.9 })
    expect(items.length).toBe(1) // floor(1.9) = 1
  })
})

// ---------------------------------------------------------------------------
// 3. Sort stability with identical timestamps
// ---------------------------------------------------------------------------

describe("listTraces pagination — sort stability", () => {
  test("traces with identical timestamps paginate without duplicates or gaps", async () => {
    await using tmp = await tmpdir()
    const timestamp = "2025-06-15T12:00:00.000Z"
    for (let i = 0; i < 5; i++) {
      await writeRawTrace(tmp.path, `same_ts_${i}`, timestamp)
    }

    const page1 = await Recap.listTraces(tmp.path, { offset: 0, limit: 2 })
    const page2 = await Recap.listTraces(tmp.path, { offset: 2, limit: 2 })
    const page3 = await Recap.listTraces(tmp.path, { offset: 4, limit: 2 })

    expect(page1.total).toBe(5)
    expect(page2.total).toBe(5)
    expect(page3.total).toBe(5)
    expect(page1.items.length).toBe(2)
    expect(page2.items.length).toBe(2)
    expect(page3.items.length).toBe(1)

    const allIds = [
      ...page1.items.map((t) => t.sessionId),
      ...page2.items.map((t) => t.sessionId),
      ...page3.items.map((t) => t.sessionId),
    ]
    expect(new Set(allIds).size).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// 4. Mixed valid/corrupted files with pagination
// ---------------------------------------------------------------------------

describe("listTraces pagination — corrupted files", () => {
  test("corrupted files excluded from total and pagination", async () => {
    await using tmp = await tmpdir()
    await createTraces(tmp.path, 5)

    // Add 3 corrupted files
    for (let i = 0; i < 3; i++) {
      await fs.writeFile(path.join(tmp.path, `corrupted_${i}.json`), `{invalid json ${i}`)
    }

    const { items: page1, total } = await Recap.listTraces(tmp.path, { offset: 0, limit: 2 })
    const { items: page2 } = await Recap.listTraces(tmp.path, { offset: 2, limit: 2 })
    const { items: page3 } = await Recap.listTraces(tmp.path, { offset: 4, limit: 2 })

    expect(total).toBe(5) // only valid traces
    expect(page1.length).toBe(2)
    expect(page2.length).toBe(2)
    expect(page3.length).toBe(1)
  })

  test("all corrupted files returns empty", async () => {
    await using tmp = await tmpdir()
    for (let i = 0; i < 3; i++) {
      await fs.writeFile(path.join(tmp.path, `bad_${i}.json`), "not json")
    }

    const { items, total } = await Recap.listTraces(tmp.path, { limit: 10 })
    expect(items).toEqual([])
    expect(total).toBe(0)
  })

  test("valid JSON but not a TraceFile does not crash pagination", async () => {
    await using tmp = await tmpdir()
    await createTraces(tmp.path, 2)
    // Write valid JSON but missing TraceFile fields
    await fs.writeFile(path.join(tmp.path, "not_trace.json"), '{"foo": "bar"}')

    // This file will parse but have undefined sessionId and startedAt
    // It should not crash the sort or pagination
    const { items, total } = await Recap.listTraces(tmp.path, { limit: 10 })
    // The non-trace file may or may not be included depending on parse behavior,
    // but the method must not throw
    expect(total).toBeGreaterThanOrEqual(2)
    expect(items.length).toBeGreaterThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// 5. Non-JSON files in directory
// ---------------------------------------------------------------------------

describe("listTraces pagination — non-JSON files", () => {
  test("non-JSON files and subdirectories are ignored", async () => {
    await using tmp = await tmpdir()
    await createTraces(tmp.path, 2)

    // Add various non-JSON files
    await fs.writeFile(path.join(tmp.path, "notes.txt"), "hello")
    await fs.writeFile(path.join(tmp.path, "backup.bak"), "data")
    await fs.writeFile(path.join(tmp.path, ".hidden"), "secret")
    await fs.mkdir(path.join(tmp.path, "subdir"), { recursive: true })

    const { items, total } = await Recap.listTraces(tmp.path, { limit: 10 })
    expect(total).toBe(2)
    expect(items.length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 6. startedAt edge cases affecting sort order
// ---------------------------------------------------------------------------

describe("listTraces pagination — startedAt edge cases", () => {
  test("traces with far future and far past sort correctly", async () => {
    await using tmp = await tmpdir()
    await writeRawTrace(tmp.path, "past", "1970-01-01T00:00:00Z")
    await writeRawTrace(tmp.path, "present", "2025-06-15T00:00:00Z")
    await writeRawTrace(tmp.path, "future", "2099-12-31T23:59:59Z")

    const { items } = await Recap.listTraces(tmp.path)
    expect(items[0].sessionId).toBe("future")
    expect(items[1].sessionId).toBe("present")
    expect(items[2].sessionId).toBe("past")
  })

  test("pagination preserves sort order across pages", async () => {
    await using tmp = await tmpdir()
    const timestamps = [
      "2025-01-01T00:00:00Z",
      "2025-02-01T00:00:00Z",
      "2025-03-01T00:00:00Z",
      "2025-04-01T00:00:00Z",
      "2025-05-01T00:00:00Z",
    ]
    for (let i = 0; i < timestamps.length; i++) {
      await writeRawTrace(tmp.path, `ses_${i}`, timestamps[i])
    }

    const page1 = await Recap.listTraces(tmp.path, { offset: 0, limit: 2 })
    const page2 = await Recap.listTraces(tmp.path, { offset: 2, limit: 2 })

    // Descending: May, Apr | Mar, Feb
    expect(page1.items[0].sessionId).toBe("ses_4")
    expect(page1.items[1].sessionId).toBe("ses_3")
    expect(page2.items[0].sessionId).toBe("ses_2")
    expect(page2.items[1].sessionId).toBe("ses_1")
  })
})

// ---------------------------------------------------------------------------
// 7. Concurrent file system mutations (TOCTOU)
// ---------------------------------------------------------------------------

describe("listTraces pagination — concurrent mutations", () => {
  test("file deleted between page requests adjusts total", async () => {
    await using tmp = await tmpdir()
    await createTraces(tmp.path, 5)

    const page1 = await Recap.listTraces(tmp.path, { offset: 0, limit: 2 })
    expect(page1.total).toBe(5)

    // Delete one trace file
    const files = await fs.readdir(tmp.path)
    const jsonFiles = files.filter((f) => f.endsWith(".json"))
    await fs.unlink(path.join(tmp.path, jsonFiles[0]))

    const page2 = await Recap.listTraces(tmp.path, { offset: 2, limit: 2 })
    expect(page2.total).toBe(4)
    // Should not crash — items may shift but results are valid
    expect(page2.items.length).toBeLessThanOrEqual(2)
  })

  test("file added between page requests adjusts total", async () => {
    await using tmp = await tmpdir()
    await createTraces(tmp.path, 3)

    const page1 = await Recap.listTraces(tmp.path, { offset: 0, limit: 2 })
    expect(page1.total).toBe(3)

    // Add a new trace
    await writeRawTrace(tmp.path, "new_trace", "2099-01-01T00:00:00Z")

    const page2 = await Recap.listTraces(tmp.path, { offset: 2, limit: 2 })
    expect(page2.total).toBe(4)
    expect(page2.items.length).toBeLessThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// 8. Empty / minimal cases
// ---------------------------------------------------------------------------

describe("listTraces pagination — minimal cases", () => {
  test("single trace with offset=0, limit=1", async () => {
    await using tmp = await tmpdir()
    await writeRawTrace(tmp.path, "only_one", "2025-06-15T00:00:00Z")

    const { items, total } = await Recap.listTraces(tmp.path, { offset: 0, limit: 1 })
    expect(items.length).toBe(1)
    expect(items[0].sessionId).toBe("only_one")
    expect(total).toBe(1)
  })

  test("single trace with offset=1 returns empty", async () => {
    await using tmp = await tmpdir()
    await writeRawTrace(tmp.path, "only_one", "2025-06-15T00:00:00Z")

    const { items, total } = await Recap.listTraces(tmp.path, { offset: 1, limit: 1 })
    expect(items).toEqual([])
    expect(total).toBe(1)
  })

  test("empty directory returns zero total", async () => {
    await using tmp = await tmpdir()

    const { items, total } = await Recap.listTraces(tmp.path, { offset: 0, limit: 10 })
    expect(items).toEqual([])
    expect(total).toBe(0)
  })
})
// altimate_change end
