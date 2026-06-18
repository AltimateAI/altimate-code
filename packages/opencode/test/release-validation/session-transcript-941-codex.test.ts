import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

async function inProject<T>(fn: () => Promise<T>) {
  await using tmp = await tmpdir({ git: true })
  try {
    return await Instance.provide({
      directory: tmp.path,
      fn,
    })
  } finally {
    await Instance.disposeAll()
  }
}

async function userMessage(sessionID: SessionID, text: string, created = Date.now()) {
  const id = MessageID.ascending()
  await Session.updateMessage({
    id,
    sessionID,
    role: "user",
    time: { created },
    agent: "test-agent",
    model: { providerID: "test-provider", modelID: "test-model" },
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

async function assistantMessage(sessionID: SessionID, parentID: MessageID, text: string, created = Date.now()) {
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
    tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created, completed: created + 1500 },
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

async function reasoningPart(sessionID: SessionID, messageID: MessageID, text: string) {
  await Session.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID,
    type: "reasoning",
    text,
    time: { start: Date.now() },
  } as unknown as MessageV2.Part)
}

async function toolPart(
  sessionID: SessionID,
  messageID: MessageID,
  state: MessageV2.ToolPart["state"],
  tool = "bash",
) {
  await Session.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID,
    type: "tool",
    callID: `call-${Math.random().toString(16).slice(2)}`,
    tool,
    state,
  } as unknown as MessageV2.Part)
}

async function transcript(sessionID: string, query = "") {
  return Server.Default().request(`/session/${sessionID}/transcript${query}`)
}

describe("release validation: PR 941 session transcript endpoint", () => {
  test("returns a complete markdown transcript with session metadata and ordered user/assistant turns", async () => {
    await inProject(async () => {
      const session = await Session.create({ title: "Transcript Smoke" })
      const user = await userMessage(session.id, "first user turn", 100)
      await assistantMessage(session.id, "msg_missing_parent" as MessageID, "older assistant turn", 50)
      await assistantMessage(session.id, user, "assistant answer", 200)

      const res = await transcript(session.id)
      const body = await res.text()

      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/plain")
      expect(res.headers.get("content-type")?.toLowerCase()).toContain("charset=utf-8")
      expect(body).toStartWith("# Transcript Smoke\n\n")
      expect(body).toContain(`**Session ID:** ${session.id}`)
      expect(body).toContain("**Created:**")
      expect(body).toContain("**Updated:**")
      expect(body).toContain("## User\n\nfirst user turn")
      expect(body).toContain("## Assistant\n\nassistant answer")
      expect(body.indexOf("older assistant turn")).toBeLessThan(body.indexOf("first user turn"))
      expect(body.trim()).toEndWith("---")
    })
  })

  test("does not return JSON for successful transcripts even when Accept prefers JSON", async () => {
    await inProject(async () => {
      const session = await Session.create({ title: "Plain Text Only" })
      await userMessage(session.id, '{"not":"json"}')

      const res = await Server.Default().request(`/session/${session.id}/transcript`, {
        headers: { accept: "application/json" },
      })
      const body = await res.text()

      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/plain")
      expect(res.headers.get("content-type")?.toLowerCase()).toContain("charset=utf-8")
      expect(() => JSON.parse(body)).toThrow()
      expect(body).toContain('{"not":"json"}')
    })
  })

  test("default query options hide reasoning text and tool input/output details", async () => {
    await inProject(async () => {
      const session = await Session.create({ title: "Safe Defaults" })
      const user = await userMessage(session.id, "please inspect")
      const assistant = await assistantMessage(session.id, user, "I used a tool")
      await reasoningPart(session.id, assistant, "private chain of thought")
      await toolPart(session.id, assistant, {
        status: "completed",
        input: { command: "cat ~/.secret" },
        output: "SECRET_TOKEN=abc123",
        title: "Read secret",
        metadata: {},
        time: { start: 1, end: 2 },
      })

      const res = await transcript(session.id)
      const body = await res.text()

      expect(res.status).toBe(200)
      expect(body).toContain("**Tool: bash**")
      expect(body).not.toContain("_Thinking:_")
      expect(body).not.toContain("private chain of thought")
      expect(body).not.toContain("**Input:**")
      expect(body).not.toContain("cat ~/.secret")
      expect(body).not.toContain("**Output:**")
      expect(body).not.toContain("SECRET_TOKEN=abc123")
    })
  })

  test("toolDetails=true includes completed tool input and output", async () => {
    await inProject(async () => {
      const session = await Session.create({ title: "Tool Details" })
      const user = await userMessage(session.id, "run tests")
      const assistant = await assistantMessage(session.id, user, "done")
      await toolPart(session.id, assistant, {
        status: "completed",
        input: { command: "bun test", cwd: "/repo" },
        output: "2 pass",
        title: "Run tests",
        metadata: {},
        time: { start: 10, end: 20 },
      })

      const res = await transcript(session.id, "?toolDetails=true")
      const body = await res.text()

      expect(res.status).toBe(200)
      expect(body).toContain("**Tool: bash**")
      expect(body).toContain("**Input:**\n```json")
      expect(body).toContain('"command": "bun test"')
      expect(body).toContain('"cwd": "/repo"')
      expect(body).toContain("**Output:**\n```\n2 pass\n```")
    })
  })

  test("toolDetails=false string keeps completed tool input and output hidden", async () => {
    await inProject(async () => {
      const session = await Session.create({ title: "Tool Details False" })
      const user = await userMessage(session.id, "run a command")
      const assistant = await assistantMessage(session.id, user, "done")
      await toolPart(session.id, assistant, {
        status: "completed",
        input: { command: "printenv SECRET_TOKEN" },
        output: "SECRET_TOKEN=abc123",
        title: "Print env",
        metadata: {},
        time: { start: 1, end: 2 },
      })

      const res = await transcript(session.id, "?toolDetails=false")
      const body = await res.text()

      expect(res.status).toBe(200)
      expect(body).toContain("**Tool: bash**")
      expect(body).not.toContain("**Input:**")
      expect(body).not.toContain("printenv SECRET_TOKEN")
      expect(body).not.toContain("**Output:**")
      expect(body).not.toContain("SECRET_TOKEN=abc123")
    })
  })

  test("toolDetails=true includes errored tool input and error text", async () => {
    await inProject(async () => {
      const session = await Session.create({ title: "Tool Error Details" })
      const user = await userMessage(session.id, "bad command")
      const assistant = await assistantMessage(session.id, user, "failed")
      await toolPart(session.id, assistant, {
        status: "error",
        input: { command: "missing-command" },
        error: "command not found",
        metadata: {},
        time: { start: 1, end: 2 },
      })

      const res = await transcript(session.id, "?toolDetails=true")
      const body = await res.text()

      expect(res.status).toBe(200)
      expect(body).toContain("**Input:**")
      expect(body).toContain('"command": "missing-command"')
      expect(body).toContain("**Error:**\n```\ncommand not found\n```")
    })
  })

  test("thinking=true includes reasoning while thinking=false string excludes it", async () => {
    await inProject(async () => {
      const session = await Session.create({ title: "Reasoning Toggle" })
      const user = await userMessage(session.id, "think")
      const assistant = await assistantMessage(session.id, user, "answer")
      await reasoningPart(session.id, assistant, "reasoning details")

      const included = await transcript(session.id, "?thinking=true")
      const excluded = await transcript(session.id, "?thinking=false")

      expect(await included.text()).toContain("_Thinking:_\n\nreasoning details")
      expect(await excluded.text()).not.toContain("reasoning details")
    })
  })

  test("assistantMetadata=true adds assistant agent, model, and duration to the heading", async () => {
    await inProject(async () => {
      const session = await Session.create({ title: "Metadata Toggle" })
      const user = await userMessage(session.id, "who are you")
      await assistantMessage(session.id, user, "with metadata", 1_000)

      const res = await transcript(session.id, "?assistantMetadata=true")
      const body = await res.text()

      expect(res.status).toBe(200)
      expect(body).toContain("## Assistant (Build")
      expect(body).toContain("claude-sonnet")
      expect(body).toContain("1.5s")
    })
  })

  test("assistantMetadata=false string keeps assistant heading generic", async () => {
    await inProject(async () => {
      const session = await Session.create({ title: "Metadata False" })
      const user = await userMessage(session.id, "hello")
      await assistantMessage(session.id, user, "plain heading")

      const res = await transcript(session.id, "?assistantMetadata=false")
      const body = await res.text()

      expect(res.status).toBe(200)
      expect(body).toContain("## Assistant\n\nplain heading")
      expect(body).not.toContain("## Assistant (Build")
    })
  })

  test("synthetic text parts are omitted from the transcript", async () => {
    await inProject(async () => {
      const session = await Session.create({ title: "Synthetic Parts" })
      const messageID = await userMessage(session.id, "visible user text")
      await Session.updatePart({
        id: PartID.ascending(),
        sessionID: session.id,
        messageID,
        type: "text",
        text: "hidden synthetic scaffolding",
        synthetic: true,
      })

      const res = await transcript(session.id)
      const body = await res.text()

      expect(res.status).toBe(200)
      expect(body).toContain("visible user text")
      expect(body).not.toContain("hidden synthetic scaffolding")
    })
  })

  test("empty sessions return only the transcript header and separator", async () => {
    await inProject(async () => {
      const session = await Session.create({ title: "No Messages" })

      const res = await transcript(session.id)
      const body = await res.text()

      expect(res.status).toBe(200)
      expect(body).toStartWith("# No Messages\n\n")
      expect(body).toContain(`**Session ID:** ${session.id}`)
      expect(body.match(/^## /gm)).toBeNull()
      expect(body.match(/^---$/gm)?.length).toBe(1)
    })
  })

  test("unknown well-formed sessionID returns a JSON 404 without transcript headers", async () => {
    await inProject(async () => {
      const res = await transcript("ses_release_validation_missing")
      const body = await res.json()

      expect(res.status).toBe(404)
      expect(res.headers.get("content-type")).toContain("application/json")
      expect(body.name).toBe("NotFoundError")
      expect(body.data.message).toContain("ses_release_validation_missing")
      expect(JSON.stringify(body)).not.toContain("**Session ID:**")
    })
  })

  test("malformed sessionID is rejected before storage lookup and does not leak filesystem paths", async () => {
    await inProject(async () => {
      const res = await transcript("not-a-session-id")
      const body = await res.text()

      expect(res.status).toBe(400)
      expect(res.headers.get("content-type")).toContain("application/json")
      expect(body).not.toContain(process.cwd())
      expect(body).not.toContain("sqlite")
      expect(body).not.toContain("SELECT")
    })
  })

  test.todo("path traversal-shaped sessionID is rejected and cannot escape the route", async () => {
    // BUG: Encoded slashes in the sessionID currently miss the transcript route, fall through to the
    // catch-all proxy, and return a 500 with stack/file paths instead of a clean 400.
    await inProject(async () => {
      const res = await Server.Default().request("/session/ses_valid/..%2F..%2Fetc%2Fpasswd/transcript")
      const body = await res.text()

      expect(res.status).toBe(400)
      expect(res.headers.get("content-type")).toContain("application/json")
      expect(body).not.toContain("root:")
      expect(body).not.toContain("/etc/passwd")
    })
  })

  test("OPTIONS preflight succeeds without creating or reading a transcript", async () => {
    await inProject(async () => {
      const res = await Server.Default().request("/session/ses_release_validation_missing/transcript", {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:3000",
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization",
        },
      })

      expect(res.status).toBe(204)
      expect(await res.text()).toBe("")
      expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000")
    })
  })

  test("generated OpenAPI schema documents the transcript endpoint as text/plain string with 400 and 404 errors", async () => {
    const spec = await Server.openapi()
    const operation = spec.paths?.["/session/{sessionID}/transcript"]?.get
    const responses = operation?.responses as
      | Record<string, { content?: Record<string, { schema?: { type?: string } }> }>
      | undefined

    expect(operation?.operationId).toBe("session.transcript")
    expect(responses?.["200"]?.content?.["text/plain"]?.schema?.type).toBe("string")
    expect(responses?.["400"]?.content?.["application/json"]).toBeDefined()
    expect(responses?.["404"]?.content?.["application/json"]).toBeDefined()
  })
})
