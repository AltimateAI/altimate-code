import { describe, test, expect } from "bun:test"
import { Command } from "../../src/command/index"

describe("Command.hints: template placeholder extraction", () => {
  test("extracts numbered placeholders in sorted order", () => {
    expect(Command.hints("Do $2 then $1")).toEqual(["$1", "$2"])
  })

  test("deduplicates repeated placeholders", () => {
    expect(Command.hints("Use $1 and $1 again")).toEqual(["$1"])
  })

  test("extracts $ARGUMENTS", () => {
    expect(Command.hints("Run with $ARGUMENTS")).toEqual(["$ARGUMENTS"])
  })

  test("extracts both numbered and $ARGUMENTS", () => {
    expect(Command.hints("Do $1 with $ARGUMENTS")).toEqual(["$1", "$ARGUMENTS"])
  })

  test("returns empty for templates with no placeholders", () => {
    expect(Command.hints("Just a plain prompt")).toEqual([])
  })

  test("does not extract $ARGUMENTS as numbered", () => {
    // $ARGUMENTS should only appear via the explicit check, not the numbered regex
    expect(Command.hints("$ARGUMENTS only")).toEqual(["$ARGUMENTS"])
  })

  test("handles double-digit placeholders with lexicographic sort", () => {
    // Note: sort is lexicographic, so $10 < $2. This documents current behavior.
    expect(Command.hints("$10 then $2 then $1")).toEqual(["$1", "$10", "$2"])
  })
})
