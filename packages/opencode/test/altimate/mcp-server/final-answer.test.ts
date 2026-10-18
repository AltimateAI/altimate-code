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

  test("falls back to the committed text when the args cannot be re-rendered", () => {
    expect(finalAnswerText({ basis: "" }, "committed")).toBe("FINAL ANSWER: committed")
  })
})
// altimate_change end
