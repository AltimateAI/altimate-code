/**
 * Tests for dbt_docs_coverage: output columns of the compiled SQL against the manifest's described
 * columns. Fixture manifests only; nothing here reaches a warehouse or a dbt project.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { initTool } from "./tool-fixture"
import { DbtDocsCoverageTool, docsCoverage } from "../../src/altimate/tools/dbt-docs-coverage"
import { SessionID, MessageID } from "../../src/session/schema"

beforeEach(() => {
  process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
})
afterAll(() => {
  delete process.env.ALTIMATE_TELEMETRY_DISABLED
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "call_test",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

function manifest(nodes: Record<string, any>) {
  return { metadata: { adapter_type: "snowflake" }, nodes, sources: {} }
}

const orders = {
  resource_type: "model",
  name: "orders",
  unique_id: "model.shop.orders",
  description: "One row per order",
  compiled_code: "select o.id, o.customer_id, upper(o.status) as status, 1 as flag from raw.orders o",
  columns: {
    id: { name: "id", description: "Order key" },
    customer_id: { name: "customer_id", description: "   " },
    status: { name: "status", description: "Order status" },
  },
}

describe("docsCoverage", () => {
  test("splits output columns into described and missing, ignoring blank descriptions", () => {
    const r = docsCoverage(orders, "snowflake")
    expect(r.output_columns).toEqual(["id", "customer_id", "status", "flag"])
    expect(r.documented).toEqual(["id", "status"])
    expect(r.missing).toEqual(["customer_id", "flag"])
    expect(r.percent).toBe(50)
    expect(r.has_description).toBe(true)
    expect(r.source).toBe("compiled_sql")
  })

  test("matches column names case-insensitively", () => {
    const r = docsCoverage(
      { ...orders, columns: { ID: { name: "ID", description: "Order key" } }, compiled_code: "select id from t" },
      "snowflake",
    )
    expect(r.documented).toEqual(["id"])
    expect(r.missing).toEqual([])
  })

  test("a model without a description reports it", () => {
    expect(docsCoverage({ ...orders, description: "" }, "snowflake").has_description).toBe(false)
  })

  test("select * falls back to the manifest's columns", () => {
    const r = docsCoverage({ ...orders, compiled_code: "select * from raw.orders" }, "snowflake")
    expect(r.source).toBe("manifest_columns")
    expect(r.output_columns).toEqual(["id", "customer_id", "status"])
    expect(r.missing).toEqual(["customer_id"])
  })

  test("quoted names that differ only by case are different columns", () => {
    const r = docsCoverage(
      {
        ...orders,
        compiled_code: 'select "Foo", "foo" from t',
        columns: { Foo: { name: "Foo", description: "Capital" } },
      },
      "snowflake",
    )
    expect(r.output_columns).toEqual(["Foo", "foo"])
    expect(r.documented).toEqual(["Foo"])
    expect(r.missing).toEqual(["foo"])
  })

  test("a literal asterisk in a column name is not a wildcard", () => {
    const r = docsCoverage({ ...orders, compiled_code: 'select "a*b" from t' }, "snowflake")
    expect(r.source).toBe("compiled_sql")
    expect(r.output_columns).toEqual(["a*b"])
    expect(r.missing).toEqual(["a*b"])
  })

  test("a column read that merely contains the letters star is the SQL's error, not a wildcard", () => {
    expect(() => docsCoverage({ ...orders, compiled_code: "select start_time + 1 from t" }, "snowflake")).toThrow(
      "unable to determine output column name",
    )
  })

  test("select * with no columns in the manifest is an error, not full coverage", () => {
    expect(() =>
      docsCoverage({ ...orders, columns: {}, compiled_code: "select * from raw.orders" }, "snowflake"),
    ).toThrow("its columns are not known")
  })

  test("a star beside named columns says that only the manifest's columns are counted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "docs-coverage-star-"))
    try {
      const path = join(dir, "manifest.json")
      const node = { ...orders, compiled_code: "select *, 1 as extra from raw.orders" }
      writeFileSync(path, JSON.stringify(manifest({ [orders.unique_id]: node })))
      const tool = await initTool(DbtDocsCoverageTool)
      const r = await tool.execute({ model: "orders", manifest_path: path }, ctx as any)
      expect(r.metadata.source).toBe("manifest_columns")
      expect(r.metadata.output_columns).toEqual(["id", "customer_id", "status"])
      expect(r.output).toContain("a column the SQL adds beside `*` is not")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a model without compiled SQL is an error, not full coverage", () => {
    expect(() => docsCoverage({ ...orders, compiled_code: "" }, "snowflake")).toThrow("no compiled SQL")
  })
})

describe("dbt_docs_coverage tool", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "docs-coverage-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("reports coverage from a manifest file", async () => {
    const path = join(dir, "manifest.json")
    writeFileSync(path, JSON.stringify(manifest({ [orders.unique_id]: orders })))
    const tool = await initTool(DbtDocsCoverageTool)
    const r = await tool.execute({ model: "orders", manifest_path: path }, ctx as any)
    expect(r.metadata.success).toBe(true)
    expect(r.metadata.missing).toEqual(["customer_id", "flag"])
    expect(r.output).toContain("Missing descriptions: customer_id, flag")
  })

  test("an unknown model names the manifest", async () => {
    const path = join(dir, "manifest.json")
    writeFileSync(path, JSON.stringify(manifest({ [orders.unique_id]: orders })))
    const tool = await initTool(DbtDocsCoverageTool)
    const r = await tool.execute({ model: "nope", manifest_path: path }, ctx as any)
    expect(r.metadata.success).toBe(false)
    expect(r.metadata.error).toContain('Model "nope" not found')
    expect(r.output).toContain("not found")
  })

  test("a missing manifest says to compile", async () => {
    const tool = await initTool(DbtDocsCoverageTool)
    const r = await tool.execute({ model: "orders", manifest_path: join(dir, "absent.json") }, ctx as any)
    expect(r.metadata.success).toBe(false)
    expect(r.metadata.error).toContain("No manifest")
    expect(r.output).toContain("dbt compile")
  })
})
