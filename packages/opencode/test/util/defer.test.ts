import { describe, test, expect } from "bun:test"
import { defer } from "../../src/util/defer"

describe("defer: disposal pattern", () => {
  test("Symbol.dispose invokes the cleanup function", () => {
    let called = false
    const d = defer(() => {
      called = true
    })
    expect(called).toBe(false)
    d[Symbol.dispose]()
    expect(called).toBe(true)
  })

  test("Symbol.asyncDispose invokes the cleanup function and returns a Promise", async () => {
    let called = false
    const d = defer(() => {
      called = true
    })
    const result = d[Symbol.asyncDispose]()
    expect(result).toBeInstanceOf(Promise)
    await result
    expect(called).toBe(true)
  })

  test("works with async cleanup functions via asyncDispose", async () => {
    let called = false
    const d = defer(async () => {
      called = true
    })
    await d[Symbol.asyncDispose]()
    expect(called).toBe(true)
  })

  test("using syntax triggers dispose", () => {
    let called = false
    {
      using _d = defer(() => {
        called = true
      })
      expect(called).toBe(false)
    }
    expect(called).toBe(true)
  })
})
