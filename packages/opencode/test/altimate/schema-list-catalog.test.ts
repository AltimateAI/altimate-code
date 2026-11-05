import { afterEach, expect, mock, spyOn, test } from "bun:test"
import type { Connector } from "@altimateai/drivers"
import * as Registry from "../../src/altimate/native/connections/registry"
import { listSchemaTables } from "../../src/altimate/native/connections/schema-list"

afterEach(() => {
  mock.restore()
})

function fake(type: string, listSchemas: string[] = []) {
  const execute = mock(async (_sql: string, _limit?: number, _binds?: unknown[]) => ({
    columns: ["name", "type"],
    rows: [["t", "BASE TABLE"]],
    row_count: 1,
    truncated: false,
  }))
  const connector = { listSchemas: async () => listSchemas, execute } as unknown as Connector
  spyOn(Registry, "get").mockResolvedValue(connector)
  spyOn(Registry, "getConfig").mockReturnValue({ type } as never)
  return execute
}

for (const type of ["mysql", "redshift"]) {
  test(`${type}: schema filter is an escaped literal and no binds are sent`, async () => {
    const execute = fake(type)
    await listSchemaTables({ warehouse: "w", schema_name: "o'brien\\x" })
    const [sql, , binds] = execute.mock.calls[0]!
    expect(sql).toContain("t.table_schema = 'o''brien\\\\x'")
    expect(sql).not.toMatch(/\$1|= \?/)
    expect(binds).toBeUndefined()
  })
}

test("postgres: schema filter stays a bind", async () => {
  const execute = fake("postgres")
  await listSchemaTables({ warehouse: "w", schema_name: "public" })
  const [sql, , binds] = execute.mock.calls[0]!
  expect(sql).toContain("t.table_schema = $1")
  expect(binds).toEqual(["public"])
})

test("fallback schema listing sorts the full list before applying the limit", async () => {
  const names = Array.from({ length: 250 }, (_, i) => `s${String(250 - i).padStart(3, "0")}`)
  fake("clickhouse", names)
  const result = await listSchemaTables({ warehouse: "w" })
  expect(result.schemas).toHaveLength(200)
  expect(result.schemas![0]!.name).toBe("s001")
  expect(result.schemas![199]!.name).toBe("s200")
  expect(result.truncated).toBe(true)
})
