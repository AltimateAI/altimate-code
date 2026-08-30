import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { SessionCompaction } from "../../src/session/compaction"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { Provider } from "../../src/provider/provider"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { Plugin } from "../../src/plugin"
import { Telemetry } from "../../src/telemetry"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { NudgeArbiter } from "../../src/session/nudge"
import { SessionTermination } from "../../src/session/termination"

Log.init({ print: false })

// ─── Harness reliability + (item 3) unit gates ───────────────────
// the auto-compaction continue message must carry the original user
//       message's format/tools/system/variant (like the replay branch), so the
//       first auto-compaction cannot silently widen the permission surface.
// the summarizer call passes explicit toolChoice "none", and a "continue"
//       result with no non-empty summary text is retried ONCE, then errored —
//       never committed.
//
// SessionCompaction.process wires imperative singletons directly (SessionProcessor,
// Provider, Agent, Session, ...), so these tests use the spy-based mocking pattern
// (see test/altimate/enhance-prompt.test.ts) — never mock.module() for shared
// infrastructure modules.

const ref = { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") }
const savedRunMode = process.env.ALTIMATE_RUN_MODE

const fakeModel = {
  id: "test-model",
  providerID: "test",
  name: "Test",
  limit: { context: 100_000, output: 32_000 },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  capabilities: {
    toolcall: true,
    attachment: false,
    reasoning: false,
    temperature: true,
    input: { text: true, image: false, audio: false, video: false },
    output: { text: true, image: false, audio: false, video: false },
  },
  api: { id: "test", npm: "@ai-sdk/anthropic" },
  options: {},
} as unknown as Provider.Model

// In-memory message/part store standing in for the session database.
const store = {
  messages: [] as any[],
  parts: [] as any[],
}

type ProcessBehavior = (streamInput: any, message: any) => Promise<"continue" | "stop" | "compact">
let processCalls: any[] = []
let processBehaviors: ProcessBehavior[] = []

function writeSummary(text: string): ProcessBehavior {
  return async (_streamInput, message) => {
    store.parts.push({
      id: PartID.ascending(),
      messageID: message.id,
      sessionID: message.sessionID,
      type: "text",
      text,
    })
    return "continue"
  }
}

const noSummary: ProcessBehavior = async () => "continue"

// Instance.directory / Instance.worktree are getters that require ambient
// instance context; override them for the duration of this file.
const instanceDescriptors = {
  directory: Object.getOwnPropertyDescriptor(Instance, "directory")!,
  worktree: Object.getOwnPropertyDescriptor(Instance, "worktree")!,
}
Object.defineProperty(Instance, "directory", { configurable: true, get: () => "/tmp/compaction-test" })
Object.defineProperty(Instance, "worktree", { configurable: true, get: () => "/tmp/compaction-test" })

spyOn(Config, "get").mockImplementation(async () => ({}) as any)
spyOn(Provider, "getModel").mockImplementation(async () => fakeModel)
spyOn(Agent, "get").mockImplementation(
  async () => ({ name: "compaction", mode: "primary", options: {}, permission: [] }) as any,
)
spyOn(Plugin, "trigger").mockImplementation(async (_name: any, _input: any, output: any) => output)
spyOn(Telemetry, "track").mockImplementation((() => {}) as any)
spyOn(Bus, "publish").mockImplementation(async () => {})
spyOn(MessageV2, "toModelMessages").mockImplementation(async () => [])
spyOn(MessageV2, "get").mockImplementation(
  (input: any) =>
    ({
      info: store.messages.find((m) => m.id === input.messageID),
      parts: store.parts.filter((p) => p.messageID === input.messageID),
    }) as any,
)
spyOn(Session, "updateMessage").mockImplementation((async (msg: any) => {
  store.messages.push(msg)
  return msg
}) as any)
spyOn(Session, "updatePart").mockImplementation((async (part: any) => {
  store.parts.push(part)
  return part
}) as any)
spyOn(SessionProcessor, "create").mockImplementation((input: any) => {
  const message = input.assistantMessage
  return {
    get message() {
      return message
    },
    partFromToolCall: () => undefined,
    async process(streamInput: any) {
      processCalls.push(streamInput)
      const behavior = processBehaviors.shift() ?? writeSummary("summary")
      return behavior(streamInput, message)
    },
  } as any
})

afterAll(() => {
  mock.restore()
  if (savedRunMode === undefined) delete process.env.ALTIMATE_RUN_MODE
  else process.env.ALTIMATE_RUN_MODE = savedRunMode
  Object.defineProperty(Instance, "directory", instanceDescriptors.directory)
  Object.defineProperty(Instance, "worktree", instanceDescriptors.worktree)
})

beforeEach(() => {
  process.env.ALTIMATE_RUN_MODE = "1"
  store.messages = []
  store.parts = []
  processCalls = []
  processBehaviors = []
})

let counter = 0
function freshSessionID() {
  counter += 1
  return SessionID.make(`ses_summarizer_test_${counter}`)
}

function history(sessionID: SessionID, opts?: { userFields?: Record<string, unknown> }) {
  const userID = MessageID.ascending()
  const assistantID = MessageID.ascending()
  const markerID = MessageID.ascending()
  const messages = [
    {
      info: {
        id: userID,
        sessionID,
        role: "user",
        time: { created: 1 },
        agent: "build",
        model: ref,
        ...(opts?.userFields ?? {}),
      },
      parts: [{ id: PartID.ascending(), messageID: userID, sessionID, type: "text", text: "do the task" }],
    },
    {
      info: {
        id: assistantID,
        sessionID,
        role: "assistant",
        parentID: userID,
        time: { created: 2 },
        mode: "build",
        agent: "build",
        path: { cwd: "/tmp/compaction-test", root: "/tmp/compaction-test" },
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        finish: "end_turn",
      },
      parts: [{ id: PartID.ascending(), messageID: assistantID, sessionID, type: "text", text: "working on it" }],
    },
    {
      info: {
        id: markerID,
        sessionID,
        role: "user",
        time: { created: 3 },
        agent: "build",
        model: ref,
      },
      parts: [{ id: PartID.ascending(), messageID: markerID, sessionID, type: "compaction", auto: true }],
    },
  ] as any[]
  return { messages, markerID }
}

function run(input: { sessionID: SessionID; messages: any[]; markerID: MessageID }) {
  return SessionCompaction.process({
    sessionID: input.sessionID,
    messages: input.messages,
    parentID: input.markerID,
    abort: new AbortController().signal,
    auto: true,
  })
}

describe("session.compaction continue-message contract (/ item 12)", () => {
  test("continue message carries original tools/system/format/variant through auto-compaction", async () => {
    const sessionID = freshSessionID()
    const { messages, markerID } = history(sessionID, {
      userFields: {
        tools: { bash: true, edit: false },
        system: "custom system prompt",
        variant: "high",
        format: { type: "json" },
      },
    })
    processBehaviors = [writeSummary("a real summary")]

    const result = await run({ sessionID, messages, markerID })

    expect(result).toBe("continue")
    const continueMsg = store.messages.filter((m) => m.role === "user").at(-1)
    expect(continueMsg).toBeDefined()
    expect(continueMsg.tools).toEqual({ bash: true, edit: false })
    expect(continueMsg.system).toBe("custom system prompt")
    expect(continueMsg.variant).toBe("high")
    expect(continueMsg.format).toEqual({ type: "json" })
    // (b): the continue prompt is the three-option completion-aware nudge.
    const continuePart = store.parts.find((p) => p.messageID === continueMsg.id && p.type === "text")
    expect(continuePart?.synthetic).toBe(true)
    expect(continuePart?.text).toContain("reply with DONE")
  })

  test("continue message leaves fields unset when the original user message never set them", async () => {
    const sessionID = freshSessionID()
    const { messages, markerID } = history(sessionID)
    processBehaviors = [writeSummary("a real summary")]

    const result = await run({ sessionID, messages, markerID })

    expect(result).toBe("continue")
    const continueMsg = store.messages.filter((m) => m.role === "user").at(-1)
    expect(continueMsg.tools).toBeUndefined()
    expect(continueMsg.system).toBeUndefined()
    expect(continueMsg.variant).toBeUndefined()
    expect(continueMsg.format).toBeUndefined()
  })
})

describe("session.compaction summarizer integrity (/ item 3)", () => {
  test("summarizer call passes explicit toolChoice 'none' and no tools", async () => {
    const sessionID = freshSessionID()
    const { messages, markerID } = history(sessionID)
    processBehaviors = [writeSummary("a real summary")]

    await run({ sessionID, messages, markerID })

    expect(processCalls.length).toBe(1)
    expect(processCalls[0].toolChoice).toBe("none")
    expect(processCalls[0].tools).toEqual({})
  })

  // altimate_change start — upstream_fix regression: PIN_SUMMARY_ADDITION told
  // the summarizer to skip the task ("it's pinned separately") based only on
  // pinEnabled(cfg) — but pinBudget can independently return 0 on a small
  // window, so no pin would actually be injected and the task got dropped
  // from both places.
  function summarizerPromptText() {
    const lastMessage = processCalls[0].messages.at(-1)
    return lastMessage.content[0].text as string
  }

  test("PIN_SUMMARY_ADDITION is included when the session's pin budget is positive", async () => {
    const sessionID = freshSessionID()
    const { messages, markerID } = history(sessionID)
    processBehaviors = [writeSummary("a real summary")]

    await run({ sessionID, messages, markerID })

    expect(summarizerPromptText()).toContain(SessionCompaction.PIN_SUMMARY_ADDITION)
  })

  test("PIN_SUMMARY_ADDITION is omitted when the session's pin budget is zero (tiny window)", async () => {
    const sessionID = freshSessionID()
    const { messages, markerID } = history(sessionID)
    processBehaviors = [writeSummary("a real summary")]
    const tinyModel = {
      ...fakeModel,
      limit: { context: 15_000, output: 1_000 },
    } as unknown as Provider.Model
    spyOn(Provider, "getModel").mockImplementationOnce(async () => tinyModel)

    await run({ sessionID, messages, markerID })

    expect(summarizerPromptText()).not.toContain(SessionCompaction.PIN_SUMMARY_ADDITION)
  })

  test("PIN_SUMMARY_ADDITION is omitted when history contains only an acknowledgement", async () => {
    const sessionID = freshSessionID()
    const { messages, markerID } = history(sessionID)
    messages[0].parts[0].text = "continue"
    processBehaviors = [writeSummary("a real summary")]

    await run({ sessionID, messages, markerID })

    expect(summarizerPromptText()).not.toContain(SessionCompaction.PIN_SUMMARY_ADDITION)
  })
  // altimate_change end

  test("does not retry when the first attempt produces summary text", async () => {
    const sessionID = freshSessionID()
    const { messages, markerID } = history(sessionID)
    processBehaviors = [writeSummary("a real summary")]

    const result = await run({ sessionID, messages, markerID })

    expect(result).toBe("continue")
    expect(processCalls.length).toBe(1)
  })

  test("retries once with identical input when the summary step has no text", async () => {
    const sessionID = freshSessionID()
    const { messages, markerID } = history(sessionID)
    processBehaviors = [noSummary, writeSummary("recovered summary")]

    const result = await run({ sessionID, messages, markerID })

    expect(result).toBe("continue")
    expect(processCalls.length).toBe(2)
    // Retry uses the identical summarizer input.
    expect(processCalls[1]).toBe(processCalls[0])
    // No error was committed.
    const summaryMsg = store.messages.find((m) => m.role === "assistant" && m.summary)
    expect(summaryMsg.error).toBeUndefined()
  })

  test("whitespace-only summary text counts as empty", async () => {
    const sessionID = freshSessionID()
    const { messages, markerID } = history(sessionID)
    processBehaviors = [writeSummary("   \n\t "), writeSummary("recovered summary")]

    const result = await run({ sessionID, messages, markerID })

    expect(result).toBe("continue")
    expect(processCalls.length).toBe(2)
  })

  test("marks error and stops instead of committing when retry also produces no text", async () => {
    const sessionID = freshSessionID()
    const { messages, markerID } = history(sessionID)
    processBehaviors = [noSummary, noSummary]

    const result = await run({ sessionID, messages, markerID })

    expect(result).toBe("stop")
    expect(processCalls.length).toBe(2)
    const summaryMsg = store.messages.find((m) => m.role === "assistant" && m.summary)
    expect(summaryMsg.finish).toBe("error")
    expect(summaryMsg.error?.name).toBe("UnknownError")
    expect(JSON.stringify(summaryMsg.error)).toContain("no summary text")
    // The failed summary must NOT be committed as a compaction continue turn.
    const continueTurn = store.parts.find((p) => p.type === "text" && p.synthetic)
    expect(continueTurn).toBeUndefined()
  })
})

// ─── Harness reliability (b)+(d) (item 1): completion-aware continue nudge via the
// nudge arbiter, and the mechanism-accurate overflow notice ──────────────────────
describe("session.compaction continue-nudge termination path (/d)", () => {
  test("continue message carries the three-option completion-aware nudge", async () => {
    const sessionID = freshSessionID()
    const { messages, markerID } = history(sessionID)
    processBehaviors = [writeSummary("a real summary")]

    const result = await run({ sessionID, messages, markerID })

    expect(result).toBe("continue")
    const continuePart = store.parts.find((p) => p.type === "text" && p.synthetic)
    expect(continuePart?.text).toContain(SessionTermination.COMPLETION_NUDGE)
    expect(continuePart?.text).toContain("reply with DONE")
    expect(continuePart?.text).toContain("ask for clarification")
  })

  test("interactive compaction retains the ordinary continuation and never injects run-only DONE instructions", async () => {
    process.env.ALTIMATE_RUN_MODE = "0"
    const sessionID = freshSessionID()
    const { messages, markerID } = history(sessionID)
    processBehaviors = [writeSummary("a real summary")]

    const result = await run({ sessionID, messages, markerID })

    expect(result).toBe("continue")
    const continuePart = store.parts.find((p) => p.type === "text" && p.synthetic)
    expect(continuePart?.text).toContain("Continue if you have next steps")
    expect(continuePart?.text).not.toContain(SessionTermination.COMPLETION_NUDGE)
  })

  test("one-directive-per-turn contract: exactly ONE directive block — pending lower-precedence directives are consumed", async () => {
    const sessionID = freshSessionID()
    const { messages, markerID } = history(sessionID)
    processBehaviors = [writeSummary("a real summary")]
    // A starvation-breaker directive is pending from an earlier step.
    NudgeArbiter.register(sessionID, {
      source: "starvation_breaker",
      kind: "starvation",
      text: "STARVATION-DIRECTIVE-TEXT",
    })

    const result = await run({ sessionID, messages, markerID })

    expect(result).toBe("continue")
    const continuePart = store.parts.find((p) => p.type === "text" && p.synthetic)
    // The termination nudge (top precedence) wins; the starvation text is NOT
    // stacked into the same injected turn…
    expect(continuePart?.text).toContain(SessionTermination.COMPLETION_NUDGE)
    expect(continuePart?.text).not.toContain("STARVATION-DIRECTIVE-TEXT")
    // …and nothing is left pending to leak into the next generation.
    expect(NudgeArbiter.pending(sessionID)).toHaveLength(0)
  })

  test("(d): overflow notice is mechanism-accurate — never blames media attachments", async () => {
    const sessionID = freshSessionID()
    const { messages, markerID } = history(sessionID)
    processBehaviors = [writeSummary("a real summary")]

    const result = await SessionCompaction.process({
      sessionID,
      messages,
      parentID: markerID,
      abort: new AbortController().signal,
      auto: true,
      overflow: true,
    })

    expect(result).toBe("continue")
    const continuePart = store.parts.find((p) => p.type === "text" && p.synthetic)
    expect(continuePart?.text).toContain(SessionTermination.OVERFLOW_NOTICE)
    expect(continuePart?.text).not.toContain("large media attachments")
    expect(continuePart?.text).toContain("context limit")
    // The completion nudge still follows the notice.
    expect(continuePart?.text).toContain("reply with DONE")
  })
})
