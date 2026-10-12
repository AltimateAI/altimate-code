import { describe, expect, test } from "bun:test"
import { RunTracing } from "@/cli/cmd/run-tracing"
import {
  FileExporter,
  Trace,
  type LLMRequestSnapshot,
  type TraceExporter,
  type TraceFile,
} from "@/altimate/observability/tracing"
import { tmpdir } from "../../fixture/fixture"
import path from "node:path"

type Info = { id: string; parentID?: string }

function fixture(infos: Info[] = []) {
  const files = new Map<string, TraceFile>()
  const exporter: TraceExporter = {
    name: "memory",
    async export(trace) {
      files.set(trace.sessionId, structuredClone(trace))
      return undefined
    },
  }
  const known = new Map(infos.map((info) => [info.id, info]))
  const root = Trace.withExporters([exporter])
  root.startTrace("ses_root", { prompt: "Inspect the project." })
  const router = new RunTracing("ses_root", root, {
    get: async (id) => known.get(id),
    children: async (id) => [...known.values()].filter((info) => info.parentID === id),
  })
  return { files, known, root, router }
}

function created(id: string, parentID?: string) {
  return { type: "session.created", properties: { info: { id, parentID } } }
}

function assistant(sessionID: string, messageID: string) {
  return {
    type: "message.updated",
    properties: {
      info: {
        id: messageID,
        sessionID,
        role: "assistant",
        modelID: `model-${sessionID}`,
        providerID: "test",
        agent: "general",
        variant: "high",
      },
    },
  }
}

function part(sessionID: string, messageID: string, id: string, value: Record<string, unknown>) {
  return { type: "message.part.updated", properties: { part: { sessionID, messageID, id, ...value } } }
}

function start(sessionID: string, messageID: string) {
  return part(sessionID, messageID, `prt_start_${messageID}`, { type: "step-start" })
}

function finish(sessionID: string, messageID: string, input = 1, output = 2) {
  return part(sessionID, messageID, `prt_finish_${messageID}`, {
    type: "step-finish",
    reason: "stop",
    cost: 0,
    tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } },
  })
}

function text(sessionID: string, messageID: string, value: string) {
  return part(sessionID, messageID, `prt_text_${messageID}`, { type: "text", text: value, time: { start: 1, end: 2 } })
}

function tool(sessionID: string, messageID: string, callID: string, name = "read", metadata = {}, input = {}) {
  return part(sessionID, messageID, `prt_${callID}`, {
    type: "tool",
    tool: name,
    callID,
    state: { status: "completed", input, output: `${name} result`, metadata, time: { start: 1, end: 2 } },
  })
}

function request(sessionID: string, requestID = "request-first") {
  const properties: LLMRequestSnapshot = {
    requestID,
    sessionID,
    messageID: `msg_${sessionID}`,
    userMessageID: `user_${sessionID}`,
    agent: sessionID === "ses_root" ? "analyst" : "data-explorer",
    providerID: "test",
    modelID: "test-model",
    variant: "high",
    startTime: 1000,
    system: "Effective system",
    instructions: "Provider instructions",
    tools: [{ name: "read", active: true, inputSchema: { type: "object" } }],
  }
  return { type: "llm.request", properties }
}

async function feed(router: RunTracing, events: unknown[]) {
  for (const event of events) await router.observe(event)
}

function manifest(files: Map<string, TraceFile>) {
  return files.get("ses_root")!.metadata.run!.sessions!
}

function assertGeneration(
  trace: TraceFile,
  messageID: string,
  expected: { output: string; tools: number; tokens: number },
) {
  const generations = trace.spans.filter((span) => span.kind === "generation")
  expect(generations).toHaveLength(1)
  expect(generations[0]!.attributes).toEqual({ sessionId: trace.sessionId, messageId: messageID })
  expect(generations[0]!.output).toBe(expected.output)
  expect(trace.summary.totalGenerations).toBe(1)
  expect(trace.summary.totalTokens).toBe(expected.tokens)
  expect(trace.summary.totalToolCalls).toBe(expected.tools)
  const tools = trace.spans.filter((span) => span.kind === "tool")
  expect(tools).toHaveLength(expected.tools)
  for (const span of tools) {
    expect(span.parentSpanId).toBe(generations[0]!.spanId)
    expect(span.attributes).toEqual({ sessionId: trace.sessionId, messageId: messageID })
  }
}

describe("run trace session routing", () => {
  test("user and synthetic attachment prompt spans use the 4000-character cap", async () => {
    const { router, files } = fixture()
    const prompt = "x".repeat(10_000)
    await router.observe({ type: "message.updated", properties: {
      info: { id: "msg_user", sessionID: "ses_root", role: "user" },
    } })
    for (const synthetic of [false, true]) {
      await router.observe(part("ses_root", "msg_user", `prt_user_${synthetic}`, {
        type: "text", text: prompt, synthetic,
      }))
    }
    await router.finish()
    const spans = files.get("ses_root")!.spans.filter((span) => ["user-prompt", "synthetic-prompt"].includes(span.name))
    expect(spans).toHaveLength(2)
    for (const span of spans) expect(span.input).toBe(prompt.slice(0, 4000))
  })

  for (const source of ["message.updated", "session.error"]) {
    test(`${source} bounds API error bodies and omits response headers`, async () => {
      const { router, files } = fixture()
      await router.observe(created("ses_failed", "ses_root"))
      const error = { name: "APIError", data: {
        message: "provider failed", statusCode: 503, isRetryable: true,
        responseHeaders: { "x-private-header": "private-header-value" },
        responseBody: "body-prefix:" + "b".repeat(100_000) + ":body-tail",
      } }
      await router.observe(source === "session.error"
        ? { type: source, properties: { sessionID: "ses_failed", error } }
        : { type: source, properties: { info: {
          ...assistant("ses_failed", "msg_failed").properties.info, error,
        } } })
      await router.finish()
      const serialized = files.get("ses_failed")!.summary.error!
      expect(serialized.length).toBeLessThanOrEqual(4000)
      expect(serialized).toContain("provider failed")
      expect(serialized).toContain("503")
      expect(serialized).not.toContain("private-header-value")
      expect(serialized).not.toContain("responseHeaders")
      expect(serialized).not.toContain(":body-tail")
    })
  }

  test("request snapshots route interleaved and early child events once after verified ancestry", async () => {
    const { router, files } = fixture([{ id: "ses_outside" }])
    const early = request("ses_early")
    await feed(router, [
      early,
      early,
      request("ses_outside"),
      request("ses_root"),
      created("ses_other", "ses_root"),
      request("ses_other"),
      created("ses_early", "ses_root"),
      request("ses_root", "request-second"),
      early,
      created("ses_without_request", "ses_root"),
    ])
    await router.finish()
    expect([...files.keys()].sort()).toEqual(["ses_early", "ses_other", "ses_root", "ses_without_request"])
    for (const id of ["ses_root", "ses_early", "ses_other"]) {
      const file = files.get(id)!
      const spans = file.spans.filter((span) => span.name === "llm-request")
      expect(spans).toHaveLength(id === "ses_root" ? 2 : 1)
      expect(spans[0].attributes).toMatchObject({
        sessionId: id,
        messageId: `msg_${id}`,
        userMessageId: `user_${id}`,
        agent: id === "ses_root" ? "analyst" : "data-explorer",
        requestId: "request-first",
        captureBoundary: "before-streamText",
      })
      expect(spans[0].input).toEqual({
        system: { hash: expect.any(String), content: "Effective system" },
        tools: { hash: expect.any(String), content: request(id).properties.tools },
        instructions: { hash: expect.any(String), content: "Provider instructions" },
      })
      if (id === "ses_root") {
        expect(spans[1].input).toEqual({
          system: { hash: expect.any(String) },
          tools: { hash: expect.any(String) },
          instructions: { hash: expect.any(String) },
        })
      }
      expect(file.metadata.captureOmissions).toHaveLength(1)
      expect(file.metadata.captureOmissions![0]).toStartWith("internal_custom_spans:")
    }
    const uncaptured = files.get("ses_without_request")!
    expect(uncaptured.spans.filter((span) => span.name === "llm-request")).toHaveLength(0)
    expect(uncaptured.metadata.captureOmissions).toHaveLength(3)
    expect(
      uncaptured.metadata.captureOmissions!.some((omission) => omission.startsWith("effective_system_prompt:")),
    ).toBe(true)
    expect(
      uncaptured.metadata.captureOmissions!.some((omission) => omission.startsWith("resolved_tool_catalog:")),
    ).toBe(true)
  })

  test("two interleaving children and a grandchild keep independent lineage, generations, tools, and reasoning", async () => {
    const { router, files } = fixture()
    await feed(router, [
      created("ses_a", "ses_root"),
      created("ses_b", "ses_root"),
      created("ses_grandchild", "ses_a"),
      assistant("ses_root", "msg_root"),
      start("ses_root", "msg_root"),
      assistant("ses_a", "msg_a"),
      start("ses_a", "msg_a"),
      assistant("ses_b", "msg_b"),
      start("ses_b", "msg_b"),
      tool("ses_a", "msg_a", "call_a"),
      assistant("ses_grandchild", "msg_grandchild"),
      start("ses_grandchild", "msg_grandchild"),
      tool("ses_b", "msg_b", "call_b"),
      part("ses_a", "msg_a", "prt_reason_a", {
        type: "reasoning",
        text: "Compare the observed records.",
        time: { start: 1, end: 2 },
      }),
      text("ses_b", "msg_b", "Child B answer"),
      tool("ses_grandchild", "msg_grandchild", "call_grandchild"),
      text("ses_a", "msg_a", "Child A answer"),
      text("ses_grandchild", "msg_grandchild", "Grandchild answer"),
      finish("ses_b", "msg_b", 3, 4),
      finish("ses_a", "msg_a", 1, 2),
      finish("ses_grandchild", "msg_grandchild", 5, 6),
      text("ses_root", "msg_root", "Root answer"),
      finish("ses_root", "msg_root", 7, 8),
    ])
    await router.finish()
    expect([...files.keys()].sort()).toEqual(["ses_a", "ses_b", "ses_grandchild", "ses_root"])
    expect(
      manifest(files).map(({ sessionId, parentSessionId, traceId }) => ({ sessionId, parentSessionId, traceId })),
    ).toEqual([
      { sessionId: "ses_root", parentSessionId: undefined, traceId: files.get("ses_root")!.traceId },
      { sessionId: "ses_a", parentSessionId: "ses_root", traceId: files.get("ses_a")!.traceId },
      { sessionId: "ses_b", parentSessionId: "ses_root", traceId: files.get("ses_b")!.traceId },
      { sessionId: "ses_grandchild", parentSessionId: "ses_a", traceId: files.get("ses_grandchild")!.traceId },
    ])
    expect(new Set([...files.values()].map((trace) => trace.traceId)).size).toBe(4)
    for (const [id, parentID, messageID, output, tools, tokens] of [
      ["ses_root", undefined, "msg_root", "Root answer", 0, 15],
      ["ses_a", "ses_root", "msg_a", "Child A answer", 1, 3],
      ["ses_b", "ses_root", "msg_b", "Child B answer", 1, 7],
      ["ses_grandchild", "ses_a", "msg_grandchild", "Grandchild answer", 1, 11],
    ] as const) {
      const trace = files.get(id)!
      assertGeneration(trace, messageID, { output, tools, tokens })
      expect(trace.metadata.run!.rootSessionId).toBe("ses_root")
      expect(trace.metadata.run!.parentSessionId).toBe(parentID)
      expect(trace.metadata.model).toBe(`test/model-${id}`)
      const reasoning = trace.spans.filter((span) => span.name === "reasoning")
      expect(reasoning).toHaveLength(id === "ses_a" ? 1 : 0)
      if (id === "ses_a") {
        expect(reasoning[0]!.output).toBe("Compare the observed records.")
        expect(reasoning[0]!.parentSpanId).toBe(trace.spans.find((span) => span.kind === "generation")!.spanId)
      }
    }
  })

  test("seed recursively records resumed descendants before their next creation event", async () => {
    const { router, files } = fixture([
      { id: "ses_resumed", parentID: "ses_root" },
      { id: "ses_nested", parentID: "ses_resumed" },
      { id: "ses_unrelated" },
    ])
    await router.seed()
    await feed(router, [
      assistant("ses_nested", "msg_nested"),
      start("ses_nested", "msg_nested"),
      tool("ses_nested", "msg_nested", "call_nested"),
      text("ses_nested", "msg_nested", "Resumed answer"),
      finish("ses_nested", "msg_nested"),
    ])
    await router.finish()
    expect([...files.keys()].sort()).toEqual(["ses_nested", "ses_resumed", "ses_root"])
    expect(manifest(files).map(({ sessionId, parentSessionId }) => ({ sessionId, parentSessionId }))).toEqual([
      { sessionId: "ses_root", parentSessionId: undefined },
      { sessionId: "ses_resumed", parentSessionId: "ses_root" },
      { sessionId: "ses_nested", parentSessionId: "ses_resumed" },
    ])
    assertGeneration(files.get("ses_nested")!, "msg_nested", { output: "Resumed answer", tools: 1, tokens: 3 })
  })

  test("resuming without child activity retains the child's existing on-disk evidence", async () => {
    await using tmp = await tmpdir()
    const exporter = new FileExporter(tmp.path, 0)
    const firstRoot = Trace.withExporters([exporter])
    firstRoot.startTrace("ses_root", {})
    const first = new RunTracing("ses_root", firstRoot, { get: async () => undefined, children: async () => [] })
    await feed(first, [
      created("ses_child", "ses_root"),
      assistant("ses_child", "msg_child"),
      request("ses_child"),
      start("ses_child", "msg_child"),
      tool("ses_child", "msg_child", "call_child"),
      text("ses_child", "msg_child", "Earlier child answer"),
      finish("ses_child", "msg_child", 7, 11),
    ])
    await first.finish()
    const childPath = path.join(tmp.path, "ses_child.json")
    const before = (await Bun.file(childPath).json()) as TraceFile

    const resumedRoot = Trace.withExporters([exporter])
    expect(await resumedRoot.rehydrateFromFile("ses_root")).toBe(true)
    const resumed = new RunTracing("ses_root", resumedRoot, {
      get: async () => undefined,
      children: async (id) => (id === "ses_root" ? [{ id: "ses_child", parentID: "ses_root" }] : []),
    })
    await resumed.seed()
    await resumed.finish()
    const after = (await Bun.file(childPath).json()) as TraceFile
    expect(after.traceId).toBe(before.traceId)
    expect(after.startedAt).toBe(before.startedAt)
    expect(after.metadata).toEqual(before.metadata)
    expect(after.spans.filter((span) => span.kind !== "session")).toEqual(
      before.spans.filter((span) => span.kind !== "session"),
    )
    expect(after.summary).toMatchObject({ totalGenerations: 1, totalToolCalls: 1, totalTokens: 18 })
    expect(after.summary.tokens).toEqual(before.summary.tokens)
    const rootFile = (await Bun.file(path.join(tmp.path, "ses_root.json")).json()) as TraceFile
    expect(rootFile.metadata.run!.sessions!.find((entry) => entry.sessionId === "ses_child")!.traceId).toBe(
      before.traceId,
    )
  })

  test("task_id reuse links both invocations to one verified child without duplicating events", async () => {
    const { router, files } = fixture([{ id: "ses_reused", parentID: "ses_root" }])
    const first = tool("ses_root", "msg_first", "call_first", "task", {}, { task_id: "ses_reused" })
    const second = tool("ses_root", "msg_second", "call_second", "task", { sessionId: "ses_reused" })
    await feed(router, [
      assistant("ses_root", "msg_first"),
      start("ses_root", "msg_first"),
      first,
      first,
      finish("ses_root", "msg_first"),
      assistant("ses_reused", "msg_child_first"),
      start("ses_reused", "msg_child_first"),
      text("ses_reused", "msg_child_first", "First answer"),
      finish("ses_reused", "msg_child_first"),
      assistant("ses_root", "msg_second"),
      start("ses_root", "msg_second"),
      second,
      second,
      finish("ses_root", "msg_second"),
      assistant("ses_reused", "msg_child_second"),
      start("ses_reused", "msg_child_second"),
      text("ses_reused", "msg_child_second", "Second answer"),
      finish("ses_reused", "msg_child_second"),
    ])
    await router.finish()
    expect(files.size).toBe(2)
    expect(files.get("ses_root")!.summary.totalToolCalls).toBe(2)
    expect(files.get("ses_reused")!.summary.totalGenerations).toBe(2)
    expect(manifest(files).find((entry) => entry.sessionId === "ses_reused")!.taskLinks).toEqual([
      { sessionId: "ses_root", messageId: "msg_first", callId: "call_first" },
      { sessionId: "ses_root", messageId: "msg_second", callId: "call_second" },
    ])
  })

  test("events and task links before parent creation replay once after ancestry is established", async () => {
    const { router, files } = fixture()
    const task = tool("ses_early", "msg_early", "call_early_task", "task", { sessionId: "ses_early_nested" })
    await feed(router, [
      assistant("ses_early", "msg_early"),
      start("ses_early", "msg_early"),
      task,
      created("ses_early_nested", "ses_early"),
      assistant("ses_early_nested", "msg_early_nested"),
      start("ses_early_nested", "msg_early_nested"),
      tool("ses_early_nested", "msg_early_nested", "call_early_nested"),
      text("ses_early_nested", "msg_early_nested", "Early nested answer"),
      finish("ses_early_nested", "msg_early_nested"),
      text("ses_early", "msg_early", "Early answer"),
      finish("ses_early", "msg_early"),
      created("ses_early", "ses_root"),
    ])
    await router.finish()
    expect(files.size).toBe(3)
    assertGeneration(files.get("ses_early")!, "msg_early", { output: "Early answer", tools: 1, tokens: 3 })
    assertGeneration(files.get("ses_early_nested")!, "msg_early_nested", {
      output: "Early nested answer",
      tools: 1,
      tokens: 3,
    })
    expect(manifest(files).find((entry) => entry.sessionId === "ses_early_nested")).toMatchObject({
      parentSessionId: "ses_early",
      taskLinks: [{ sessionId: "ses_early", messageId: "msg_early", callId: "call_early_task" }],
    })
  })

  test("unrelated sessions and unverified task targets never enter the trace manifest", async () => {
    const { router, files } = fixture([{ id: "ses_outside" }, { id: "ses_outside_child", parentID: "ses_outside" }])
    await feed(router, [
      created("ses_outside"),
      created("ses_outside_child", "ses_outside"),
      assistant("ses_outside_child", "msg_outside"),
      start("ses_outside_child", "msg_outside"),
      tool("ses_outside_child", "msg_outside", "call_outside"),
      text("ses_outside_child", "msg_outside", "Unrelated answer"),
      finish("ses_outside_child", "msg_outside"),
      {
        type: "session.error",
        properties: { sessionID: "ses_outside", error: { name: "APIError", data: { message: "unrelated failure" } } },
      },
      assistant("ses_root", "msg_root"),
      start("ses_root", "msg_root"),
      tool("ses_root", "msg_root", "call_unverified", "task", { sessionId: "ses_outside_child" }),
      text("ses_root", "msg_root", "Root answer"),
      finish("ses_root", "msg_root"),
    ])
    await router.finish()
    expect([...files.keys()]).toEqual(["ses_root"])
    expect(manifest(files).map((entry) => entry.sessionId)).toEqual(["ses_root"])
    assertGeneration(files.get("ses_root")!, "msg_root", { output: "Root answer", tools: 1, tokens: 3 })
    expect(files.get("ses_root")!.summary.status).toBe("completed")
    expect(files.get("ses_root")!.summary.error).toBeUndefined()
  })

  test("child failures, cancellations, and unfinished work leave the root outcome independent", async () => {
    const { router, files } = fixture()
    await feed(router, [
      created("ses_failed", "ses_root"),
      created("ses_cancelled", "ses_root"),
      created("ses_active", "ses_root"),
      {
        type: "session.error",
        properties: { sessionID: "ses_failed", error: { name: "APIError", data: { message: "provider failure" } } },
      },
      {
        type: "session.error",
        properties: {
          sessionID: "ses_cancelled",
          error: { name: "MessageAbortedError", data: { message: "cancelled" } },
        },
      },
      { type: "session.status", properties: { sessionID: "ses_cancelled", status: { type: "idle" } } },
      { type: "session.status", properties: { sessionID: "ses_active", status: { type: "busy" } } },
      assistant("ses_root", "msg_root"),
      start("ses_root", "msg_root"),
      text("ses_root", "msg_root", "Root result"),
      finish("ses_root", "msg_root"),
    ])
    await router.finish()
    expect(files.get("ses_root")!.summary.status).toBe("completed")
    expect(files.get("ses_root")!.summary.error).toBeUndefined()
    expect(files.get("ses_failed")!.summary.status).toBe("error")
    expect(JSON.parse(files.get("ses_failed")!.summary.error!)).toEqual({
      name: "APIError",
      data: { message: "provider failure" },
    })
    expect(files.get("ses_cancelled")!.summary.status).toBe("error")
    expect(JSON.parse(files.get("ses_cancelled")!.summary.error!)).toEqual({
      name: "MessageAbortedError",
      data: { message: "cancelled" },
    })
    expect(files.get("ses_active")!.summary).toMatchObject({
      status: "error",
      error: "The root run ended while this child session was still active.",
    })
  })

  test("providers without reasoning leave it absent and completed events are idempotent", async () => {
    const { router, files } = fixture()
    const events = [
      assistant("ses_root", "msg_root"),
      start("ses_root", "msg_root"),
      text("ses_root", "msg_root", "Answer"),
      finish("ses_root", "msg_root"),
    ]
    await feed(router, events)
    await feed(router, events)
    await router.finish()
    const root = files.get("ses_root")!
    assertGeneration(root, "msg_root", { output: "Answer", tools: 0, tokens: 3 })
    expect(root.spans.filter((span) => span.name === "reasoning")).toHaveLength(0)
    expect(root.summary.tokens.reasoning).toBe(0)
    expect(root.metadata.captureOmissions).toHaveLength(3)
  })

  test("crash flushing preserves the root manifest and each child file", async () => {
    await using tmp = await tmpdir()
    const root = Trace.withExporters([new FileExporter(tmp.path, 0)])
    root.startTrace("ses_root", {})
    const router = new RunTracing("ses_root", root, { get: async () => undefined, children: async () => [] })
    await feed(router, [
      created("ses_child", "ses_root"),
      assistant("ses_child", "msg_child"),
      start("ses_child", "msg_child"),
    ])
    router.flushSync("SIGTERM")
    const rootFile = (await Bun.file(path.join(tmp.path, "ses_root.json")).json()) as TraceFile
    const childFile = (await Bun.file(path.join(tmp.path, "ses_child.json")).json()) as TraceFile
    expect(rootFile.summary.status).toBe("crashed")
    expect(childFile.summary.status).toBe("crashed")
    expect(rootFile.metadata.run!.sessions!.map((entry) => entry.sessionId)).toEqual(["ses_root", "ses_child"])
    expect(childFile.metadata.run).toEqual({ rootSessionId: "ses_root", parentSessionId: "ses_root" })
    expect(childFile.summary.totalGenerations).toBe(1)
    await router.finish("SIGTERM")
  })
})
