import { describe, test, expect } from "bun:test"
import { describeToolCall } from "../../src/altimate/tool-label"

describe("describeToolCall", () => {
  test("humanizes reads of a dbt model into 'Reading <name> model'", () => {
    expect(describeToolCall("read", { filePath: "models/customers.sql" }, "models/customers.sql")).toBe(
      "Reading customers model",
    )
    expect(
      describeToolCall("read", { filePath: "models/staging/stg_customers.sql" }, "models/staging/stg_customers.sql"),
    ).toBe("Reading stg_customers model")
  })

  test("maps other dbt directories to their noun", () => {
    expect(describeToolCall("edit", { filePath: "macros/cents_to_dollars.sql" }, "macros/cents_to_dollars.sql")).toBe(
      "Editing cents_to_dollars macro",
    )
    expect(describeToolCall("write", { filePath: "analyses/rollup.sql" }, "analyses/rollup.sql")).toBe(
      "Writing rollup analysis",
    )
    expect(describeToolCall("read", { filePath: "seeds/raw_customers.csv" }, "seeds/raw_customers.csv")).toBe(
      "Reading raw_customers seed",
    )
  })

  test("falls back to the filename for non-dbt paths (never a false 'model')", () => {
    expect(describeToolCall("read", { filePath: "dbt_project.yml" }, "dbt_project.yml")).toBe("Reading dbt_project.yml")
    expect(describeToolCall("read", { filePath: "src/index.ts" }, "src/index.ts")).toBe("Reading index.ts")
  })

  test("labels glob / grep / list by their target", () => {
    expect(describeToolCall("glob", { pattern: "**/*.sql" }, "12 matches")).toBe("Searching **/*.sql")
    expect(describeToolCall("grep", { pattern: "customer_id" }, "3 matches")).toBe("Searching customer_id")
    expect(describeToolCall("list", { path: "models" }, "models/")).toBe("Listing models")
  })

  test("list on a nested dbt subdirectory keeps the dir name (not a false '<x> model')", () => {
    // A directory listing under models/ is a folder of many models, not one model.
    expect(describeToolCall("list", { path: "models/staging" }, "models/staging/")).toBe("Listing staging")
  })

  test("matches the nearest dbt ancestor, not a coincidental outer directory", () => {
    // `models` appears higher in the path but the file lives under `macros`.
    expect(
      describeToolCall("read", { filePath: "models/project/macros/util.sql" }, "models/project/macros/util.sql"),
    ).toBe("Reading util macro")
  })

  test("humanizes python and markdown dbt files", () => {
    expect(describeToolCall("read", { filePath: "models/py_model.py" }, "models/py_model.py")).toBe(
      "Reading py_model model",
    )
    expect(describeToolCall("read", { filePath: "models/customers.md" }, "models/customers.md")).toBe(
      "Reading customers model",
    )
  })

  test("keeps the tool's own title for non-file / rich-title tools", () => {
    expect(
      describeToolCall("sql_analyze", { filePath: "models/customers.sql" }, "Analyze: 2 issues [high]"),
    ).toBe("Analyze: 2 issues [high]")
    expect(describeToolCall("bash", { command: "dbt build" }, "Run full dbt build")).toBe("Run full dbt build")
    // apply_patch carries a diff, not a path, so it keeps its own per-file title.
    expect(describeToolCall("apply_patch", { patch: "*** Update File: models/x.sql" }, "# Patched x.sql")).toBe(
      "# Patched x.sql",
    )
  })

  test("falls back to the raw title when a file tool has no usable path", () => {
    expect(describeToolCall("read", {}, "some title")).toBe("some title")
    expect(describeToolCall("read", undefined, "some title")).toBe("some title")
  })
})
