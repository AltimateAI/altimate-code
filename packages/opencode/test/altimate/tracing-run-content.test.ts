import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  Trace,
  MAX_SERIALIZED_SPANS,
  USER_MESSAGE_INPUT_MAX_CHARS,
  type LLMRequestSnapshot,
  type TraceFile,
  type TraceExporter,
} from "../../src/altimate/observability/tracing"

function recording() {
  const files = new Map<string, TraceFile>()
  const exporter: TraceExporter = {
    name: "capture",
    async export(file) {
      files.set(file.sessionId, file)
      return file.sessionId
    },
  }
  const root = Trace.withExporters([exporter])
  root.startTrace("root", {})
  return { root, files }
}

function finish(messageID: string) {
  return {
    id: `finish-${messageID}`,
    messageID,
    reason: "stop",
    cost: 0.25,
    tokens: { input: 3, output: 2, reasoning: 1, cache: { read: 0, write: 0 } },
  }
}

function tool(messageID: string, output = "tool result") {
  return {
    id: `tool-${messageID}`,
    messageID,
    tool: "read",
    callID: "same-call-id",
    state: { status: "completed" as const, input: {}, output, time: { start: 1, end: 2 } },
  }
}

function request(overrides: Partial<LLMRequestSnapshot> = {}): LLMRequestSnapshot {
  return {
    requestID: "request-first",
    sessionID: "root",
    messageID: "assistant-first",
    userMessageID: "user-first",
    agent: "analyst",
    providerID: "test-provider",
    modelID: "test-model",
    variant: "high",
    startTime: 1000,
    system: "Provider system\n\nAgent system\n\nUser system",
    instructions: "Provider instructions",
    tools: [
      {
        name: "read",
        description: "Read a file",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        active: true,
        providerToolID: "provider.read",
      },
    ],
    ...overrides,
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

describe("run trace content", () => {
  test("request snapshots preserve effective inputs and hash-dedupe canonical tool schemas", async () => {
    const { root, files } = recording()
    const first = request()
    root.logLLMRequest(first)
    root.logLLMRequest(
      request({
        requestID: "request-second",
        messageID: "assistant-second",
        tools: [
          {
            providerToolID: "provider.read",
            active: true,
            inputSchema: { required: ["path"], properties: { path: { type: "string" } }, type: "object" },
            description: "Read a file",
            name: "read",
          },
        ],
      }),
    )
    await root.endTrace()
    const spans = files.get("root")!.spans.filter((span) => span.name === "llm-request")
    expect(spans).toHaveLength(2)
    const systemHash = sha256(first.system)
    const instructionsHash = sha256(first.instructions!)
    const toolsHash = sha256(
      JSON.stringify([
        {
          active: true,
          description: "Read a file",
          inputSchema: { properties: { path: { type: "string" } }, required: ["path"], type: "object" },
          name: "read",
          providerToolID: "provider.read",
        },
      ]),
    )
    expect(spans[0]).toMatchObject({
      kind: "span",
      startTime: first.startTime,
      model: { modelId: first.modelID, providerId: first.providerID, variant: first.variant },
      attributes: {
        sessionId: first.sessionID,
        messageId: first.messageID,
        userMessageId: first.userMessageID,
        agent: first.agent,
        requestId: first.requestID,
        captureBoundary: "before-streamText",
      },
      input: {
        system: { hash: systemHash, content: first.system },
        tools: { hash: toolsHash, content: first.tools },
        instructions: { hash: instructionsHash, content: first.instructions },
      },
    })
    expect(spans[1].input).toEqual({
      system: { hash: systemHash },
      tools: { hash: toolsHash },
      instructions: { hash: instructionsHash },
    })
  })

  test("changed request fields retain new snapshots independently and old snapshots stay deduplicated", async () => {
    const { root, files } = recording()
    const first = request()
    const nextTools = [...first.tools, { name: "_noop", active: false, inputSchema: { type: "object" } }]
    root.logLLMRequest(first)
    root.logLLMRequest(request({ requestID: "system-change", system: "Updated system" }))
    root.logLLMRequest(
      request({
        requestID: "tools-change",
        system: "Updated system",
        tools: nextTools,
        instructions: "New instructions",
      }),
    )
    root.logLLMRequest(request({ requestID: "original-again" }))
    root.logLLMRequest(request({ requestID: "no-instructions", instructions: undefined }))
    await root.endTrace()
    const inputs = files
      .get("root")!
      .spans.filter((span) => span.name === "llm-request")
      .map((span) => span.input)
    expect(inputs).toHaveLength(5)
    expect(inputs[1]).toEqual({
      system: { hash: sha256("Updated system"), content: "Updated system" },
      tools: { hash: expect.any(String) },
      instructions: { hash: sha256(first.instructions!) },
    })
    expect(inputs[2]).toEqual({
      system: { hash: sha256("Updated system") },
      tools: { hash: expect.any(String), content: nextTools },
      instructions: { hash: sha256("New instructions"), content: "New instructions" },
    })
    expect(inputs[3]).toEqual({
      system: { hash: sha256(first.system) },
      tools: { hash: expect.any(String) },
      instructions: { hash: sha256(first.instructions!) },
    })
    expect(inputs[4]).toEqual({ system: { hash: sha256(first.system) }, tools: { hash: expect.any(String) } })
  })

  test("request identities are idempotent, unrelated sessions are rejected, and fork dedupe is independent", async () => {
    const { root, files } = recording()
    const child = await root.forkSession("child")
    const first = request()
    root.logLLMRequest(first)
    root.logLLMRequest(first)
    root.logLLMRequest(request({ requestID: "unrelated", sessionID: "outside", system: "Outside system" }))
    child.logLLMRequest(request({ sessionID: "child" }))
    await Promise.all([root.endTrace(), child.endTrace()])
    for (const id of ["root", "child"]) {
      const spans = files.get(id)!.spans.filter((span) => span.name === "llm-request")
      expect(spans).toHaveLength(1)
      expect(spans[0].attributes?.sessionId).toBe(id)
      expect(spans[0].input).toEqual({
        system: { hash: sha256(first.system), content: first.system },
        tools: { hash: expect.any(String), content: first.tools },
        instructions: { hash: sha256(first.instructions!), content: first.instructions },
      })
    }
  })

  test("forked recordings isolate interleaved generations and retain linked lineage and stable counts", async () => {
    const { root, files } = recording()
    const childA = await root.forkSession("child-a")
    const childB = await root.forkSession("child-b")
    const grandchild = await childA.forkSession("grandchild")
    const recordings = [root, childA, childB, grandchild]
    const sessions = recordings.map((trace, index) => ({
      sessionId: trace.getIdentity().sessionId!,
      traceId: trace.getIdentity().traceId,
      ...(index && { parentSessionId: index === 3 ? "child-a" : "root" }),
      ...(index === 1 && {
        taskLinks: [
          { sessionId: "root", messageId: "m1", callId: "task-first" },
          { sessionId: "root", messageId: "m2", callId: "task-reused" },
        ],
      }),
    }))
    root.setRunLineage({ rootSessionId: "root", sessions })
    recordings.slice(1).forEach((trace, index) =>
      trace.setRunLineage({
        rootSessionId: "root",
        parentSessionId: index === 2 ? "child-a" : "root",
      }),
    )
    recordings.forEach((trace, index) => {
      const part = { id: `start-${index}`, messageID: `m${index}` }
      trace.logStepStart(part)
      trace.logStepStart(part)
    })
    for (const index of [2, 0, 3, 1]) {
      const trace = recordings[index]
      const messageID = `m${index}`
      const text = { id: `text-${index}`, messageID, text: `answer-${index}` }
      const reasoning = { id: `reason-${index}`, messageID, text: `exposed-${index}` }
      for (let repeat = 0; repeat < 2; repeat++) {
        trace.logToolCall(tool(messageID))
        trace.logText(text)
        if (index !== 2) trace.logReasoning(reasoning)
        trace.logStepFinish(finish(messageID))
      }
    }
    await Promise.all(recordings.map((trace) => trace.endTrace()))
    expect(files.size).toBe(4)
    expect(files.get("root")!.metadata.run).toEqual({ rootSessionId: "root", sessions })
    expect(new Set([...files.values()].map((file) => file.traceId)).size).toBe(4)
    for (const [index, trace] of recordings.entries()) {
      const file = files.get(trace.getIdentity().sessionId!)!
      expect(file.summary.totalGenerations).toBe(1)
      expect(file.summary.totalToolCalls).toBe(1)
      expect(file.summary.totalTokens).toBe(6)
      expect(file.summary.totalCost).toBe(0.25)
      const generation = file.spans.find((span) => span.kind === "generation")!
      expect(generation.output).toBe(`answer-${index}`)
      expect(generation.attributes).toEqual({ sessionId: file.sessionId, messageId: `m${index}` })
      expect(file.spans.find((span) => span.kind === "tool")!.parentSpanId).toBe(generation.spanId)
      const reasoning = file.spans.filter((span) => span.name === "reasoning")
      expect(reasoning.length).toBe(index === 2 ? 0 : 1)
      if (reasoning.length) expect(reasoning[0].parentSpanId).toBe(generation.spanId)
    }
  })

  test("late parts attach to their own message and unrelated sessions are rejected", async () => {
    const { root, files } = recording()
    root.logStepStart({ id: "s1", messageID: "first" })
    root.logStepFinish(finish("first"))
    root.logStepStart({ id: "s2", messageID: "second" })
    root.logText({ id: "late-text", messageID: "first", text: "late first answer" })
    root.logToolCall(tool("first"))
    root.logReasoning({ id: "late-reason", messageID: "first", text: "provider reasoning" })
    root.logToolCall({ ...tool("unrelated"), sessionID: "unrelated" })
    root.logStepStart({ id: "bad", sessionID: "unrelated" })
    root.logText({ id: "second-text", messageID: "second", text: "second answer" })
    root.logStepFinish(finish("second"))
    await root.endTrace()
    const file = files.get("root")!
    const generations = file.spans.filter((span) => span.kind === "generation")
    expect(generations.map((span) => span.output)).toEqual(["late first answer", "second answer"])
    expect(file.summary.totalGenerations).toBe(2)
    expect(file.summary.totalToolCalls).toBe(1)
    expect(file.spans.find((span) => span.kind === "tool")!.parentSpanId).toBe(generations[0].spanId)
    expect(file.spans.find((span) => span.name === "reasoning")!.parentSpanId).toBe(generations[0].spanId)
  })

  test("output clipping and unavailable capture have explicit metadata", async () => {
    const { root, files } = recording()
    root.setCaptureOmissions(["effective system input unavailable", "resolved tool definitions unavailable"])
    root.logStepStart({ id: "s1", messageID: "first" })
    root.logToolCall(tool("first", "x".repeat(10009)))
    root.logUserMessage("p".repeat(USER_MESSAGE_INPUT_MAX_CHARS + 3))
    root.logStepFinish(finish("first"))
    await root.endTrace()
    const file = files.get("root")!
    const span = file.spans.find((span) => span.kind === "tool")!
    expect(String(span.output).length).toBe(10000)
    expect(span.attributes?.outputOmission).toEqual({
      reason: "character_limit",
      originalCharacters: 10009,
      retainedCharacters: 10000,
      omittedCharacters: 9,
    })
    expect(file.spans.find((span) => span.kind === "user-message")!.attributes?.inputOmission).toEqual({
      reason: "character_limit",
      originalCharacters: USER_MESSAGE_INPUT_MAX_CHARS + 3,
      retainedCharacters: USER_MESSAGE_INPUT_MAX_CHARS,
      omittedCharacters: 3,
    })
    expect(file.metadata.captureOmissions).toEqual([
      "effective system input unavailable",
      "resolved tool definitions unavailable",
    ])
  })

  test("serialized span caps report original, retained, and omitted counts", async () => {
    const { root, files } = recording()
    for (let i = 0; i < MAX_SERIALIZED_SPANS + 5; i++) {
      root.logSpan({ name: "operation", startTime: i, endTime: i })
    }
    await root.endTrace()
    const file = files.get("root")!
    expect(file.spans.length).toBe(MAX_SERIALIZED_SPANS)
    expect(file.omissions?.spans).toEqual({
      original: MAX_SERIALIZED_SPANS + 6,
      retained: MAX_SERIALIZED_SPANS - 1,
      omitted: 7,
      limit: MAX_SERIALIZED_SPANS,
    })
  })

  test("generation input labels tool-result summaries and counts their clipped content", async () => {
    const { root, files } = recording()
    root.logStepStart({ id: "s1", messageID: "first" })
    root.logToolCall(tool("first", "x".repeat(650)))
    root.logToolCall({
      id: "error-tool",
      messageID: "first",
      tool: "search",
      callID: "error-call",
      state: { status: "error", input: {}, error: "e".repeat(215), time: { start: 1, end: 2 } },
    })
    root.logStepFinish(finish("first"))
    root.logStepStart({ id: "s2", messageID: "second" })
    root.logStepFinish(finish("second"))
    await root.endTrace()
    const generations = files.get("root")!.spans.filter((span) => span.kind === "generation")
    expect(generations[0].attributes?.inputSource).toBeUndefined()
    expect(generations[1].input).toBe(`[read] ${"x".repeat(500)}\n[search] error: ${"e".repeat(200)}`)
    expect(generations[1].attributes?.inputSource).toBe("tool-result-summaries")
    expect(generations[1].attributes?.inputOmission).toEqual({
      reason: "tool_result_summary_limit",
      originalCharacters: 865,
      retainedCharacters: 700,
      omittedCharacters: 165,
    })
  })

  test("child cancellation remains local to its recording", async () => {
    const { root, files } = recording()
    const child = await root.forkSession("cancelled")
    child.logStepStart({ id: "start", messageID: "child-message" })
    child.logReasoning({ id: "reason", messageID: "child-message", text: "partial provider reasoning" })
    await child.endTrace("MessageAbortedError: cancelled")
    await root.endTrace()
    expect(files.get("cancelled")!.summary.status).toBe("error")
    expect(files.get("cancelled")!.summary.totalGenerations).toBe(1)
    expect(files.get("root")!.summary.status).toBe("completed")
    expect(files.get("root")!.summary.totalGenerations).toBe(0)
  })
})
