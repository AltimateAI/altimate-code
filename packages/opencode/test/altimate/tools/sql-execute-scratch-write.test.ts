import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { SessionID, MessageID } from "../../../src/session/schema"
import { SqlExecuteTool } from "../../../src/altimate/tools/sql-execute"
import * as Registry from "../../../src/altimate/native/connections/registry"
import { closeScratch } from "../../../src/altimate/native/connections/scratch"
import { initTool } from "../tool-fixture"

// The in-memory scratch database is the session's own workspace: writes there must not go
// through the `sql_execute_write` permission (which read-only agents deny), while writes to a
// real warehouse and the hard-deny list keep their behaviour.
const ctx = {
  sessionID: SessionID.make("ses_scratch_write"),
  messageID: MessageID.make("msg_scratch_write"),
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
  Registry.setConfigs({ other_db: { type: "sqlite", path: ":memory:" } as never })
})

afterEach(async () => {
  await closeScratch()
})

afterAll(() => {
  Registry.reset()
  if (previousTelemetry === undefined) delete process.env.ALTIMATE_TELEMETRY_DISABLED
  else process.env.ALTIMATE_TELEMETRY_DISABLED = previousTelemetry
})

describe("sql_execute writes to scratch", () => {
  test("DDL and DML in scratch run without asking for write permission", async () => {
    const tool = await initTool(SqlExecuteTool)
    const asked: any[] = []
    const track = { ...ctx, ask: async (req: any) => void asked.push(req) }
    const created: any = await tool.execute(
      { query: "CREATE TABLE probe AS SELECT 1 AS x", warehouse: "scratch", limit: 10 },
      track,
    )
    expect(created.metadata?.error).toBeUndefined()
    const inserted: any = await tool.execute({ query: "INSERT INTO probe VALUES (2)", warehouse: "scratch", limit: 10 }, track)
    expect(inserted.metadata?.error).toBeUndefined()
    const read: any = await tool.execute(
      { query: "SELECT count(*) AS n FROM probe", warehouse: "scratch", limit: 10 },
      track,
    )
    expect(read.output).toMatch(/\b2\b/)
    expect(asked).toHaveLength(0)
  })

  test("the hard-deny list still applies in scratch", async () => {
    const tool = await initTool(SqlExecuteTool)
    await expect(tool.execute({ query: "DROP SCHEMA main", warehouse: "scratch", limit: 10 }, ctx)).rejects.toThrow(
      /blocked for safety/,
    )
  })

  test("a write to any other warehouse still asks", async () => {
    const tool = await initTool(SqlExecuteTool)
    const asked: any[] = []
    await tool
      .execute(
        { query: "CREATE TABLE probe AS SELECT 1 AS x", warehouse: "other_db", limit: 10 },
        {
          ...ctx,
          ask: async (req: any) => {
            asked.push(req)
            throw new Error("denied by test")
          },
        },
      )
      .catch(() => {})
    expect(asked.map((r) => r.permission)).toEqual(["sql_execute_write"])
  })
})
