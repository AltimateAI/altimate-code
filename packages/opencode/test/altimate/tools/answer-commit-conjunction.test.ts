import { describe, expect, test } from "bun:test"
import { RunBudget } from "../../../src/altimate/run-budget"
import { begin, downgradeEffort } from "../../../src/altimate/session/run-budget-effort"
import { AnswerCommitTool, renderAnswer } from "../../../src/altimate/tools/answer-commit"
import { CONJUNCTION_REJECTION_MARKER, requestedItems } from "../../../src/altimate/tools/answer-commit-conjunction"
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
const basis = "Selected repositories at repository grain from repositories.name."
const payload = { basis, fields: [{ name: "repository", value: "repo-a" }] }
const complete = { basis, fields: [...payload.fields, { name: "most copied file", value: "main.swift" }] }
function user(text: string) {
  return { info: { role: "user" }, parts: [{ type: "text", text }] }
}
function rejectedCommit(error: string) {
  return {
    info: { role: "assistant" },
    parts: [{ type: "tool", tool: "answer_commit", state: { status: "error", error } }],
  }
}
// The rejection is recorded per session, so each call gets a fresh session unless one is shared.
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

describe("requestedItems", () => {
  test.each(singles)("counts one item: %s", (request) => {
    expect(requestedItems(request)).toEqual({ count: 1, joins: [] })
  })
  test("counts and quotes the connective that introduces each extra item", () => {
    expect(requestedItems(compound)).toEqual({ count: 2, joins: ["and its most copied file"] })
    expect(requestedItems("Identify the repository and the most copied file.").joins).toEqual([
      "and the most copied file",
    ])
    expect(requestedItems("Which repository contains Swift code and its most copied file?").count).toBe(2)
  })
  test("takes the sentence with the most items and ignores later paragraphs", () => {
    const request =
      "Find the store with the most sales, along with its city, and the manager's name. Round to 2 decimals.\n\nThe schema has a stores table and a sales table."
    expect(requestedItems(request)).toEqual({ count: 3, joins: ["along with its city", "and the manager's name"] })
  })
})

describe("answer_commit conjunction check", () => {
  test("rejects an under-asked fields commit once, naming the missing item; an unchanged recommit is accepted", async () => {
    const tool = await initTool(AnswerCommitTool)
    const session = crypto.randomUUID()
    const first = await tool.execute(payload, context([user(compound)], session))
    expect(first.status).toBe("error")
    expect(first.title).toBe("Answer not committed")
    expect(first.output.startsWith(CONJUNCTION_REJECTION_MARKER)).toBe(true)
    expect(first.output).toContain('"and its most copied file"')
    expect(first.output).toContain('["repository"]')
    expect(first.metadata).not.toHaveProperty("committed_text")
    expect(first.metadata).toHaveProperty("failure_kind", "conjunction_check")
    const second = await tool.execute(payload, context([user(compound), rejectedCommit(first.output)], session))
    expect(second.status).not.toBe("error")
    expect(second.output).toBe(renderAnswer(payload))
    expect(second.metadata).toHaveProperty("committed_text", renderAnswer(payload))
  })
  test("the rejection in history alone allows the recommit, as after a restart", async () => {
    const tool = await initTool(AnswerCommitTool)
    const first = await tool.execute(payload, context([user(compound)]))
    const resumed = await tool.execute(payload, context([user(compound), rejectedCommit(first.output)]))
    expect(resumed.output).toBe(renderAnswer(payload))
    // A rejection before the latest request does not cover the new request.
    const next = "Which author and their most cited paper?"
    const later = await tool.execute(payload, context([user(compound), rejectedCommit(first.output), user(next)]))
    expect(later.status).toBe("error")
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
    expect((await tool.execute(payload, context([user(compound)], session))).output).toBe(renderAnswer(payload))
    expect((await tool.execute(payload, context([user(compound)]))).status).toBe("error")
  })
  test("answer_only commits are checked too", async () => {
    const tool = await initTool(AnswerCommitTool)
    const result = await tool.execute(
      { ...payload, answer_only: true },
      context([user("Identify the repository and the most copied file.")]),
    )
    expect(result.status).toBe("error")
  })
  test("two fields for a three-item request are rejected; three are accepted", async () => {
    const tool = await initTool(AnswerCommitTool)
    const request = "Find the store with the most sales, along with its city, and the manager's name."
    expect((await tool.execute(complete, context([user(request)]))).status).toBe("error")
    const three = { basis, fields: [...complete.fields, { name: "manager", value: "Ana" }] }
    expect((await tool.execute(three, context([user(request)]))).output).toBe(renderAnswer(three))
  })
  test.each(singles)("accepts a single-item request: %s", async (request) => {
    const tool = await initTool(AnswerCommitTool)
    expect((await tool.execute(payload, context([user(request)]))).output).toBe(renderAnswer(payload))
  })
  test("accepts complete fields, rows, unresolved and commits without a user message", async () => {
    const tool = await initTool(AnswerCommitTool)
    expect((await tool.execute(complete, context([user(compound)]))).output).toBe(renderAnswer(complete))
    const rows = { basis, rows: { columns: ["repository"], values: [["repo-a"]] } }
    expect((await tool.execute(rows, context([user(compound)]))).output).toBe(renderAnswer(rows))
    const unresolved = { basis, unresolved: { reason: "No matching records." } }
    expect((await tool.execute(unresolved, context([user(compound)]))).output).toBe(renderAnswer(unresolved))
    expect((await tool.execute(payload, context())).output).toBe(renderAnswer(payload))
  })
})

describe("near the time budget a commit is never rejected", () => {
  test("after the query deadline", async () => {
    const tool = await initTool(AnswerCommitTool)
    const session = crypto.randomUUID()
    const release = RunBudget.registerQueryDeadline(session, Date.now() - 1)
    try {
      expect((await tool.execute(payload, context([user(compound)], session))).output).toBe(renderAnswer(payload))
    } finally {
      release()
    }
    // The same session is checked again once no deadline applies.
    expect((await tool.execute(payload, context([user(compound)], session))).status).toBe("error")
  })
  test("once effort is downgraded at the soft deadline", async () => {
    const tool = await initTool(AnswerCommitTool)
    const session = crypto.randomUUID()
    const release = begin(session)
    downgradeEffort(session)
    try {
      expect((await tool.execute(payload, context([user(compound)], session))).output).toBe(renderAnswer(payload))
    } finally {
      release()
    }
  })
  test("after the synthetic time-budget reminder", async () => {
    const tool = await initTool(AnswerCommitTool)
    // The reminder joins two items, so it would be rejected if synthetic text were read as the request.
    const text = "Answer now, and the basis in one sentence."
    expect(requestedItems(text).count).toBe(2)
    const reminder = { info: { role: "user" }, parts: [{ type: "text", text, synthetic: true }] }
    expect((await tool.execute(payload, context([user(compound), reminder]))).output).toBe(renderAnswer(payload))
  })
})

// Native replies echo the committed text: the basis paragraph sits above the `**Answer:**` line.
describe("committed answer layout", () => {
  const answerLine = (text: string) => text.slice(text.indexOf("**Answer:**"))
  test("a complete fields commit keeps the basis off the answer line", () => {
    const text = renderAnswer(complete)
    expect(text).toBe(`${basis}\n\n**Answer:** repository: repo-a; most copied file: main.swift`)
    expect(answerLine(text)).not.toContain(basis)
  })
  test("a rows commit keeps the basis off the answer", () => {
    const text = renderAnswer({ basis, rows: { columns: ["repository"], values: [["repo-a"]] } })
    expect(text.startsWith(`${basis}\n\n**Answer:**\n`)).toBe(true)
    expect(answerLine(text)).not.toContain(basis)
  })
  test("an accepted under-asked commit keeps the basis in the reply", async () => {
    const tool = await initTool(AnswerCommitTool)
    const withItem = { ...payload, basis: `${basis} Its most copied file is main.swift.` }
    const first = await tool.execute(withItem, context([user(compound)]))
    const accepted = await tool.execute(withItem, context([user(compound), rejectedCommit(first.output)]))
    expect(accepted.metadata.committed_text).toBe(`${withItem.basis}\n\n**Answer:** repository: repo-a`)
  })
})
