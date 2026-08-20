import { describe, expect, test } from "bun:test"
import { ModelsCatalog } from "../../src/provider/models-catalog"
import { snapshot } from "../../src/provider/models-snapshot"

// altimate_change — bot-review fix: pin the models.dev catalog validator.
//
// A review asked for cached bodies to be validated with `Provider.safeParse`.
// That looked right and was wrong: the schema requires a `Model.options` record
// real models.dev entries do not carry, so it rejected 0 of the 144 providers
// in our own bundled snapshot. Nothing was ever cached and every load fell
// through to a network fetch, which hangs in sandboxed CI — a 60s timeout in an
// unrelated CLI smoke test was the only signal. The first case below is the
// guard that would have caught it.
describe("ModelsCatalog.isCatalog", () => {
  test("accepts the real bundled catalog", () => {
    expect(ModelsCatalog.isCatalog(snapshot)).toBe(true)
  })

  test("accepts a minimal catalog-shaped record", () => {
    expect(ModelsCatalog.isCatalog({ acme: { id: "acme", models: { "acme/one": {} } } })).toBe(true)
  })

  for (const [label, value] of [
    ["an object-shaped error payload", { error: "rate limited" }],
    ["a record whose values are strings", { acme: "nope" }],
    ["a provider without a models map", { acme: { id: "acme" } }],
    ["a JSON array", []],
    ["a JSON scalar", 5],
    ["null", null],
    ["an empty object", {}],
  ] as const) {
    test(`rejects ${label}`, () => {
      expect(ModelsCatalog.isCatalog(value)).toBe(false)
    })
  }
})

describe("ModelsCatalog.parseCatalog", () => {
  test("returns the catalog for a real body", () => {
    expect(Object.keys(ModelsCatalog.parseCatalog(JSON.stringify(snapshot)) ?? {}).length).toBe(
      Object.keys(snapshot).length,
    )
  })

  test("returns undefined for non-JSON, so an HTML error page is never cached", () => {
    expect(ModelsCatalog.parseCatalog("<html>502 Bad Gateway</html>")).toBeUndefined()
  })

  test("returns undefined for JSON that is not a catalog", () => {
    expect(ModelsCatalog.parseCatalog('{"error":"rate limited"}')).toBeUndefined()
  })
})
