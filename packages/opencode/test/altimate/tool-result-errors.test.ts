import { afterEach, describe, expect, spyOn, test } from "bun:test"
import z from "zod"
import { Tool } from "../../src/tool/tool"
import { Telemetry } from "../../src/altimate/telemetry"
import { initTool } from "./tool-fixture"

const parserOutput = `Failed to execute SQL: Error: Parser Error: syntax error at or near "nulls"

LINE 1: ..., sum(case when normalized_count is null then 1 else 0 end) nulls from lgg l join igf2 i on i.ParticipantBarcode=l.b...
                                                                       ^`
const materializeOutput =
  "Failed to materialize: The source query has more than 2,000,000 rows, above the row cap of 2,000,000 rows; nothing was materialized. Aggregate or filter in the source query, select fewer columns, or raise max_rows (hard limit 20,000,000) / max_bytes (hard limit 2 GiB)."

const ctx: any = {
  sessionID: "ses_tool_errors",
  messageID: "msg_tool_errors",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata() {},
  async ask() {},
}
const spies: Array<{ mockRestore(): void }> = []
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
})

async function execute(id: string, output: string, metadata: Record<string, unknown>, status?: "ok" | "error") {
  const tool = await initTool(
    Tool.define(id, {
      description: "Tool result fixture",
      parameters: z.object({}),
      async execute() {
        return { title: id, output, metadata, status }
      },
    }),
  )
  return tool.execute({}, ctx)
}

describe("tool result failures", () => {
  test.each([
    ["sql_execute", parserOutput, parserOutput.slice("Failed to execute SQL: ".length)],
    ["sql_materialize", materializeOutput, materializeOutput.slice("Failed to materialize: ".length)],
  ])("%s marks backend error metadata as a failed envelope and telemetry event", async (id, output, error) => {
    const events: Telemetry.Event[] = []
    spies.push(
      spyOn(Telemetry, "track").mockImplementation((event) => {
        events.push(event)
      }),
    )
    const result = await execute(id, output, { error, truncated: false })
    expect(result.status).toBe("error")
    expect(result.metadata.success).toBe(false)
    expect(result.output).toBe(output)
    expect(events.find((event) => event.type === "tool_call")).toMatchObject({ status: "error" })
    expect(events.some((event) => event.type === "core_failure")).toBe(true)
    expect(() => Tool.assertSuccess(result)).toThrow(output)
  })

  test("ordinary bash nonzero exits do not produce failure signals or an SDK error", async () => {
    const events: Telemetry.Event[] = []
    spies.push(
      spyOn(Telemetry, "track").mockImplementation((event) => {
        events.push(event)
      }),
    )
    const result = await execute("bash", "No matching lines", { success: false, exit_code: 1, truncated: false })
    expect(result.status).not.toBe("error")
    expect(result.metadata).toMatchObject({ success: false, exit_code: 1 })
    expect(() => Tool.assertSuccess(result)).not.toThrow()
    expect(events.some((event) => event.type === "tool_call" && event.status === "error")).toBe(false)
    expect(events.some((event) => event.type === "core_failure")).toBe(false)
  })

  test("explicit error envelopes become SDK errors without error metadata", async () => {
    const result = await execute("analysis", "Could not run the requested operation", {}, "error")
    expect(result.status).toBe("error")
    expect(() => Tool.assertSuccess(result)).toThrow(result.output)
  })

  test("successful text containing errors is not classified as execution failure", async () => {
    const result = await execute("sql_execute", `message\n${parserOutput}`, { rowCount: 1 })
    expect(result.status).not.toBe("error")
    expect(() => Tool.assertSuccess(result)).not.toThrow()
  })

  test("successful validation may carry findings in error metadata", async () => {
    const result = await execute("altimate_core_validate", "Table 'users' not found", {
      success: true,
      valid: false,
      error: "Table 'users' not found",
      findings: [{ category: "missing_table" }],
    })
    expect(result.status).not.toBe("error")
    expect(result.metadata.success).toBe(true)
    expect(() => Tool.assertSuccess(result)).not.toThrow()
  })
})
