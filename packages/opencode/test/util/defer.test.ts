import { describe, test, expect } from "bun:test"
import { defer } from "../../src/util/defer"

describe("defer", () => {
  test("Symbol.dispose calls the cleanup function", () => {
    let called = false
    const d = defer(() => {
      called = true
    })
    d[Symbol.dispose]()
    expect(called).toBe(true)
  })

  test("Symbol.asyncDispose calls and awaits the cleanup function", async () => {
    let called = false
    const d = defer(async () => {
      called = true
    })
    await d[Symbol.asyncDispose]()
    expect(called).toBe(true)
  })

  test("works with using statement for sync cleanup", () => {
    let cleaned = false
    {
      using _ = defer(() => {
        cleaned = true
      })
    }
    expect(cleaned).toBe(true)
  })

  test("works with await using statement for async cleanup", async () => {
    let cleaned = false
    {
      await using _ = defer(async () => {
        cleaned = true
      })
    }
    expect(cleaned).toBe(true)
  })
})
