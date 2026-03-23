import { describe, test, expect, afterEach } from "bun:test"
import { Rpc } from "../../src/util/rpc"

describe("Rpc: client protocol", () => {
  test("single call returns correct result via mock channel", async () => {
    // Create a target that simulates a server: when a request arrives,
    // compute the result and send it back through onmessage.
    const target: any = {
      onmessage: null,
      postMessage: (data: string) => {
        const parsed = JSON.parse(data)
        if (parsed.type === "rpc.request" && parsed.method === "add") {
          const result = parsed.input.a + parsed.input.b
          // Respond asynchronously (microtask) to mirror real Worker timing
          Promise.resolve().then(() => {
            target.onmessage!({
              data: JSON.stringify({ type: "rpc.result", result, id: parsed.id }),
            } as MessageEvent)
          })
        }
      },
    }

    const rpc = Rpc.client<{ add: (input: { a: number; b: number }) => number }>(target)
    const result = await rpc.call("add", { a: 3, b: 4 })
    expect(result).toBe(7)
  })

  test("concurrent calls resolve to their own results (synchronous out-of-order)", async () => {
    // Accumulate requests and respond in reverse order synchronously
    const pending: Array<{ method: string; input: any; id: number }> = []
    const target: any = {
      onmessage: null,
      postMessage: (data: string) => {
        const parsed = JSON.parse(data)
        if (parsed.type === "rpc.request") {
          pending.push({ method: parsed.method, input: parsed.input, id: parsed.id })
          // After both requests arrive, respond in reverse order
          if (pending.length === 2) {
            // Second request resolves first, then first — no timers
            for (const req of [...pending].reverse()) {
              target.onmessage!({
                data: JSON.stringify({ type: "rpc.result", result: req.input, id: req.id }),
              } as MessageEvent)
            }
          }
        }
      },
    }

    const rpc = Rpc.client<{ echo: (input: string) => string }>(target)
    const [r1, r2] = await Promise.all([rpc.call("echo", "first"), rpc.call("echo", "second")])
    expect(r1).toBe("first")
    expect(r2).toBe("second")
  })

  test("event subscription delivers data and unsubscribe works", () => {
    const target: any = { onmessage: null, postMessage: () => {} }
    const rpc = Rpc.client(target)

    const received: string[] = []
    const unsub = rpc.on<string>("status", (data) => received.push(data))

    // Simulate two events
    target.onmessage!({ data: JSON.stringify({ type: "rpc.event", event: "status", data: "ok" }) } as MessageEvent)
    target.onmessage!({ data: JSON.stringify({ type: "rpc.event", event: "status", data: "done" }) } as MessageEvent)

    expect(received).toEqual(["ok", "done"])

    // Unsubscribe and send another event — should be ignored
    unsub()
    target.onmessage!({
      data: JSON.stringify({ type: "rpc.event", event: "status", data: "ignored" }),
    } as MessageEvent)
    expect(received).toEqual(["ok", "done"])
  })

  test("unmatched result id is silently ignored", () => {
    const target: any = { onmessage: null, postMessage: () => {} }
    Rpc.client(target)

    // Stale/duplicate result IDs must not throw
    expect(() => {
      target.onmessage!({
        data: JSON.stringify({ type: "rpc.result", result: "stale", id: 99999 }),
      } as MessageEvent)
    }).not.toThrow()
  })

  test("multiple event listeners on the same event", () => {
    const target: any = { onmessage: null, postMessage: () => {} }
    const rpc = Rpc.client(target)

    const a: number[] = []
    const b: number[] = []
    rpc.on<number>("tick", (v) => a.push(v))
    const unsub = rpc.on<number>("tick", (v) => b.push(v))

    target.onmessage!({ data: JSON.stringify({ type: "rpc.event", event: "tick", data: 1 }) } as MessageEvent)
    unsub()
    target.onmessage!({ data: JSON.stringify({ type: "rpc.event", event: "tick", data: 2 }) } as MessageEvent)

    expect(a).toEqual([1, 2])
    expect(b).toEqual([1])
  })
})
