import { describe, expect, test } from "bun:test"
import { SessionTermination } from "../../src/session/termination"

describe("SessionTermination.replyAfterSilentTurn (#1334)", () => {
  test("names the failed tool and its error, tells the model not to retry it, and asks for a text answer", () => {
    const text = SessionTermination.replyAfterSilentTurn({
      tool: "bash",
      error: "The user rejected permission to use this specific tool call.",
    })
    expect(text).toContain("`bash` failed")
    expect(text).toContain("rejected permission")
    expect(text).toContain("Do not retry that tool")
    expect(text).toContain("Answer the user's request now, in text")
    expect(text).toContain("what could not be completed and why")
  })

  test("with no known failure it still asks for a reply", () => {
    const text = SessionTermination.replyAfterSilentTurn()
    expect(text).toContain("ended without a reply")
    expect(text).toContain("Answer the user's request now")
  })

  test("a long or multi-line error is flattened and bounded", () => {
    const text = SessionTermination.replyAfterSilentTurn({ tool: "finops_warehouse_advice", error: "line1\n\nline2 " + "x".repeat(2000) })
    expect(text).not.toContain("\n")
    expect(text.length).toBeLessThan(700)
  })
})
