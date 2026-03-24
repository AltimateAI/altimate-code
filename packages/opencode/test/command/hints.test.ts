import { describe, test, expect } from "bun:test"
import { Command } from "../../src/command/index"

describe("Command.hints — template placeholder extraction", () => {
  test("extracts numbered placeholders in order", () => {
    expect(Command.hints("Do $1 then $2")).toEqual(["$1", "$2"])
  })

  test("deduplicates repeated numbered placeholders", () => {
    expect(Command.hints("Use $1 and $1 again")).toEqual(["$1"])
  })

  test("extracts $ARGUMENTS", () => {
    expect(Command.hints("Run with $ARGUMENTS")).toEqual(["$ARGUMENTS"])
  })

  test("numbered placeholders before $ARGUMENTS", () => {
    expect(Command.hints("Do $2 then $1 with $ARGUMENTS")).toEqual(["$1", "$2", "$ARGUMENTS"])
  })

  test("returns empty for no placeholders", () => {
    expect(Command.hints("Plain text with no variables")).toEqual([])
  })

  test("handles template with only $ARGUMENTS", () => {
    expect(Command.hints("If $ARGUMENTS contains --scope global")).toEqual(["$ARGUMENTS"])
  })

  test("only recognises $N and $ARGUMENTS — not $OTHER or $FOO", () => {
    expect(Command.hints("Use $OTHER and $FOO")).toEqual([])
  })
})
