import { afterEach, expect, test } from "bun:test"
import { runDataDiff } from "../../src/altimate/native/connections/data-diff"
import * as Registry from "../../src/altimate/native/connections/registry"
afterEach(() => Registry.reset())
for (const type of ["sqlserver", "bigquery"]) {
  for (const field of ["source", "target", "where_clause"]) {
    test(`${type} rejects injected ${field} before connection or engine startup`, async () => {
      Registry.setConfigs({ source: { type } as any })
      const result = await runDataDiff({
        source: "orders", target: "orders_v2", key_columns: ["id"], source_warehouse: "source",
        [field]: field === "where_clause" ? "1=1); DELETE FROM orders; --" : "SELECT * FROM orders; DELETE FROM orders",
      })
      expect(result.success).toBe(false)
      expect(result.steps).toBe(0)
      expect(result.error).toContain("read-only inputs")
    })
  }
}

test("rejects writes the parser reads as queries: write CTEs, SELECT INTO, dynamic query()", async () => {
  for (const [type, source] of [
    ["postgres", "WITH x AS (DELETE FROM orders RETURNING *) SELECT * FROM x"],
    ["sqlserver", "SELECT * INTO orders_copy FROM orders"],
    ["duckdb", "SELECT * FROM query('DELETE FROM orders')"],
    ["sqlserver", "SELECT 1 AS id) SELECT 1 AS id; DELETE FROM dbo.t; WITH __x AS (SELECT 1 AS id"],
  ] as const) {
    Registry.setConfigs({ source: { type } as any })
    const result = await runDataDiff({ source, target: "orders_v2", key_columns: ["id"], source_warehouse: "source" })
    expect(result.error ?? "").toContain("read-only inputs")
  }
})

test("accepts read-only inputs that are not a plain SELECT", async () => {
  for (const [type, source] of [
    ["postgres", "VALUES (1)"],
    ["mysql", "SELECT TRUNCATE(amount, 2) AS amount, id FROM orders"],
    ["postgres", "SELECT * FROM load"],
  ] as const) {
    Registry.setConfigs({ source: { type } as any })
    const result = await runDataDiff({ source, target: "orders_v2", key_columns: ["id"], source_warehouse: "source" })
    // Validation passes; the run then fails later for lack of a real connection.
    expect(result.error ?? "").not.toContain("read-only inputs")
  }
})
