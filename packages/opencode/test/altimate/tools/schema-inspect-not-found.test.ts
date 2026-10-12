import { beforeEach, describe, expect, test } from "bun:test"
import { initTool } from "../tool-fixture"
import * as Dispatcher from "../../../src/altimate/native/dispatcher"
import { SchemaInspectTool } from "../../../src/altimate/tools/schema-inspect"

// The handler answers an unknown table with an empty column list and success; in one benchmark
// run 21 of 44 inspections read as valid empty schemas. Strict-schema callers also send
// schema_name: "" for "not specified".
const ctx = {
  sessionID: "test-session",
  messageID: "test-message",
  callID: "test-call",
  agent: "test",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => {},
}

async function inspect(args: Record<string, unknown>) {
  const tool = await initTool(SchemaInspectTool)
  return tool.execute({ warehouse: "w", values: false, ...args } as any, ctx as any)
}

beforeEach(() => {
  Dispatcher.reset()
  process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
  Dispatcher.register("warehouse.list" as any, async () => ({ warehouses: [{ name: "w", type: "postgres" }] }))
})

describe("schema_inspect unknown tables", () => {
  test("an empty column list is reported as not found, not as an empty schema", async () => {
    Dispatcher.register("schema.inspect" as any, async () => ({ table: "nope", schema_name: "public", columns: [] }))
    const result: any = await inspect({ table: "nope", schema_name: "public" })
    expect(result.metadata.success).toBe(false)
    expect(result.output).toContain('Table "nope" was not found in schema "public"')
    expect(result.output).toContain("information_schema.tables")
  })

  test("a blank schema_name is sent as unset", async () => {
    const seen: any[] = []
    Dispatcher.register("schema.inspect" as any, async (p: any) => {
      seen.push(p)
      return { table: "t", schema_name: "public", columns: [{ name: "id", data_type: "INTEGER", nullable: false }] }
    })
    const result: any = await inspect({ table: "t", schema_name: "" })
    expect(seen[0].schema_name).toBeUndefined()
    expect(result.metadata.success).toBe(true)
    expect(result.output).toContain("id")
  })
})
