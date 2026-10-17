import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import type { Connector } from "@altimateai/drivers"
import * as Registry from "../../../src/altimate/native/connections/registry"
import { registerAll } from "../../../src/altimate/native/connections/register"
import { SchemaInspectTool } from "../../../src/altimate/tools/schema-inspect"
import { initTool } from "../tool-fixture"

const ctx = {
  sessionID: "schema-mongodb-test",
  messageID: "test-message",
  callID: "test-call",
  agent: "test",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => {},
}
let connectorSpy: { mockRestore(): void } | undefined

beforeEach(() => registerAll())
afterEach(() => {
  connectorSpy?.mockRestore()
  Registry.reset()
})

function configure(database?: string) {
  Registry.setConfigs({ documents: { type: "mongodb", database } })
  const connector = {
    listSchemas: mock(async () => ["records"]),
    listTables: mock(async (_schema: string) => [
      { name: "events", type: "collection" },
      { name: "empty", type: "collection" },
    ]),
    describeTable: mock(async (schema: string, table: string) =>
      schema === "records" && table === "events" ? [{ name: "id", data_type: "STRING", nullable: false }] : [],
    ),
  }
  connectorSpy = spyOn(Registry, "get").mockResolvedValue(connector as unknown as Connector)
  return connector
}

async function inspect(table: string) {
  const tool = await initTool(SchemaInspectTool)
  return tool.execute({ warehouse: "documents", table, values: false }, ctx)
}

describe("schema_inspect MongoDB collections", () => {
  test("splits a database-qualified collection", async () => {
    const connector = configure("records")
    const result = await inspect("records.events")
    expect(result.metadata.success).toBe(true)
    expect(connector.describeTable.mock.calls).toEqual([["records", "events"]])
  })

  test.each(["records", undefined])("uses the MongoDB database instead of public with config %s", async (database) => {
    const connector = configure(database)
    const result = await inspect("events")
    expect(result.metadata.success).toBe(true)
    expect(connector.describeTable.mock.calls).toEqual([["records", "events"]])
  })

  test("a missing collection lists available collections", async () => {
    const connector = configure("records")
    const result = await inspect("missing")
    expect(result.metadata.success).toBe(false)
    expect(result.output).toContain('Collection "missing" was not found in database "records"')
    expect(result.output).toContain("Available collections: events, empty")
    expect(result.output).not.toContain("information_schema")
    expect(result.output).not.toContain("dispatcher is running")
    expect(connector.listTables.mock.calls).toEqual([["records"]])
  })

  test("an empty collection is not reported as missing", async () => {
    configure("records")
    const result = await inspect("empty")
    expect(result.output).toContain('Collection "empty" has no documents to infer a schema')
    expect(result.output).not.toContain("was not found")
  })

  test("profiles sampled documents instead of skipping, including nested paths", async () => {
    const connector = configure("records")
    const docs = Array.from({ length: 10 }, (_, i) => ({
      id: `e${i}`,
      status: i < 7 ? "open" : "closed",
      meta: { source: i % 2 ? "web" : "api" },
    }))
    connector.describeTable.mockImplementation(async () => [
      { name: "id", data_type: "string", nullable: false },
      { name: "meta", data_type: "object", nullable: false },
      { name: "meta.source", data_type: "string", nullable: true, presence: 0.9 },
      { name: "status", data_type: "string", nullable: false },
    ])
    Object.assign(connector, { sampleDocuments: mock(async () => docs) })
    const tool = await initTool(SchemaInspectTool)
    const result = await tool.execute({ warehouse: "documents", table: "records.events" }, ctx)
    expect(result.metadata.success).toBe(true)
    expect(result.output).not.toContain("skipped")
    expect(result.output).toContain("meta.source | string (in 90% of docs) | YES")
    expect(result.output).toContain("id: 10 distinct, unique in sample — e0, e1")
    expect(result.output).toContain("status: 2 distinct — open (7), closed (3)")
    expect(result.output).toContain("meta.source: 2 distinct — api (5), web (5)")
    expect(result.output).not.toContain("\nmeta:")
    expect((connector as any).sampleDocuments.mock.calls).toEqual([["records", "events", 100]])
  })

  test("a failing document sample keeps the schema", async () => {
    const connector = configure("records")
    Object.assign(connector, { sampleDocuments: mock(async () => { throw new Error("not authorized") }) })
    const tool = await initTool(SchemaInspectTool)
    const result = await tool.execute({ warehouse: "documents", table: "records.events" }, ctx)
    expect(result.metadata.success).toBe(true)
    expect(result.output).toContain("id | STRING")
    expect(result.output).toContain("Value samples unavailable: not authorized")
  })
})
