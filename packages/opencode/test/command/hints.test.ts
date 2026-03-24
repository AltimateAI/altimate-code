import { describe, test, expect } from "bun:test"
import { Command } from "../../src/command/index"

describe("Command.hints: template placeholder extraction", () => {
  test("returns empty array for template with no placeholders", () => {
    expect(Command.hints("Run the tests and report results")).toEqual([])
    expect(Command.hints("")).toEqual([])
  })

  test("extracts numbered placeholders in sorted order", () => {
    expect(Command.hints("Review $2 and compare with $1")).toEqual(["$1", "$2"])
  })

  test("deduplicates repeated placeholder occurrences", () => {
    expect(Command.hints("Use $1 then use $1 again and $2")).toEqual(["$1", "$2"])
  })

  test("appends $ARGUMENTS when present", () => {
    expect(Command.hints("Do something with $ARGUMENTS")).toEqual(["$ARGUMENTS"])
  })

  test("multi-digit placeholders sort lexicographically", () => {
    // $10 sorts before $2 in lexicographic order — this is the actual behavior
    // since the code uses [...new Set(numbered)].sort() which is string sort
    const result = Command.hints("Map $1 to $2 and also $10")
    expect(result).toEqual(["$1", "$10", "$2"])
  })
})
