import { describe, test, expect, mock } from "bun:test"
import { Rpc } from "../../src/util/rpc"

/**
 * Create a fake worker-like object that connects a Rpc.client to a Rpc.listen
 * server. The "server" side uses globalThis.onmessage/postMessage, and the
 * "client" side uses the returned target object.
 */
function createFakeWorker() {
  const target = {
    postMessage: (_data: string) => {},
    onmessage: null as ((ev: MessageEvent) => void) | null,
  }
  // When the client sends a message (via target.postMessage), route it to
  // the server's globalThis.onmessage handler.
  target.postMessage = (data: string) => {
    const handler = (globalThis as any).onmessage
    if (handler) handler({ data } as MessageEvent)
  }
  return target
}

describe("Rpc.client: request/response protocol", () => {
  test("call() sends request and resolves on response", async () => {
    const target = {
      postMessage: mock((_data: string) => {}),
      onmessage: null as ((ev: MessageEvent) => void) | null,
    }

    const client = Rpc.client(target)
    const promise = client.call("greet", { name: "world" })

    // Verify the client sent a properly formatted request
    expect(target.postMessage).toHaveBeenCalledTimes(1)
    const sent = JSON.parse((target.postMessage as any).mock.calls[0][0])
    expect(sent.type).toBe("rpc.request")
    expect(sent.method).toBe("greet")
    expect(sent.input).toEqual({ name: "world" })
    expect(typeof sent.id).toBe("number")

    // Simulate the server responding
    target.onmessage!({
      data: JSON.stringify({ type: "rpc.result", result: "Hello, world!", id: sent.id }),
    } as MessageEvent)

    const result = await promise
    expect(result).toBe("Hello, world!")
  })

  test("call() handles multiple concurrent calls with independent IDs", async () => {
    const target = {
      postMessage: mock((_data: string) => {}),
      onmessage: null as ((ev: MessageEvent) => void) | null,
    }

    const client = Rpc.client(target)
    const p1 = client.call("add", { a: 1, b: 2 })
    const p2 = client.call("multiply", { a: 3, b: 4 })

    // Extract IDs from the two calls
    const call1 = JSON.parse((target.postMessage as any).mock.calls[0][0])
    const call2 = JSON.parse((target.postMessage as any).mock.calls[1][0])
    expect(call1.id).not.toBe(call2.id)

    // Respond out of order — second call first
    target.onmessage!({
      data: JSON.stringify({ type: "rpc.result", result: 12, id: call2.id }),
    } as MessageEvent)
    target.onmessage!({
      data: JSON.stringify({ type: "rpc.result", result: 3, id: call1.id }),
    } as MessageEvent)

    expect(await p1).toBe(3)
    expect(await p2).toBe(12)
  })
})

describe("Rpc.client: event subscription", () => {
  test("on() receives events", async () => {
    const target = {
      postMessage: (_data: string) => {},
      onmessage: null as ((ev: MessageEvent) => void) | null,
    }

    const client = Rpc.client(target)
    const received: unknown[] = []
    client.on("progress", (data) => received.push(data))

    // Simulate server emitting an event
    target.onmessage!({
      data: JSON.stringify({ type: "rpc.event", event: "progress", data: { percent: 50 } }),
    } as MessageEvent)
    target.onmessage!({
      data: JSON.stringify({ type: "rpc.event", event: "progress", data: { percent: 100 } }),
    } as MessageEvent)

    expect(received).toEqual([{ percent: 50 }, { percent: 100 }])
  })

  test("on() unsubscribe stops delivery", () => {
    const target = {
      postMessage: (_data: string) => {},
      onmessage: null as ((ev: MessageEvent) => void) | null,
    }

    const client = Rpc.client(target)
    const received: unknown[] = []
    const unsubscribe = client.on("status", (data) => received.push(data))

    // First event — should be delivered
    target.onmessage!({
      data: JSON.stringify({ type: "rpc.event", event: "status", data: "active" }),
    } as MessageEvent)

    unsubscribe()

    // Second event — should NOT be delivered
    target.onmessage!({
      data: JSON.stringify({ type: "rpc.event", event: "status", data: "idle" }),
    } as MessageEvent)

    expect(received).toEqual(["active"])
  })
})

describe("Rpc.listen: server-side dispatch", () => {
  test("dispatches request to handler and posts result", async () => {
    // Save and restore globals to avoid polluting other tests
    const origOnMessage = (globalThis as any).onmessage
    const origPostMessage = (globalThis as any).postMessage

    try {
      const posted: string[] = []
      ;(globalThis as any).postMessage = (data: string) => posted.push(data)

      Rpc.listen({
        greet: async (input: { name: string }) => `Hello, ${input.name}!`,
      })

      // Invoke the handler directly
      const handler = (globalThis as any).onmessage
      expect(handler).toBeDefined()

      await handler({
        data: JSON.stringify({ type: "rpc.request", method: "greet", input: { name: "Alice" }, id: 42 }),
      })

      expect(posted.length).toBe(1)
      const response = JSON.parse(posted[0])
      expect(response.type).toBe("rpc.result")
      expect(response.result).toBe("Hello, Alice!")
      expect(response.id).toBe(42)
    } finally {
      ;(globalThis as any).onmessage = origOnMessage
      ;(globalThis as any).postMessage = origPostMessage
    }
  })
})
