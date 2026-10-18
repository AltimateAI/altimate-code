// altimate_change - new file
import { describe, expect, test } from "bun:test"
import { unsentMemoryNotice } from "../../../src/altimate/cli/unsent-memory"

describe("unsentMemoryNotice", () => {
  test("says nothing when every memory reached the workspace", () => {
    expect(unsentMemoryNotice(0)).toBeNull()
  })

  test("counts what is pending and points at workspace sync", () => {
    expect(unsentMemoryNotice(1)).toBe(
      "1 memory saved here is not in the workspace yet. Run `altimate-code workspace sync` to send it.",
    )
    expect(unsentMemoryNotice(3)).toBe(
      "3 memories saved here are not in the workspace yet. Run `altimate-code workspace sync` to send them.",
    )
  })

  test("an unknown count is reported as unknown, never as zero", () => {
    expect(unsentMemoryNotice(null)).toContain("workspace status")
  })
})
