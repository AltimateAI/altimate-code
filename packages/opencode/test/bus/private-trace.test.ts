// altimate_change start — private request snapshots cannot reach wildcard/global SSE subscribers
import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Bus } from "../../src/bus"
import { BusEvent } from "../../src/bus/bus-event"
import { GlobalBus } from "../../src/bus/global"
import { Instance } from "../../src/project/instance"
import { MessageV2 } from "../../src/session/message-v2"
import { TraceConsumer } from "../../src/altimate/observability/trace-consumer"
import { FileExporter, LLMRequestEvent, type TraceFile } from "../../src/altimate/observability/tracing"
import { tmpdir } from "../fixture/fixture"

afterEach(() => Instance.disposeAll())

test("request snapshots reach only the typed trace subscription", async () => {
  await using directory = await tmpdir({ git: true })
  await Instance.provide({
    directory: directory.path,
    fn: async () => {
      const snapshot = {
        requestID: "request_private",
        sessionID: "ses_private",
        messageID: "msg_private",
        userMessageID: "msg_user",
        agent: "analyst",
        providerID: "test",
        modelID: "test",
        startTime: 1,
        system: "hidden system instructions",
        tools: [],
      }
      await Bus.publish(LLMRequestEvent, snapshot)
      const publicEvents: unknown[] = []
      const privateEvents: unknown[] = []
      const globalEvents: unknown[] = []
      const global = (event: unknown) => globalEvents.push(event)
      GlobalBus.on("event", global)
      const unsubscribeAll = Bus.subscribeAll((event) => publicEvents.push(event))
      const unsubscribeTrace = Bus.subscribe(LLMRequestEvent, (event) => privateEvents.push(event))
      try {
        await Bus.publish(LLMRequestEvent, snapshot)
        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(privateEvents).toHaveLength(1)
        expect(publicEvents).toEqual([])
        expect(globalEvents).toEqual([])
        expect(BusEvent.payloads().safeParse({ type: LLMRequestEvent.type, properties: snapshot }).success).toBe(false)
      } finally {
        unsubscribeAll()
        unsubscribeTrace()
        GlobalBus.off("event", global)
      }
    },
  })
})

test("public tool events keep live trace snapshots current while request snapshots stay private", async () => {
  await using directory = await tmpdir({ git: true })
  const sessionID = "ses_live_private"
  const tracesDir = path.join(directory.path, "traces")
  const consumer = new TraceConsumer({ exporters: [new FileExporter(tracesDir)] })

  // Observe the same file that /api/trace reads, without finalizing the trace
  // or assuming that the asynchronous snapshot finishes within a fixed delay.
  async function waitForSpans(count: number) {
    const deadline = performance.now() + 4_000
    while (performance.now() < deadline) {
      const trace = await fs
        .readFile(path.join(tracesDir, `${sessionID}.json`), "utf8")
        .then((text) => JSON.parse(text) as TraceFile)
        .catch(() => undefined)
      if (trace?.spans.filter((span) => span.kind === "tool").length === count) return trace
      await Bun.sleep(10)
    }
    throw new Error(`Live trace snapshot did not reach ${count} tool spans`)
  }

  await Instance.provide({
    directory: directory.path,
    fn: async () => {
      const publicEvents: unknown[] = []
      const privateEvents: unknown[] = []
      const globalEvents: unknown[] = []
      const global = (event: unknown) => globalEvents.push(event)
      GlobalBus.on("event", global)
      const unsubscribeAll = Bus.subscribeAll(async (event) => {
        publicEvents.push(event)
        await consumer.handleEvent(event)
      })
      let requestDelivered!: () => void
      const privateDelivery = new Promise<void>((resolve) => {
        requestDelivered = resolve
      })
      const unsubscribeTrace = Bus.subscribe(LLMRequestEvent, (event) => {
        privateEvents.push(event)
        requestDelivered()
      })
      const publishTool = (index: number, tool: string) =>
        Bus.publish(
          MessageV2.Event.PartUpdated,
          MessageV2.Event.PartUpdated.properties.parse({
            sessionID,
            time: index,
            part: {
              id: `prt_live_${index}`,
              sessionID,
              messageID: "msg_live",
              type: "tool",
              callID: `call_live_${index}`,
              tool,
              state: {
                status: "completed",
                input: {},
                output: "ok",
                title: tool,
                metadata: {},
                time: { start: index, end: index + 1 },
              },
            },
          }),
        )
      try {
        await publishTool(1, "bash")
        const first = await waitForSpans(1)
        expect(first.spans.find((span) => span.kind === "session")?.endTime).toBeUndefined()

        await Bus.publish(LLMRequestEvent, {
          requestID: "request_live_private",
          sessionID,
          messageID: "msg_live",
          userMessageID: "msg_user",
          agent: "analyst",
          providerID: "test",
          modelID: "test",
          startTime: 1,
          system: "hidden live system instructions",
          tools: [],
        })
        await privateDelivery
        await publishTool(2, "read")
        const updated = await waitForSpans(2)
        expect(updated.spans.find((span) => span.kind === "session")?.endTime).toBeUndefined()
        expect(updated.spans.filter((span) => span.kind === "tool").map((span) => span.name)).toEqual(["bash", "read"])
        expect(privateEvents).toHaveLength(1)
        expect(JSON.stringify(privateEvents)).toContain("hidden live system instructions")
        for (const events of [publicEvents, globalEvents]) {
          expect(JSON.stringify(events)).not.toContain("llm.request")
          expect(JSON.stringify(events)).not.toContain("hidden live system instructions")
        }
      } finally {
        unsubscribeAll()
        unsubscribeTrace()
        GlobalBus.off("event", global)
        await consumer.flush()
      }
    },
  })
})
// altimate_change end
