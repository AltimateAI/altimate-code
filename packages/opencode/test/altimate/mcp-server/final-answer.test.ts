// altimate_change start — the MCP FINAL ANSWER line carries only the answer
import { describe, expect, test } from "bun:test"
import { finalAnswerText } from "../../../src/altimate/mcp-server/adapter"

const basis = "Counted distinct orders in the sales table for 2024; refunds excluded."

describe("finalAnswerText", () => {
  test("puts the basis above an answer-only FINAL ANSWER line for fields", () => {
    const out = finalAnswerText(
      { fields: [{ name: "orders", value: 42 }], asked: ["orders"], basis },
      `${basis}\n\n**Answer:** 42`,
    )
    expect(out).toBe(`Basis: ${basis}\n\nFINAL ANSWER: 42`)
  })

  test("renders rows without the basis or answer label on the FINAL ANSWER line", () => {
    const out = finalAnswerText(
      {
        rows: { columns: ["city", "n"], values: [["Oslo", 3], ["Lima", 2]] },
        asked: ["city", "n"],
        basis,
      },
      "unused",
    )
    const answer = out.slice(out.indexOf("FINAL ANSWER: "))
    expect(out.startsWith(`Basis: ${basis}\n\n`)).toBe(true)
    expect(answer).toContain("Oslo")
    expect(answer).not.toContain("**Answer:**")
    expect(answer).not.toContain("refunds excluded")
  })

  test("omits the basis block when the caller already asked for answer_only", () => {
    const out = finalAnswerText(
      { fields: [{ name: "orders", value: 42 }], asked: ["orders"], basis, answer_only: true },
      "42",
    )
    expect(out).toBe("FINAL ANSWER: 42")
  })

  test("a complete fields commit for a two-item request gets the answer-only line", () => {
    const args = {
      fields: [
        { name: "repository", value: "repo-a" },
        { name: "most copied file", value: "main.swift" },
      ],
      asked: ["repository", "most copied file"],
      basis,
    }
    const out = finalAnswerText(args, "unused", "Which repository and its most copied file?")
    expect(out.startsWith(`Basis: ${basis}\n\nFINAL ANSWER: `)).toBe(true)
    expect(out.slice(out.indexOf("FINAL ANSWER: "))).not.toContain("**Answer:**")
  })

  test("an under-asked fields commit for a two-item request keeps the committed text on the line", () => {
    const committed = `${basis} The top file is main.swift.\n\n**Answer:** repository: repo-a`
    const out = finalAnswerText(
      { fields: [{ name: "repository", value: "repo-a" }], asked: ["repository"], basis },
      committed,
      "Which repository and its most copied file?",
    )
    expect(out).toBe(`FINAL ANSWER: ${committed}`)
  })

  test("unresolved commits keep the committed text on the line", () => {
    const out = finalAnswerText({ unresolved: { reason: "No rows." }, basis }, "committed", "How many orders?")
    expect(out).toBe("FINAL ANSWER: committed")
  })

  test("falls back to the committed text when the args cannot be re-rendered", () => {
    expect(finalAnswerText({ basis: "" }, "committed")).toBe("FINAL ANSWER: committed")
  })
})
// altimate_change end
