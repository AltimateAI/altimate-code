import { describe, expect, spyOn, test } from "bun:test"
import { DBTProjectIntegrationAdapter, DBTProjectIntegrationAdapterEvents } from "@altimateai/dbt-integration"
import type { ParsedManifest } from "@altimateai/dbt-integration"
import { create } from "../src/adapter"
import { partialManifestNote, recordPartialManifest } from "../src/partial-manifest"

const ROOT = "/p"
const MISSING_REF = "Ref 'stg_orderz' not found in project. Searched for 'jaffle_shop.stg_orderz, stg_orderz'"

const parsed = (...errors: { filePath: string; message: string }[]) =>
  (errors.length ? { partial: { errors } } : {}) as ParsedManifest

describe("the partial manifest note", () => {
  test("is absent for an adapter whose last parse had no errors", () => {
    const adapter = {}
    expect(partialManifestNote(adapter, ROOT)).toBeUndefined()
    recordPartialManifest(adapter, parsed())
    expect(partialManifestNote(adapter, ROOT)).toBeUndefined()
  })

  test("names the file that failed to parse, relative to the project, with its error", () => {
    const adapter = {}
    recordPartialManifest(adapter, parsed({ filePath: "/p/models/customers.sql", message: MISSING_REF }))
    expect(partialManifestNote(adapter, ROOT)).toEqual({
      message: "This graph is missing parts because models/customers.sql failed to parse.",
      errors: [{ file_path: "models/customers.sql", message: MISSING_REF }],
    })
  })

  test("keeps a path outside the project, or one given with no project, as dbt wrote it", () => {
    const adapter = {}
    recordPartialManifest(adapter, parsed({ filePath: "/elsewhere/models/a.sql", message: "x" }))
    expect(partialManifestNote(adapter, ROOT)?.errors[0]?.file_path).toBe("/elsewhere/models/a.sql")
    // A sibling folder whose name starts with the project's is outside it.
    recordPartialManifest(adapter, parsed({ filePath: "/p2/models/a.sql", message: "x" }))
    expect(partialManifestNote(adapter, ROOT)?.errors[0]?.file_path).toBe("/p2/models/a.sql")
    recordPartialManifest(adapter, parsed({ filePath: "models/a.sql", message: "x" }))
    expect(partialManifestNote(adapter)?.errors[0]?.file_path).toBe("models/a.sql")
  })

  test("names each file once, however many errors it has", () => {
    const adapter = {}
    recordPartialManifest(
      adapter,
      parsed(
        { filePath: "/p/models/a.sql", message: "one" },
        { filePath: "/p/models/a.sql", message: "two" },
        { filePath: "/p/models/b.sql", message: "three" },
      ),
    )
    const note = partialManifestNote(adapter, ROOT)
    expect(note?.message).toBe("This graph is missing parts because models/a.sql and models/b.sql failed to parse.")
    expect(note?.errors).toHaveLength(3)
  })

  test("counts the files past the fifth instead of naming them", () => {
    const adapter = {}
    const errors = ["a", "b", "c", "d", "e", "f", "g"].map((name) => ({ filePath: `/p/models/${name}.sql`, message: "x" }))
    recordPartialManifest(adapter, parsed(...errors))
    expect(partialManifestNote(adapter, ROOT)?.message).toBe(
      "This graph is missing parts because models/a.sql, models/b.sql, models/c.sql, models/d.sql, models/e.sql and 2 more files failed to parse.",
    )
    recordPartialManifest(adapter, parsed(...errors.slice(0, 6)))
    expect(partialManifestNote(adapter, ROOT)?.message).toContain("models/e.sql and 1 more file failed to parse.")
  })

  test("goes once a later parse has no errors", () => {
    const adapter = {}
    recordPartialManifest(adapter, parsed({ filePath: "/p/models/customers.sql", message: MISSING_REF }))
    recordPartialManifest(adapter, parsed())
    expect(partialManifestNote(adapter, ROOT)).toBeUndefined()
  })

  test("is each adapter's own", () => {
    const broken = {}
    const whole = {}
    recordPartialManifest(broken, parsed({ filePath: "/p/models/customers.sql", message: MISSING_REF }))
    recordPartialManifest(whole, parsed())
    expect(partialManifestNote(broken, ROOT)).toBeDefined()
    expect(partialManifestNote(whole, ROOT)).toBeUndefined()
  })
})

describe("create", () => {
  test("hears the partial parse `initialize` runs, and the clean one after it", async () => {
    const partial = { errors: [{ filePath: "/p/models/customers.sql", message: MISSING_REF }] }
    const initialize = spyOn(DBTProjectIntegrationAdapter.prototype, "initialize").mockImplementation(async function (
      this: DBTProjectIntegrationAdapter,
    ) {
      this.emit(DBTProjectIntegrationAdapterEvents.MANIFEST_PARSED, { partial })
    })
    try {
      const adapter = await create({ projectRoot: ROOT, pythonPath: "python3", dbtIntegration: "fusion", queryLimit: 500 })
      expect(partialManifestNote(adapter, ROOT)?.errors).toEqual([{ file_path: "models/customers.sql", message: MISSING_REF }])
      adapter.emit(DBTProjectIntegrationAdapterEvents.MANIFEST_PARSED, {})
      expect(partialManifestNote(adapter, ROOT)).toBeUndefined()
    } finally {
      initialize.mockRestore()
    }
  })
})
