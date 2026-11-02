import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { MemoryStore } from "../../src/memory"
import { TrainingStore } from "../../src/altimate/training"

describe("TrainingStore.save", () => {
  const spies: Array<ReturnType<typeof spyOn>> = []
  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore()
  })

  test("passes the writing session to the memory write, for the workspace write-back's row", async () => {
    spies.push(spyOn(MemoryStore, "read").mockResolvedValue(undefined as any))
    const write = spyOn(MemoryStore, "write").mockResolvedValue({ duplicates: [] })
    spies.push(write)
    await TrainingStore.save({
      kind: "rule",
      name: "naming",
      scope: "project",
      content: "Use snake_case.",
      sessionID: "s-7",
    })
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0][1]).toEqual({ sessionID: "s-7" })
  })
})
