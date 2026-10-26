import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { SessionID, MessageID } from "../../../src/session/schema"
import { SqlExecuteTool } from "../../../src/altimate/tools/sql-execute"
import { SqlMaterializeTool } from "../../../src/altimate/tools/sql-materialize"
import * as Registry from "../../../src/altimate/native/connections/registry"
import { closeScratch } from "../../../src/altimate/native/connections/scratch"
import { initTool } from "../tool-fixture"

// An evaluation run died with `UnknownError: JSON.stringify cannot serialize BigInt` right after a
// DuckDB `COUNT(DISTINCT …)` on scratch: tool results are persisted and traced as JSON, so no
// BigInt may survive into a tool result's metadata or output.
const ctx = {
  sessionID: SessionID.make("ses_bigint_meta"),
  messageID: MessageID.make("msg_bigint_meta"),
  callID: "",
  agent: "analyst",
  abort: AbortSignal.any([]),
  messages: [] as any[],
  metadata: () => {},
  ask: async () => {},
}

let previousTelemetry: string | undefined

beforeAll(() => {
  previousTelemetry = process.env.ALTIMATE_TELEMETRY_DISABLED
  process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
  Registry.setConfigs({})
})

afterEach(async () => {
  await closeScratch()
})

afterAll(() => {
  Registry.reset()
  if (previousTelemetry === undefined) delete process.env.ALTIMATE_TELEMETRY_DISABLED
  else process.env.ALTIMATE_TELEMETRY_DISABLED = previousTelemetry
})

describe("tool results stay JSON-serializable with BigInt values", () => {
  test("sql_execute COUNT(DISTINCT) on scratch", async () => {
    const tool = await initTool(SqlExecuteTool)
    await tool.execute({ query: "CREATE TABLE t AS SELECT * FROM (VALUES ('a'), ('b'), ('a')) v(name)", warehouse: "scratch", limit: 10 }, ctx)
    const r: any = await tool.execute(
      { query: "SELECT COUNT(DISTINCT name) AS n, COUNT(*) AS total, 9223372036854775807 AS big FROM t", warehouse: "scratch", limit: 10 },
      ctx,
    )
    expect(r.metadata?.error).toBeUndefined()
    expect(() => JSON.stringify(r)).not.toThrow()
    expect(r.output).toContain("9223372036854775807")
  })

  test("sql_execute with a lint finding and BigInt values", async () => {
    const tool = await initTool(SqlExecuteTool)
    await tool.execute({ query: "CREATE TABLE t2 AS SELECT * FROM (VALUES ('a', 1), ('b', 2), ('a', 3)) v(name, n)", warehouse: "scratch", limit: 10 }, ctx)
    const r: any = await tool.execute(
      { query: "SELECT name || NULL AS tagged, COUNT(*) AS c, SUM(n) AS s FROM t2 GROUP BY 1", warehouse: "scratch", limit: 10 },
      ctx,
    )
    expect(r.metadata?.error).toBeUndefined()
    expect(r.output).toContain("Checks:")
    expect(() => JSON.stringify(r)).not.toThrow()
  })

  test("sql_materialize from a scratch query with BigInt columns", async () => {
    const exec = await initTool(SqlExecuteTool)
    await exec.execute({ query: "CREATE TABLE src AS SELECT range AS id, 9223372036854775807 - range AS big FROM range(5)", warehouse: "scratch", limit: 10 }, ctx)
    const mat = await initTool(SqlMaterializeTool)
    const r: any = await mat.execute(
      { source_warehouse: "scratch", sql: "SELECT id, big, COUNT(*) OVER () AS n FROM src", target_table: "dst" },
      ctx,
    )
    expect(r.title).not.toContain("ERROR")
    expect(() => JSON.stringify(r)).not.toThrow()
    const back: any = await exec.execute({ query: "SELECT max(big) AS m, count(*) AS c FROM dst", warehouse: "scratch", limit: 10 }, ctx)
    expect(back.output).toContain("9223372036854775807")
    expect(() => JSON.stringify(back)).not.toThrow()
  })
})
