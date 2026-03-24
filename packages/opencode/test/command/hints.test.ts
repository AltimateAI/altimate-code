import { describe, test, expect } from "bun:test"
import { Command } from "../../src/command/index"

describe("Command.hints: template placeholder parsing", () => {
  test("extracts numbered placeholders in order", () => {
    expect(Command.hints("run $1 with $2")).toEqual(["$1", "$2"])
  })

  test("deduplicates repeated placeholders", () => {
    expect(Command.hints("compare $1 to $1")).toEqual(["$1"])
  })

  test("sorts numbered placeholders lexicographically", () => {
    // String sort: "$1" < "$2" < "$3"
    expect(Command.hints("$3 then $1 then $2")).toEqual(["$1", "$2", "$3"])
  })

  test("$ARGUMENTS appears after numbered placeholders", () => {
    expect(Command.hints("do $1 $ARGUMENTS")).toEqual(["$1", "$ARGUMENTS"])
  })

  test("returns only $ARGUMENTS when no numbered placeholders", () => {
    expect(Command.hints("run $ARGUMENTS")).toEqual(["$ARGUMENTS"])
  })

  test("returns empty array when no placeholders", () => {
    expect(Command.hints("static template with no args")).toEqual([])
  })

  test("multi-digit placeholders sort lexicographically, not numerically", () => {
    // String sort puts "$10" before "$2" — this is the actual behavior.
    // If a template uses $10+, the TUI hint order will be $1, $10, $2.
    expect(Command.hints("$10 $2 $1")).toEqual(["$1", "$10", "$2"])
  })

  test("empty template returns empty array", () => {
    expect(Command.hints("")).toEqual([])
  })
})
