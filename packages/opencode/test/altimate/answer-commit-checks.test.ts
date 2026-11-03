import { afterEach, expect, test } from "bun:test"
import { unsourcedNumbers } from "../../src/altimate/tools/answer-commit-checks"
import { AnswerCommitTool } from "../../src/altimate/tools/answer-commit"
import { RunBudget } from "../../src/altimate/run-budget"
import { initTool } from "./tool-fixture"

let stop: (() => void) | undefined
afterEach(() => {
  stop?.()
  stop = undefined
})

test("a 16-digit integer matching query output is sourced", () => {
  const args = { fields: [{ name: "bytes", value: 1234567890123456 }] }
  expect(unsourcedNumbers(args, new Set(["1234567890123456"]))).toEqual([])
  expect(unsourcedNumbers(args, new Set(["999"]))).toEqual(["1234567890123456"])
})

test("number check does not reject once the run budget deadline has passed", async () => {
  const sessionID = "ses_budget_ending"
  const tool = await initTool(AnswerCommitTool)
  const sql = [
    { info: { role: "user" }, parts: [{ type: "text", text: "count" }] },
    { info: { role: "assistant" }, parts: [{ type: "tool", tool: "sql_execute", state: { status: "completed", output: "7" } }] },
  ]
  const args = { fields: [{ name: "n", value: 123456 }], basis: "b", asked: ["n"] }
  const ctx = { sessionID, agent: "analyst", messages: sql, abort: AbortSignal.any([]), metadata: () => {}, ask: async () => {}, extra: {} }
  const rejected = await tool.execute(args, ctx)
  expect(rejected.status).toBe("error")

  stop = RunBudget.registerQueryDeadline(sessionID, Date.now() - 1)
  const accepted = await tool.execute(args, ctx)
  expect(accepted.status).not.toBe("error")
})
