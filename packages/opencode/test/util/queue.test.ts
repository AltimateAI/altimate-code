import { describe, test, expect } from "bun:test"
import { AsyncQueue, work } from "../../src/util/queue"

describe("AsyncQueue", () => {
  test("push before next resolves immediately", async () => {
    const q = new AsyncQueue<number>()
    q.push(1)
    q.push(2)
    const a = await q.next()
    const b = await q.next()
    expect(a).toBe(1)
    expect(b).toBe(2)
  })

  test("next before push waits for value", async () => {
    const q = new AsyncQueue<string>()
    const promise = q.next()
    q.push("hello")
    expect(await promise).toBe("hello")
  })

  test("multiple waiters resolve in order", async () => {
    const q = new AsyncQueue<number>()
    const p1 = q.next()
    const p2 = q.next()
    q.push(10)
    q.push(20)
    expect(await p1).toBe(10)
    expect(await p2).toBe(20)
  })

  test("async iterator yields pushed values", async () => {
    const q = new AsyncQueue<number>()
    const collected: number[] = []

    q.push(1)
    q.push(2)
    q.push(3)

    let count = 0
    for await (const val of q) {
      collected.push(val)
      count++
      if (count === 3) break
    }
    expect(collected).toEqual([1, 2, 3])
  })

  test("interleaved push and next", async () => {
    const q = new AsyncQueue<number>()
    q.push(1)
    expect(await q.next()).toBe(1)
    const p = q.next() // waiting
    q.push(2)
    expect(await p).toBe(2)
    q.push(3)
    q.push(4)
    expect(await q.next()).toBe(3)
    expect(await q.next()).toBe(4)
  })
})

describe("work", () => {
  test("processes all items", async () => {
    const results: number[] = []
    await work(2, [1, 2, 3, 4, 5], async (item) => {
      results.push(item)
    })
    expect(results.sort()).toEqual([1, 2, 3, 4, 5])
  })

  test("respects concurrency limit", async () => {
    let active = 0
    let maxActive = 0
    await work(2, [1, 2, 3, 4, 5], async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await Bun.sleep(10)
      active--
    })
    expect(maxActive).toBeLessThanOrEqual(2)
  })

  test("handles empty items array", async () => {
    let called = false
    await work(3, [], async () => {
      called = true
    })
    expect(called).toBe(false)
  })

  test("concurrency of 1 processes sequentially (LIFO due to pop)", async () => {
    const order: number[] = []
    await work(1, [1, 2, 3], async (item) => {
      order.push(item)
    })
    // work() uses pending.pop(), so items are processed in reverse order
    expect(order).toEqual([3, 2, 1])
  })

  test("propagates errors from worker", async () => {
    await expect(
      work(2, [1, 2, 3], async (item) => {
        if (item === 2) throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
  })
})
