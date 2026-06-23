import { afterEach, describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

// Regression tests for PR #941 — session transcript REST endpoint
// (packages/opencode/src/server/routes/session.ts).
// Style + helpers mirror test/server/session-transcript.test.ts.

Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

async function withoutWatcher<T>(fn: () => Promise<T>) {
  if (process.platform !== "win32") return fn()
  const prev = process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER
  process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = "true"
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER
    else process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = prev
  }
}

async function addUserMessage(sessionID: SessionID, text: string) {
  const id = MessageID.ascending()
  await Session.updateMessage({
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "test",
    model: { providerID: "test", modelID: "test" },
    tools: {},
    mode: "",
  } as unknown as MessageV2.Info)
  await Session.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID: id,
    type: "text",
    text,
  })
  return id
}

async function addAssistantMessageWithReasoning(
  sessionID: SessionID,
  parentID: MessageID,
  reasoningText: string,
  opts: { completedOffsetMs?: number; text?: string } = {},
) {
  const id = MessageID.ascending()
  const created = Date.now()
  await Session.updateMessage({
    id,
    sessionID,
    role: "assistant",
    agent: "build",
    modelID: "claude-sonnet",
    providerID: "anthropic",
    mode: "",
    parentID,
    path: { cwd: "/test", root: "/test" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time:
      opts.completedOffsetMs !== undefined
        ? { created, completed: created + opts.completedOffsetMs }
        : { created },
  } as unknown as MessageV2.Info)
  await Session.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID: id,
    type: "reasoning",
    text: reasoningText,
    time: { start: Date.now() },
  } as unknown as Parameters<typeof Session.updatePart>[0])
  if (opts.text !== undefined) {
    await Session.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: id,
      type: "text",
      text: opts.text,
    })
  }
  return id
}

// Assistant message carrying a completed tool part and an errored tool part.
async function addAssistantMessageWithTool(sessionID: SessionID, parentID: MessageID) {
  const id = MessageID.ascending()
  await Session.updateMessage({
    id,
    sessionID,
    role: "assistant",
    agent: "build",
    modelID: "claude-sonnet",
    providerID: "anthropic",
    mode: "",
    parentID,
    path: { cwd: "/test", root: "/test" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now() },
  } as unknown as MessageV2.Info)

  const now = Date.now()
  // Completed tool: must satisfy ToolStateCompleted (input/output/title/metadata/time{start,end}).
  await Session.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID: id,
    type: "tool",
    callID: "call_completed",
    tool: "bash",
    state: {
      status: "completed",
      input: { a: 1 },
      output: "hello",
      title: "bash",
      metadata: {},
      time: { start: now, end: now + 10 },
    },
  } as unknown as Parameters<typeof Session.updatePart>[0])

  // Errored tool: must satisfy ToolStateError (input/error/time{start,end}).
  await Session.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID: id,
    type: "tool",
    callID: "call_error",
    tool: "edit",
    state: {
      status: "error",
      input: { b: 2 },
      error: "boom",
      time: { start: now, end: now + 5 },
    },
  } as unknown as Parameters<typeof Session.updatePart>[0])

  return id
}

describe("session transcript endpoint #941", () => {
  // Gap 1: toolDetails=true renders fenced Input/Output/Error blocks; default omits them.
  test("toolDetails=true renders tool input/output/error blocks; default shows only Tool header", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({ title: "Tool Session" })
          const userId = await addUserMessage(session.id, "run something")
          await addAssistantMessageWithTool(session.id, userId)
          const app = Server.Default()

          const withDetails = await app.request(`/session/${session.id}/transcript?toolDetails=true`)
          expect(withDetails.status).toBe(200)
          const detailed = await withDetails.text()
          // Tool header for both tools
          expect(detailed).toContain("**Tool: bash**")
          expect(detailed).toContain("**Tool: edit**")
          // Completed tool: Input + Output fenced blocks
          expect(detailed).toContain("**Input:**")
          expect(detailed).toContain('"a": 1')
          expect(detailed).toContain("**Output:**")
          expect(detailed).toContain("hello")
          // Errored tool: Error fenced block
          expect(detailed).toContain("**Error:**")
          expect(detailed).toContain("boom")

          // Default (no toolDetails): only the Tool header, no fenced detail blocks.
          const plain = await app.request(`/session/${session.id}/transcript`)
          expect(plain.status).toBe(200)
          const plainBody = await plain.text()
          expect(plainBody).toContain("**Tool: bash**")
          expect(plainBody).not.toContain("**Input:**")
          expect(plainBody).not.toContain("**Output:**")
          expect(plainBody).not.toContain("**Error:**")

          await Session.remove(session.id)
        },
      }),
    )
  })

  // Gap 2: assistantMetadata=true emits the model/agent/duration header; default emits plain header.
  test("assistantMetadata=true renders model + titlecased agent + duration header; default is plain", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({ title: "Metadata Session" })
          const userId = await addUserMessage(session.id, "hi")
          // completedOffsetMs exercises the duration branch; route passes no providers,
          // so Model.name must fall back to modelID and titlecase must not throw.
          await addAssistantMessageWithReasoning(session.id, userId, "thinking", {
            completedOffsetMs: 1500,
          })
          const app = Server.Default()

          const withMeta = await app.request(`/session/${session.id}/transcript?assistantMetadata=true`)
          expect(withMeta.status).toBe(200)
          const metaBody = await withMeta.text()
          expect(metaBody).toContain("## Assistant (")
          expect(metaBody).toContain("Build") // titlecased agent ("build" -> "Build")
          expect(metaBody).toContain("claude-sonnet") // modelID fallback (no providers passed)

          // Default: plain "## Assistant" header, no parenthesized metadata.
          const plain = await app.request(`/session/${session.id}/transcript`)
          expect(plain.status).toBe(200)
          const plainBody = await plain.text()
          expect(plainBody).toContain("## Assistant\n")
          expect(plainBody).not.toContain("## Assistant (")

          await Session.remove(session.id)
        },
      }),
    )
  })

  // Gap 3: invalid sessionID format (missing "ses" prefix) -> 400 from param validator, not 404.
  test("invalid sessionID format returns 400 (param validation)", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const app = Server.Default()
          const res = await app.request(`/session/not-a-session-id/transcript`)
          expect(res.status).toBe(400)
        },
      }),
    )
  })

  // Gap 4: boolean flag coercion edge cases. v0.8.8 broadened the preprocess so
  // the common falsey strings ("false"/"0"/"no"/"off", case-insensitive) all map
  // to false — not just the literal "false". So thinking=0 and thinking=FALSE now
  // correctly suppress the reasoning section.
  test("boolean flag falsiness: thinking=0 and thinking=FALSE suppress thinking", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({ title: "Coercion Session" })
          const userId = await addUserMessage(session.id, "think")
          await addAssistantMessageWithReasoning(session.id, userId, "inner thoughts")
          const app = Server.Default()

          // thinking=0 / thinking=FALSE → false → no _Thinking:_ section.
          const zero = await app.request(`/session/${session.id}/transcript?thinking=0`)
          expect(zero.status).toBe(200)
          expect(await zero.text()).not.toContain("_Thinking:_")

          const upperFalse = await app.request(`/session/${session.id}/transcript?thinking=FALSE`)
          expect(upperFalse.status).toBe(200)
          expect(await upperFalse.text()).not.toContain("_Thinking:_")

          // Sanity: thinking=true still includes it.
          const on = await app.request(`/session/${session.id}/transcript?thinking=true`)
          expect(on.status).toBe(200)
          expect(await on.text()).toContain("_Thinking:_")

          await Session.remove(session.id)
        },
      }),
    )
  })

  // Gap 5: multi-message chronological ordering + per-message separators.
  test("multi-message ordering is chronological with one '---' separator per message plus header rule", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({ title: "Ordering Session" })
          const userId = await addUserMessage(session.id, "q1-user-question")
          await addAssistantMessageWithReasoning(session.id, userId, "thoughts", {
            text: "a1-assistant-answer",
          })
          const app = Server.Default()

          const res = await app.request(`/session/${session.id}/transcript`)
          expect(res.status).toBe(200)
          const body = await res.text()

          // User section precedes Assistant section (ascending order).
          expect(body.indexOf("## User")).toBeGreaterThanOrEqual(0)
          expect(body.indexOf("## Assistant")).toBeGreaterThan(body.indexOf("## User"))
          // User text appears before assistant text.
          expect(body.indexOf("q1-user-question")).toBeGreaterThan(body.indexOf("## User"))
          expect(body.indexOf("a1-assistant-answer")).toBeGreaterThan(body.indexOf("q1-user-question"))

          // Separators: one header rule + one per message (2 messages) = 3.
          const sepCount = body.split("---\n").length - 1
          expect(sepCount).toBe(3)

          await Session.remove(session.id)
        },
      }),
    )
  })
})
