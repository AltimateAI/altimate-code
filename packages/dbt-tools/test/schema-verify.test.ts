import { describe, test, expect, mock } from "bun:test"
import { schemaVerify } from "../src/commands/schema-verify"
import type { ColumnMetaData, DBColumn, DBTProjectIntegrationAdapter, NodeMetaData } from "@altimateai/dbt-integration"

type AdapterOverrides = {
  expectedColumns?: Record<string, ColumnMetaData>
  actualColumns?: DBColumn[] | null
  nodeFound?: boolean
  parseManifestError?: Error
  getColumnsError?: Error
  /** `config.contract.enforced` on the model. */
  contractEnforced?: boolean
  /** Tests attached to columns of the model: column name -> test names. */
  columnTests?: Record<string, string[]>
  /** Describe the tests as an older manifest does: no attached_node, the model is in depends_on. */
  legacyTests?: boolean
  patchPath?: string
  packageName?: string
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
        package_name: o.packageName ?? "proj",
        description: "",
        patch_path: o.patchPath ?? "schema.yml",
        columns: o.expectedColumns ?? {},
        config: (o.contractEnforced === undefined ? {} : { contract: { enforced: o.contractEnforced } }) as never,
        resource_type: "model",
        depends_on: { nodes: [], macros: [] } as never,
        is_external_project: false,
        compiled_path: "",
        meta: {},
      } as unknown as NodeMetaData)

  const testMetaMap = new Map<string, unknown>()
  for (const [column, names] of Object.entries(o.columnTests ?? {}))
    for (const name of names)
      testMetaMap.set(
        name,
        o.legacyTests
          ? { depends_on: { nodes: ["macro.x", "model.proj.target"] }, column_name: column }
          : { attached_node: "model.proj.target", column_name: column },
      )
  // A test attached to some other model must never count.
  testMetaMap.set("not_null_other_email", { attached_node: "model.proj.other", column_name: "email" })

  const parseManifest = o.parseManifestError
    ? mock(() => Promise.reject(o.parseManifestError))
    : mock(() => Promise.resolve({
        nodeMetaMap: {
          lookupByBaseName: mock(() => node),
          lookupByUniqueId: mock(() => node),
          nodes: mock(() => []),
        },
        testMetaMap,
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

  test("extra columns the YAML does not list are reported in the raw diff but are not a mismatch", async () => {
    const adapter = makeAdapter({
      expectedColumns: { id: col("id"), name: col("name") },
      actualColumns: [db("id"), db("name"), db("extra1"), db("extra2")],
    })
    const result = await schemaVerify(adapter, ["--model", "target"]) as Record<string, unknown>
    expect(result.verdict).toBe("match")
    expect(result.findings).toEqual([])
    expect(result.columns_extra).toEqual(["extra1", "extra2"])
    expect((result.notes as string[]).join(" ")).toContain("not an error")
  })

  test("YAML that documents only the tested columns: undocumented columns are never an error (airbnb001 shape)", async () => {
    // monthly_agg_reviews: YAML lists DATE_SENTIMENT_ID and REVIEW_SENTIMENT, the model produces six columns.
    const adapter = makeAdapter({
      expectedColumns: { DATE_SENTIMENT_ID: col("DATE_SENTIMENT_ID"), REVIEW_SENTIMENT: col("REVIEW_SENTIMENT") },
      columnTests: { DATE_SENTIMENT_ID: ["unique_x", "not_null_x"], REVIEW_SENTIMENT: ["accepted_values_x"] },
      actualColumns: [
        db("REVIEW_TOTALS"), db("REVIEW_SENTIMENT"), db("MONTH_YEAR"), db("MONTH"), db("YEAR"), db("DATE_SENTIMENT_ID"),
      ],
    })
    const result = await schemaVerify(adapter, ["--model", "monthly_agg_reviews"]) as Record<string, unknown>
    expect(result.verdict).toBe("match")
    expect(result.findings).toEqual([])
    // Column order differs from the YAML too; that is not an error either.
    expect((result.columns_reordered as unknown[]).length).toBeGreaterThan(0)
  })

  test("a declared column the model does not produce, with a test attached, is a finding naming the file and the test", async () => {
    const adapter = makeAdapter({
      expectedColumns: { id: col("id"), email: col("email") },
      columnTests: { email: ["not_null_target_email"] },
      patchPath: "proj://models/schema.yml",
      actualColumns: [db("id")],
    })
    const result = await schemaVerify(adapter, ["--model", "target"]) as Record<string, any>
    expect(result.verdict).toBe("mismatch")
    expect(result.columns_missing).toEqual(["email"])
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].kind).toBe("tested-column-missing")
    expect(result.findings[0].columns).toEqual(["email"])
    expect(result.findings[0].evidence).toContain("models/schema.yml")
    expect(result.findings[0].evidence).toContain("not_null_target_email")
    expect(result.spec).toEqual({ declared_in: "models/schema.yml", package: "proj", contract_enforced: false })
  })

  test("a manifest without attached_node (older dbt) still finds the tested model through depends_on", async () => {
    const adapter = makeAdapter({
      expectedColumns: { id: col("id"), email: col("email") },
      columnTests: { email: ["not_null_target_email"] },
      legacyTests: true,
      patchPath: "proj://models/schema.yml",
      actualColumns: [db("id")],
    })
    const result = await schemaVerify(adapter, ["--model", "target"]) as Record<string, any>
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].kind).toBe("tested-column-missing")
  })

  test("a declared column the model does not produce, with nothing attached, is only a note (asana001 shape)", async () => {
    // Package YAML declares assignee_status (description only); the model never produced it.
    const adapter = makeAdapter({
      expectedColumns: { task_id: col("task_id"), assignee_status: col("assignee_status") },
      columnTests: { task_id: ["unique_x"] },
      patchPath: "asana_source://models/stg_asana.yml",
      packageName: "proj",
      actualColumns: [db("task_id"), db("name")],
    })
    const result = await schemaVerify(adapter, ["--model", "target"]) as Record<string, any>
    expect(result.verdict).toBe("match")
    expect(result.findings).toEqual([])
    const notes = (result.notes as string[]).join("\n")
    expect(notes).toContain("assignee_status")
    expect(notes).toContain("models/stg_asana.yml")
    expect(notes).toContain("package `asana_source`")
    expect(notes).toContain("stale or aspirational")
  })

  test("tests attached to a different model do not make a missing column a finding", async () => {
    const adapter = makeAdapter({
      expectedColumns: { id: col("id"), email: col("email") },
      columnTests: {},
      actualColumns: [db("id")],
    })
    // makeAdapter always adds not_null_other_email on model.proj.other; this model's `email` is missing.
    const result = await schemaVerify(adapter, ["--model", "target"]) as Record<string, unknown>
    expect(result.verdict).toBe("match")
  })

  test("enforced contract: a missing column is a finding", async () => {
    const adapter = makeAdapter({
      contractEnforced: true,
      expectedColumns: { id: col("id", "integer"), name: col("name", "varchar") },
      actualColumns: [db("id", "INTEGER")],
    })
    const result = await schemaVerify(adapter, ["--model", "target"]) as Record<string, any>
    expect(result.verdict).toBe("mismatch")
    expect(result.findings.map((f: any) => f.kind)).toEqual(["contract-missing-columns"])
    expect(result.findings[0].evidence).toContain("enforced contract")
    expect(result.spec.contract_enforced).toBe(true)
  })

  test("enforced contract: an extra column is a finding (dbt rejects it)", async () => {
    const adapter = makeAdapter({
      contractEnforced: true,
      expectedColumns: { id: col("id"), name: col("name") },
      actualColumns: [db("id"), db("name"), db("amount")],
    })
    const result = await schemaVerify(adapter, ["--model", "target"]) as Record<string, any>
    expect(result.verdict).toBe("mismatch")
    expect(result.findings.map((f: any) => f.kind)).toEqual(["contract-extra-columns"])
    expect(result.findings[0].columns).toEqual(["amount"])
  })

  test("enforced contract that the table satisfies: match, even when the order differs", async () => {
    const adapter = makeAdapter({
      contractEnforced: true,
      expectedColumns: { id: col("id", "integer"), name: col("name", "varchar") },
      actualColumns: [db("name", "VARCHAR"), db("id", "INTEGER")],
    })
    const result = await schemaVerify(adapter, ["--model", "target"]) as Record<string, unknown>
    expect(result.verdict).toBe("match")
  })

  test("contract = false is not a contract", async () => {
    const adapter = makeAdapter({
      contractEnforced: false,
      expectedColumns: { id: col("id") },
      actualColumns: [db("id"), db("extra")],
    })
    expect(((await schemaVerify(adapter, ["--model", "target"])) as Record<string, unknown>).verdict).toBe("match")
  })

  test("model without any YAML columns: no-spec, whatever the table looks like", async () => {
    const adapter = makeAdapter({ expectedColumns: {}, actualColumns: [db("a"), db("b"), db("c")], patchPath: "" })
    const result = await schemaVerify(adapter, ["--model", "target"]) as Record<string, unknown>
    expect(result.verdict).toBe("no-spec")
    expect(result.findings).toBeUndefined()
  })

  test("column order that differs from the YAML is reported in the raw diff, never as a mismatch", async () => {
    const adapter = makeAdapter({
      // schema.yml order: id, name, email
      expectedColumns: { id: col("id"), name: col("name"), email: col("email") },
      // actual order: name, id, email
      actualColumns: [db("name"), db("id"), db("email")],
    })
    const result = await schemaVerify(adapter, ["--model", "target"]) as Record<string, unknown>
    expect(result.verdict).toBe("match")
    expect(result.columns_extra).toEqual([])
    expect(result.columns_missing).toEqual([])
    const reordered = result.columns_reordered as Array<{ column: string }>
    expect(reordered.map((r) => r.column)).toContain("id")
  })

  test("case-insensitive name comparison (dbt convention)", async () => {
    const adapter = makeAdapter({
      expectedColumns: { ID: col("ID"), Name: col("Name") },
      actualColumns: [db("id"), db("name")],
    })
    const result = await schemaVerify(adapter, ["--model", "target"]) as Record<string, unknown>
    expect(result.verdict).toBe("match")
  })

  test("declared data_type that differs without a contract: raw diff only, no mismatch", async () => {
    const adapter = makeAdapter({
      expectedColumns: { id: col("id", "INTEGER"), name: col("name", "VARCHAR") },
      actualColumns: [db("id", "BIGINT"), db("name", "VARCHAR")],
    })
    const result = await schemaVerify(adapter, ["--model", "target"]) as Record<string, unknown>
    expect(result.verdict).toBe("match")
    const mm = result.type_mismatches as Array<{ column: string }>
    expect(mm.map((t) => t.column)).toEqual(["id"])
  })

  test("declared data_type that differs under a contract: noted, because dbt checks types itself at build", async () => {
    const adapter = makeAdapter({
      contractEnforced: true,
      expectedColumns: { id: col("id", "INTEGER") },
      actualColumns: [db("id", "BIGINT")],
    })
    const result = await schemaVerify(adapter, ["--model", "target"]) as Record<string, any>
    expect(result.verdict).toBe("match")
    expect(result.notes.join(" ")).toContain("data_type")
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

  test("f1002 shape: extra rank-breakdown columns beyond the YAML are not an error by themselves", async () => {
    // YAML: rank, driver_full_name, podiums. Model also returns p1, p2, p3. dbt is happy with that;
    // whether the extras are wanted is a question for the task, not for the YAML.
    const adapter = makeAdapter({
      expectedColumns: {
        rank: col("rank"),
        driver_full_name: col("driver_full_name"),
        podiums: col("podiums"),
      },
      actualColumns: [db("rank"), db("driver_full_name"), db("podiums"), db("p1"), db("p2"), db("p3")],
    })
    const result = await schemaVerify(adapter, ["--model", "most_podiums"]) as Record<string, unknown>
    expect(result.verdict).toBe("match")
    expect(result.columns_extra).toEqual(["p1", "p2", "p3"])
    expect(result.columns_missing).toEqual([])
  })

  test("no output of schema-verify tells the reader to remove, add or reorder anything", async () => {
    const adapter = makeAdapter({
      expectedColumns: { id: col("id"), gone: col("gone") },
      columnTests: { gone: ["not_null_target_gone"] },
      actualColumns: [db("name"), db("id")],
    })
    const text = JSON.stringify(await schemaVerify(adapter, ["--model", "target"]))
    expect(text).not.toMatch(/\b(REMOVE|ADD|REORDER|CAST)\b/)
  })
})
