// altimate_change start — upstream_fix: background task records are bounded across parent sessions.
import { describe, expect, test } from "bun:test"
import * as Task from "../../src/tool/task"

type Records = Map<string, { parentSessionID: string; settled: boolean }>

describe("tool.task background records", () => {
  test("settled records stay within one bound across all parent sessions", () => {
    const evict = Task.evictBackgroundRecords as (records: Records, parentSessionID: string) => void
    const total = Task.MAX_BACKGROUND_RECORDS_TOTAL as number
    expect(typeof evict).toBe("function")
    expect(total).toBeGreaterThan(0)
    const records: Records = new Map()
    // Many parents, each well under its own cap: only the global bound can limit them.
    for (let index = 0; index < total + 10; index++) {
      records.set(`ses_${index}`, { parentSessionID: `parent_${index % 50}`, settled: true })
    }
    records.set("ses_running", { parentSessionID: "parent_0", settled: false })
    evict(records, "parent_0")
    expect(records.size).toBe(total)
    // The oldest settled records go first; a running child is never dropped.
    expect(records.has("ses_0")).toBe(false)
    expect(records.has(`ses_${total + 9}`)).toBe(true)
    expect(records.has("ses_running")).toBe(true)
  })
})
// altimate_change end
