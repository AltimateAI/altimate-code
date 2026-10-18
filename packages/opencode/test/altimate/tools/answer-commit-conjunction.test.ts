import { expect, test } from "bun:test"
import { AnswerCommitTool, renderAnswer } from "../../../src/altimate/tools/answer-commit"
import { CONJUNCTION_REJECTION_MARKER, requestedItemCount } from "../../../src/altimate/tools/answer-commit-conjunction"
import type { Tool } from "../../../src/tool/tool"
import { initTool } from "../tool-fixture"

const singles = [
  "Which repository has the most stars?",
  "How many films were released between 2010 and 2015?",
  "Which artist sold the most Rock and Roll albums?",
  "Which artist sold the most rock and roll albums?",
  "Which customer from Trinidad and Tobago spent the most?",
  "List the top product, and only consider active stores.",
]
const compound = "Which repository and its most copied file?"
const payload = {
  basis: "Selected repositories at repository grain from repositories.name.",
  asked: ["repository"],
  fields: [{ name: "repository", value: "repo-a" }],
}
function user(text: string) {
  return { info: { role: "user" }, parts: [{ type: "text", text }] }
}
// The advisory is recorded per session, so each call gets a fresh session unless one is shared.
function context(messages: unknown[] = [], sessionID: string = crypto.randomUUID()) {
  return {
    sessionID,
    messageID: "test-message",
    agent: "analyst",
    abort: new AbortController().signal,
    messages: messages as Tool.Context["messages"],
    ask: () => {},
  }
}

test.each(singles)("counts one item: %s", (request) => {
  expect(requestedItemCount(request)).toBe(1)
})
test("counts related requested items", () => {
  expect(requestedItemCount("Which repository contains Swift code and its most copied file?")).toBe(2)
})
test.each([true, false])("rejects once with asked present: %s", async (withAsked) => {
  const tool = await initTool(AnswerCommitTool)
  const input = { ...payload, asked: withAsked ? payload.asked : undefined }
  const first = await tool.execute(input, context([user(compound)]))
  expect(first.status).toBe("error")
  expect(first.output.startsWith(CONJUNCTION_REJECTION_MARKER)).toBe(true)
  const prior = {
    info: { role: "assistant" },
    parts: [{ type: "tool", tool: "answer_commit", state: { status: "error", error: first.output } }],
  }
  const second = await tool.execute(input, context([user(compound), prior]))
  expect(second.status).not.toBe("error")
  expect(second.output).toBe(renderAnswer(input))
  const next = "Which author and their most cited paper?"
  expect((await tool.execute(input, context([user(compound), prior, user(next)]))).status).toBe("error")
})
test("rejects once per session and request without history of the rejection", async () => {
  const tool = await initTool(AnswerCommitTool)
  const session = crypto.randomUUID()
  // Parallel commits in one step share the same history snapshot.
  const [first, second] = await Promise.all([
    tool.execute(payload, context([user(compound)], session)),
    tool.execute(payload, context([user(compound)], session)),
  ])
  expect([first.status, second.status].filter((status) => status === "error")).toHaveLength(1)
  // A compaction replay repeats the request as a new user message without the earlier rejection.
  const replay = await tool.execute(payload, context([user(compound)], session))
  expect(replay.output).toBe(renderAnswer(payload))
  expect((await tool.execute(payload, context([user(compound)]))).status).toBe("error")
})
test("answer_only still receives the advisory", async () => {
  const tool = await initTool(AnswerCommitTool)
  const result = await tool.execute(
    { ...payload, answer_only: true },
    context([user("Identify the repository and the most copied file.")]),
  )
  expect(result.status).toBe("error")
  expect(result.output.startsWith(CONJUNCTION_REJECTION_MARKER)).toBe(true)
})
test.each(singles)("accepts single-item request: %s", async (request) => {
  const tool = await initTool(AnswerCommitTool)
  expect((await tool.execute(payload, context([user(request)]))).output).toBe(renderAnswer(payload))
})
test("accepts both requested items without rendering asked", async () => {
  const tool = await initTool(AnswerCommitTool)
  const input = {
    ...payload,
    asked: ["repository", "most copied file"],
    fields: [...payload.fields, { name: "most copied file", value: "main.swift" }],
  }
  const result = await tool.execute(input, context([user(compound)]))
  expect(result.status).not.toBe("error")
  expect(result.metadata.asked).toEqual(input.asked)
  expect(result.output).toBe(renderAnswer({ ...input, asked: undefined }))
})
test("accepts unresolved and missing user messages", async () => {
  const tool = await initTool(AnswerCommitTool)
  const unresolved = { basis: payload.basis, unresolved: { reason: "No matching records." }, asked: payload.asked }
  expect((await tool.execute(unresolved, context([user(compound)]))).output).toBe(renderAnswer(unresolved))
  expect((await tool.execute(payload, context())).output).toBe(renderAnswer(payload))
})
test("rows need asked and blank asked entries fall back to fields", async () => {
  const tool = await initTool(AnswerCommitTool)
  const rows = { basis: payload.basis, rows: { columns: ["repository"], values: [["repo-a"]] } }
  expect((await tool.execute(rows, context([user(compound)]))).output).toBe(renderAnswer(rows))
  expect((await tool.execute({ ...rows, asked: ["repository"] }, context([user(compound)]))).status).toBe("error")
  expect((await tool.execute({ ...payload, asked: [" "] }, context([user(compound)]))).status).toBe("error")
})
