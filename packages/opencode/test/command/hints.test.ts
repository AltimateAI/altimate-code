import { describe, test, expect } from "bun:test"
import { Command } from "../../src/command"

/**
 * Tests for Command.hints() — the pure function that extracts argument
 * placeholders ($1, $2, ..., $ARGUMENTS) from command templates.
 *
 * These hints drive the TUI's argument prompt display. If hints are wrong,
 * users see incorrect or missing argument suggestions when invoking commands
 * like /review, /init, or custom commands.
 */

describe("Command.hints", () => {
  test("returns empty array for template with no placeholders", () => {
    expect(Command.hints("Run all tests")).toEqual([])
  })

  test("extracts single numbered placeholder", () => {
    expect(Command.hints("Review commit $1")).toEqual(["$1"])
  })

  test("extracts multiple numbered placeholders in sorted order", () => {
    expect(Command.hints("Compare $2 against $1")).toEqual(["$1", "$2"])
  })

  test("deduplicates repeated placeholders", () => {
    expect(Command.hints("Use $1 then reuse $1 again")).toEqual(["$1"])
  })

  test("extracts $ARGUMENTS placeholder", () => {
    expect(Command.hints("Execute with $ARGUMENTS")).toEqual(["$ARGUMENTS"])
  })

  test("extracts both numbered and $ARGUMENTS, numbered first", () => {
    expect(Command.hints("Run $1 with $ARGUMENTS")).toEqual(["$1", "$ARGUMENTS"])
  })

  test("handles multi-digit placeholders like $10 (numeric sort)", () => {
    const result = Command.hints("Lots of args: $1 $2 $10")
    expect(result).toEqual(["$1", "$2", "$10"])
  })

  test("returns empty for empty template string", () => {
    expect(Command.hints("")).toEqual([])
  })

  test("does not match $ followed by letters (not ARGUMENTS)", () => {
    expect(Command.hints("Use $FOO and $BAR")).toEqual([])
  })

  test("$ARGUMENTS is case-sensitive", () => {
    expect(Command.hints("Use $arguments")).toEqual([])
  })

  test("handles template with only whitespace", () => {
    expect(Command.hints("   \n\t  ")).toEqual([])
  })

  test("handles $0 as a valid numbered placeholder", () => {
    expect(Command.hints("$0 is first")).toEqual(["$0"])
  })
})
