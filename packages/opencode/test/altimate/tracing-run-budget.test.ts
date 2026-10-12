import { describe, expect, test } from "bun:test"
import { FileExporter, Trace, type TraceFile } from "../../src/altimate/observability/tracing"
import { tmpdir } from "../fixture/fixture"

describe("run budget trace metadata", () => {
  test("preserves budget metadata supplied when a trace starts", async () => {
    await using tmp = await tmpdir()
    const trace = Trace.withExporters([new FileExporter(tmp.path, 0)])
    trace.startTrace("budget-start", {
      prompt: "Answer the question",
      max_turns: 10,
      time_budget_s: 2.5,
      elapsed_s: 0,
      time_budget_deadline: "none",
    })
    const file = (await Bun.file((await trace.endTrace())!).json()) as TraceFile
    expect(file.metadata).toMatchObject({
      prompt: "Answer the question",
      max_turns: 10,
      time_budget_s: 2.5,
      elapsed_s: 0,
      time_budget_deadline: "none",
    })
  })

  test("persists the latest deadline without replacing other run metadata", async () => {
    await using tmp = await tmpdir()
    const trace = Trace.withExporters([new FileExporter(tmp.path, 0)])
    trace.startTrace("budget-finish", { prompt: "Answer the question" })
    trace.setRunLineage({ rootSessionId: "budget-finish" })
    trace.setRunBudget({ max_turns: 10, time_budget_s: 2.5, elapsed_s: 2, time_budget_deadline: "soft" })
    trace.setRunBudget({ max_turns: 10, time_budget_s: 2.5, elapsed_s: 2.51, time_budget_deadline: "hard" })
    const file = (await Bun.file((await trace.endTrace())!).json()) as TraceFile
    expect(file.metadata).toMatchObject({
      prompt: "Answer the question",
      run: { rootSessionId: "budget-finish" },
      max_turns: 10,
      time_budget_s: 2.5,
      elapsed_s: 2.51,
      time_budget_deadline: "hard",
    })
  })
})
