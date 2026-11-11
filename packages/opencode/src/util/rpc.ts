// altimate_change start — upstream_fix: answer a failed RPC request instead of hanging the caller (anomalyco/opencode#54936)
import { errorMessage } from "@/util/error"
// altimate_change end

type Definition = {
  [method: string]: (input: any) => any
}

export function listen(rpc: Definition) {
  onmessage = async (evt) => {
    const parsed = JSON.parse(evt.data)
    // altimate_change start — upstream_fix: answer a failed RPC request instead of hanging the caller (anomalyco/opencode#54936)
    if (parsed.type !== "rpc.request") return
    // A request that throws must still be answered, or its caller waits forever.
    const reply = await Promise.resolve()
      .then(() => rpc[parsed.method](parsed.input))
      .then((result) => JSON.stringify({ type: "rpc.result", result, id: parsed.id }))
      .catch((error) => JSON.stringify({ type: "rpc.result", error: failureMessage(error), id: parsed.id }))
    postMessage(reply)
    // altimate_change end
  }
}

// altimate_change start — upstream_fix: answer a failed RPC request instead of hanging the caller (anomalyco/opencode#54936)
// Some failures keep their text on the cause: a taken --port rejects with an empty ServeError.
function failureMessage(error: unknown): string {
  if (error instanceof Error && !error.message && error.cause) return failureMessage(error.cause)
  return errorMessage(error)
}
// altimate_change end

export function emit(event: string, data: unknown) {
  postMessage(JSON.stringify({ type: "rpc.event", event, data }))
}

export function client<T extends Definition>(target: {
  postMessage: (data: string) => void | null
  onmessage: ((this: Worker, ev: MessageEvent<any>) => any) | null
}) {
  // altimate_change start — upstream_fix: answer a failed RPC request instead of hanging the caller (anomalyco/opencode#54936)
  const pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>()
  // altimate_change end
  const listeners = new Map<string, Set<(data: any) => void>>()
  let id = 0
  target.onmessage = async (evt) => {
    const parsed = JSON.parse(evt.data)
    if (parsed.type === "rpc.result") {
      // altimate_change start — upstream_fix: answer a failed RPC request instead of hanging the caller (anomalyco/opencode#54936)
      const request = pending.get(parsed.id)
      if (!request) return
      pending.delete(parsed.id)
      if (typeof parsed.error === "string") return request.reject(new Error(parsed.error))
      return request.resolve(parsed.result)
      // altimate_change end
    }
    if (parsed.type === "rpc.event") {
      const handlers = listeners.get(parsed.event)
      if (handlers) {
        for (const handler of handlers) {
          handler(parsed.data)
        }
      }
    }
  }
  return {
    call<Method extends keyof T>(method: Method, input: Parameters<T[Method]>[0]): Promise<ReturnType<T[Method]>> {
      const requestId = id++
      // altimate_change start — upstream_fix: answer a failed RPC request instead of hanging the caller (anomalyco/opencode#54936)
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject })
      // altimate_change end
        target.postMessage(JSON.stringify({ type: "rpc.request", method, input, id: requestId }))
      })
    },
    on<Data>(event: string, handler: (data: Data) => void) {
      let handlers = listeners.get(event)
      if (!handlers) {
        handlers = new Set()
        listeners.set(event, handlers)
      }
      handlers.add(handler)
      return () => {
        handlers!.delete(handler)
      }
    },
  }
}

export * as Rpc from "./rpc"
