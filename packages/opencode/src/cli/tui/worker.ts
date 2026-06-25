import { Server } from "@/server/server"
import { InstanceRuntime } from "@/project/instance-runtime"
import { Rpc } from "@/util/rpc"
import { upgrade } from "@/cli/upgrade"
import { Config } from "@/config/config"
import { GlobalBus } from "@/bus/global"
import { ServerAuth } from "@/server/auth"
import { writeHeapSnapshot } from "node:v8"
import { Heap } from "@/cli/heap"
import { AppRuntime } from "@/effect/app-runtime"
import { Effect } from "effect"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
// altimate_change start — trace: re-home TUI session tracing dropped in the v1.17.9 worker rewrite.
// The pre-merge cli/cmd/tui/worker.ts fed bus events to a TraceConsumer; the extracted worker lost it,
// so interactive TUI sessions stopped writing trace files (run/serve still traced). We feed the
// worker's GlobalBus stream (the same events the TUI renders) into the shared TraceConsumer that
// carries the fork trace fixes (PR #867/#895). subscribeTraceConsumer's own SDK /event subscription
// does NOT receive this worker's in-process (Server.Default().fetch) session events.
import { TraceConsumer } from "@/altimate/observability/trace-consumer"
import { Instance } from "@/project/instance"

Heap.start()

const traceConsumer = new TraceConsumer()
// loadConfig() must complete before the first event: getOrCreateTrace caches, per session, a Trace
// whose snapshot dir comes from loadConfig's FileExporter — an event handled before it finishes caches
// a trace that never persists. So the event chain starts with this promise. loadConfig reads
// Config.get() (a facade needing an Instance on the canonical ALS the bare worker lacks at init), so
// load the project instance for the worker's cwd first; best-effort fallback otherwise.
const traceReady: Promise<void> = (async () => {
  try {
    const ctx = await InstanceRuntime.load({ directory: process.cwd() })
    await Instance.restore(ctx, () => traceConsumer.loadConfig())
  } catch {
    await traceConsumer.loadConfig().catch(() => {})
  }
})()
// Serialize handleEvent (the consumer expects a serial stream; serve consumes the SDK /event iterator
// one at a time). Each link awaits the previous; the first awaits traceReady.
let traceTail: Promise<void> = traceReady.catch(() => {})
// altimate_change end

// Subscribe to global events and forward them via RPC
GlobalBus.on("event", (event) => {
  Rpc.emit("global.event", event)
  // altimate_change start — trace: feed bus events to the per-session trace consumer, serialized.
  traceTail = traceTail.then(() => traceConsumer.handleEvent(event.payload)).catch(() => {})
  // altimate_change end
})

let server: Awaited<ReturnType<typeof Server.listen>> | undefined

export const rpc = {
  async fetch(input: { url: string; method: string; headers: Record<string, string>; body?: string }) {
    const headers = { ...input.headers }
    const auth = ServerAuth.header()
    if (auth && !headers["authorization"] && !headers["Authorization"]) {
      headers["Authorization"] = auth
    }
    const request = new Request(input.url, {
      method: input.method,
      headers,
      body: input.body,
    })
    // altimate_change start — upstream_fix: Server.Default exposes fetch directly
    const response = await Server.Default().fetch(request)
    // altimate_change end
    const body = await response.text()
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    }
  },
  snapshot() {
    const result = writeHeapSnapshot("server.heapsnapshot")
    return result
  },
  async server(input: { port: number; hostname: string; mdns?: boolean; cors?: string[] }) {
    if (server) await server.stop(true)
    server = await Server.listen(input)
    return { url: server.url.toString() }
  },
  async checkUpgrade(input: { directory: string }) {
    await InstanceRuntime.load({ directory: input.directory })
    await upgrade().catch(() => {})
  },
  async reload() {
    await AppRuntime.runPromise(
      Effect.gen(function* () {
        const cfg = yield* Config.Service
        yield* cfg.invalidate()
        yield* disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true })
      }),
    )
  },
  async shutdown() {
    // altimate_change start — trace: drain pending events (bounded), then finalize SYNCHRONOUSLY.
    // On a quiet Bun Worker thread, pending async fs writes from the consumer don't flush before
    // worker.terminate(), so an async flush() silently writes nothing; flushSync() uses writeFileSync.
    await Promise.race([traceTail, new Promise((r) => setTimeout(r, 2000))]).catch(() => {})
    traceConsumer.flushSync()
    // altimate_change end
    await InstanceRuntime.disposeAllInstances()
    if (server) await server.stop(true)
  },
}

Rpc.listen(rpc)
