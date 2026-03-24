import { describe, test, expect } from "bun:test"
import { Command } from "../../src/command/index"

describe("Command.hints: template placeholder extraction", () => {
  test("extracts sorted numbered placeholders", () => {
    expect(Command.hints("Do $2 then $1 and $3")).toEqual(["$1", "$2", "$3"])
  })

  test("extracts $ARGUMENTS", () => {
    expect(Command.hints("Run something with $ARGUMENTS")).toEqual(["$ARGUMENTS"])
  })

  test("extracts both numbered and $ARGUMENTS", () => {
    expect(Command.hints("Do $1 with $ARGUMENTS")).toEqual(["$1", "$ARGUMENTS"])
  })

  test("deduplicates repeated numbered placeholders", () => {
    expect(Command.hints("$1 and $1 again")).toEqual(["$1"])
  })

  test("returns empty for template with no placeholders", () => {
    expect(Command.hints("Just a plain template")).toEqual([])
  })

  test("returns empty for empty string", () => {
    expect(Command.hints("")).toEqual([])
  })

  test("handles non-sequential numbering", () => {
    expect(Command.hints("$3 then $7")).toEqual(["$3", "$7"])
  })
})
