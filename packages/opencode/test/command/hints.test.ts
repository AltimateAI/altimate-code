import { describe, test, expect } from "bun:test"
import { Command } from "../../src/command/index"

describe("Command.hints: template placeholder extraction", () => {
  test("extracts numbered placeholders in order", () => {
    expect(Command.hints("Do $1 then $2")).toEqual(["$1", "$2"])
  })

  test("deduplicates repeated placeholders", () => {
    expect(Command.hints("Use $1 and $1 again")).toEqual(["$1"])
  })

  test("sorts numbered placeholders numerically by string sort", () => {
    // $10 sorts after $1 and $2 in string order
    expect(Command.hints("$2 then $1 then $10")).toEqual(["$1", "$10", "$2"])
  })

  test("extracts $ARGUMENTS", () => {
    expect(Command.hints("Run with $ARGUMENTS")).toEqual(["$ARGUMENTS"])
  })

  test("extracts both numbered and $ARGUMENTS", () => {
    expect(Command.hints("$1 and $ARGUMENTS")).toEqual(["$1", "$ARGUMENTS"])
  })

  test("returns empty array for template with no placeholders", () => {
    expect(Command.hints("No placeholders here")).toEqual([])
  })

  test("returns empty array for empty string", () => {
    expect(Command.hints("")).toEqual([])
  })

  test("does not extract $SOMETHING_ELSE as a hint", () => {
    // Only $N and $ARGUMENTS should be extracted
    expect(Command.hints("$FOO $BAR")).toEqual([])
  })

  test("handles template with only $ARGUMENTS", () => {
    expect(Command.hints("$ARGUMENTS")).toEqual(["$ARGUMENTS"])
  })
})
