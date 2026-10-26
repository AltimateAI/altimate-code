import { describe, expect, test } from "bun:test"
import { FileExporter, Trace, type TraceFile } from "../../src/altimate/observability/tracing"
import { tmpdir } from "../fixture/fixture"

describe("run budget trace metadata", () => {
  // altimate_change start — persist soft-deadline interruption and effort changes alongside budget fields
  test("preserves interruption and effort timestamps when a trace starts", async () => {
    await using tmp = await tmpdir()
    const trace = Trace.withExporters([new FileExporter(tmp.path, 0)])
    trace.startTrace("budget-interrupted", {
      prompt: "Answer the question",
      time_budget_s: 5,
      elapsed_s: 4,
      time_budget_deadline: "soft",
      effort_downgraded_at: 1_700_000_004_000,
      generation_interrupted_at: 1_700_000_004_001,
    })
    const file = (await Bun.file((await trace.endTrace())!).json()) as TraceFile
    expect(file.metadata).toMatchObject({
      time_budget_s: 5,
      time_budget_deadline: "soft",
      effort_downgraded_at: 1_700_000_004_000,
      generation_interrupted_at: 1_700_000_004_001,
    })
  })

  test("retains soft-deadline timestamps in the final hard-deadline trace", async () => {
    await using tmp = await tmpdir()
    const trace = Trace.withExporters([new FileExporter(tmp.path, 0)])
    trace.startTrace("budget-finalized", { prompt: "Answer the question" })
    const timestamps = {
      effort_downgraded_at: 1_700_000_004_000,
      generation_interrupted_at: 1_700_000_004_001,
    }
    trace.setRunBudget({ time_budget_s: 5, elapsed_s: 4, time_budget_deadline: "soft", ...timestamps })
    trace.setRunBudget({ time_budget_s: 5, elapsed_s: 5.1, time_budget_deadline: "hard", ...timestamps })
    const file = (await Bun.file((await trace.endTrace())!).json()) as TraceFile
    expect(file.metadata).toMatchObject({
      prompt: "Answer the question",
      time_budget_s: 5,
      elapsed_s: 5.1,
      time_budget_deadline: "hard",
      ...timestamps,
    })
  })
  // altimate_change end

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
