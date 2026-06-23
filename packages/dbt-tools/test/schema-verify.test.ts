import { describe, test, expect, mock } from "bun:test"
import { schemaVerify } from "../src/commands/schema-verify"
import type { ColumnMetaData, DBColumn, DBTProjectIntegrationAdapter, NodeMetaData } from "@altimateai/dbt-integration"

type AdapterOverrides = {
  expectedColumns?: Record<string, ColumnMetaData>
  actualColumns?: DBColumn[] | null
  nodeFound?: boolean
  parseManifestError?: Error
  getColumnsError?: Error
}

function makeAdapter(o: AdapterOverrides = {}): DBTProjectIntegrationAdapter {
  const node: NodeMetaData | undefined = o.nodeFound === false
    ? undefined
    : ({
        unique_id: "model.proj.target",
        path: "models/target.sql",
        database: "db",
        schema: "main",
        alias: "target",
        name: "target",
        package_name: "proj",
        description: "",
        patch_path: "schema.yml",
        columns: o.expectedColumns ?? {},
        config: {} as never,
        resource_type: "model",
        depends_on: { nodes: [], macros: [] } as never,
        is_external_project: false,
        compiled_path: "",
        meta: {},
      } as unknown as NodeMetaData)

  const parseManifest = o.parseManifestError
    ? mock(() => Promise.reject(o.parseManifestError))
    : mock(() => Promise.resolve({
        nodeMetaMap: {
          lookupByBaseName: mock(() => node),
          lookupByUniqueId: mock(() => node),
          nodes: mock(() => []),
        },
      } as never))

  const getColumnsOfModel = o.getColumnsError
    ? mock(() => Promise.reject(o.getColumnsError))
    : mock(() => Promise.resolve(o.actualColumns ?? null))

  return {
    parseManifest,
    getColumnsOfModel,
  } as unknown as DBTProjectIntegrationAdapter
}

function col(name: string, data_type = ""): ColumnMetaData {
  return { name, description: "", data_type, meta: undefined as never } as ColumnMetaData
}

function db(column: string, dtype = ""): DBColumn {
  return { column, dtype }
}

describe("schema-verify command", () => {
  test("missing --model returns error", async () => {
    const adapter = makeAdapter()
    const result = await schemaVerify(adapter, [])
    expect(result).toEqual({ error: "Missing --model" })
  })

  test("model not found in manifest", async () => {
    const adapter = makeAdapter({ nodeFound: false })
    const result = await schemaVerify(adapter, ["--model", "missing_model"])
    expect((result as { error: string }).error).toContain("not found in manifest")
  })

  test("no-spec verdict when schema.yml has no columns declared", async () => {
    const adapter = makeAdapter({
      expectedColumns: {},
      actualColumns: [db("id"), db("name")],
    })
    const result = await schemaVerify(adapter, ["--model", "target"])
    expect((result as { verdict: string }).verdict).toBe("no-spec")
    expect((result as { actual_columns: string[] }).actual_columns).toEqual(["id", "name"])
  })

  test("match verdict when actual matches spec exactly", async () => {
    const adapter = makeAdapter({
      expectedColumns: { id: col("id"), name: col("name") },
      actualColumns: [db("id"), db("name")],
    })
    const result = await schemaVerify(adapter, ["--model", "target"]) as Record<string, unknown>
    expect(result.verdict).toBe("match")
    expect(result.columns_extra).toEqual([])
    expect(result.columns_missing).toEqual([])
    expect(result.columns_reordered).toEqual([])
  })

  test("detects extra columns in actual not in spec", async () => {
    const adapter = makeAdapter({
      expectedColumns: { id: col("id"), name: col("name") },
      actualColumns: [db("id"), db("name"), db("extra1"), db("extra2")],
    })
    const result = await schemaVerify(adapter, ["--model", "target"]) as Record<string, unknown>
    expect(result.verdict).toBe("mismatch")
    expect(result.columns_extra).toEqual(["extra1", "extra2"])
    expect(result.columns_missing).toEqual([])
  })

  test("detects missing columns in actual that spec requires", async () => {
    const adapter = makeAdapter({
      expectedColumns: { id: col("id"), name: col("name"), email: col("email") },
      actualColumns: [db("id"), db("name")],
    })
    const result = await schemaVerify(adapter, ["--model", "target"]) as Record<string, unknown>
    expect(result.verdict).toBe("mismatch")
    expect(result.columns_missing).toEqual(["email"])
    expect(result.columns_extra).toEqual([])
  })

  test("detects column reordering when same set but different position", async () => {
    const adapter = makeAdapter({
      // schema.yml order: id, name, email
      expectedColumns: { id: col("id"), name: col("name"), email: col("email") },
      // actual order: name, id, email
      actualColumns: [db("name"), db("id"), db("email")],
    })
    const result = await schemaVerify(adapter, ["--model", "target"]) as Record<string, unknown>
    expect(result.verdict).toBe("mismatch")
    expect(result.columns_extra).toEqual([])
    expect(result.columns_missing).toEqual([])
    const reordered = result.columns_reordered as Array<{ column: string }>
    expect(reordered.length).toBeGreaterThan(0)
    const reorderedNames = reordered.map((r) => r.column)
    expect(reorderedNames).toContain("id")
  })

  test("case-insensitive name comparison (dbt convention)", async () => {
    const adapter = makeAdapter({
      expectedColumns: { ID: col("ID"), Name: col("Name") },
      actualColumns: [db("id"), db("name")],
    })
    const result = await schemaVerify(adapter, ["--model", "target"]) as Record<string, unknown>
    expect(result.verdict).toBe("match")
  })

  test("detects type mismatch when spec declares a different data_type", async () => {
    const adapter = makeAdapter({
      expectedColumns: { id: col("id", "INTEGER"), name: col("name", "VARCHAR") },
      actualColumns: [db("id", "BIGINT"), db("name", "VARCHAR")],
    })
    const result = await schemaVerify(adapter, ["--model", "target"]) as Record<string, unknown>
    expect(result.verdict).toBe("mismatch")
    const mm = result.type_mismatches as Array<{ column: string; actual_type: string; expected_type: string }>
    expect(mm.length).toBe(1)
    expect(mm[0]?.column).toBe("id")
  })

  test("ignores type mismatch when spec does not declare data_type", async () => {
    const adapter = makeAdapter({
      // data_type empty = not declared in schema.yml
      expectedColumns: { id: col("id", ""), name: col("name", "") },
      actualColumns: [db("id", "BIGINT"), db("name", "VARCHAR")],
    })
    const result = await schemaVerify(adapter, ["--model", "target"]) as Record<string, unknown>
    expect(result.verdict).toBe("match")
    expect(result.type_mismatches).toEqual([])
  })

  test("propagates getColumnsOfModel error with a fix hint", async () => {
    const adapter = makeAdapter({
      expectedColumns: { id: col("id") },
      getColumnsError: new Error("table not materialized"),
    })
    const result = await schemaVerify(adapter, ["--model", "target"])
    expect((result as { error: string }).error).toContain("Build the model first")
  })

  test("realistic ade-bench f1002 pattern — extra rank-breakdown columns", async () => {
    // Spec: just rank, driver_full_name, podiums
    // Actual: agent helpfully added p1, p2, p3 breakdowns
    const adapter = makeAdapter({
      expectedColumns: {
        rank: col("rank"),
        driver_full_name: col("driver_full_name"),
        podiums: col("podiums"),
      },
      actualColumns: [db("rank"), db("driver_full_name"), db("podiums"), db("p1"), db("p2"), db("p3")],
    })
    const result = await schemaVerify(adapter, ["--model", "most_podiums"]) as Record<string, unknown>
    expect(result.verdict).toBe("mismatch")
    expect(result.columns_extra).toEqual(["p1", "p2", "p3"])
    expect(result.columns_missing).toEqual([])
  })

  test("realistic ade-bench pattern — column-order divergence (product_id-first vs inventory_id-first)", async () => {
    const adapter = makeAdapter({
      // Spec leads with product_id
      expectedColumns: {
        product_id: col("product_id"),
        product_code: col("product_code"),
        inventory_id: col("inventory_id"),
      },
      // Actual leads with inventory_id
      actualColumns: [db("inventory_id"), db("product_id"), db("product_code")],
    })
    const result = await schemaVerify(adapter, ["--model", "obt_product_inventory"]) as Record<string, unknown>
    expect(result.verdict).toBe("mismatch")
    const reordered = result.columns_reordered as Array<{ column: string }>
    expect(reordered.length).toBeGreaterThan(0)
  })
})
