import { describe, expect, test } from "bun:test"
import { joinRunMessage } from "../../../src/cli/cmd/run"
import { correctionReason } from "../../../src/altimate/learn/correction"

describe("run message arguments", () => {
  test("preserves spaces and literal quotes in a plain prompt", () => {
    expect(joinRunMessage(['Use "to_utc" here.'], false)).toBe('Use "to_utc" here.')
  })

  test("joins multiple plain prompt arguments with a single space", () => {
    expect(joinRunMessage(["Please", "use to_utc", "here."], false)).toBe("Please use to_utc here.")
  })

  test("quotes command arguments containing spaces and escapes embedded quotes as before", () => {
    expect(joinRunMessage(["first", 'use "to_utc" here', '"last"'], true)).toBe(
      'first "use \\"to_utc\\" here" "last"',
    )
  })

  test("keeps a single-argument correction recognizable by learning capture", () => {
    const message = joinRunMessage(["No, use to_utc."], false)
    expect(message).toBe("No, use to_utc.")
    expect(correctionReason(message)).toBe("user rejected the previous action and gave a direction")
  })
})
