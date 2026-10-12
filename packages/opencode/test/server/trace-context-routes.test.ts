/**
 * The prompt routes bind the client's `traceparent` to the user message of the turn they start
 * (creating its id when the client did not send one) and hand that id on to the prompt.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID } from "../../src/session/schema"
import { TraceContext } from "../../src/altimate/observability/trace-context"
import { tmpdir } from "../fixture/fixture"

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c"
const TRACEPARENT = `00-${TRACE_ID}-b7ad6b7169203331-01`

describe("prompt routes bind the client trace to the turn", () => {
  let restore: (() => void) | undefined
  afterEach(() => restore?.())

  async function post(path: (sessionID: string) => string, body: Record<string, unknown>, traceparent?: string) {
    let received: { messageID?: string } | undefined
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (input: { messageID?: string }) => {
      received = input
      return { info: { id: input.messageID }, parts: [] }
    }) as unknown as typeof SessionPrompt.prompt)
    restore = () => prompt.mockRestore()
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "trace routes" })
        const response = await Server.Default().request(path(session.id), {
          method: "POST",
          headers: { "content-type": "application/json", ...(traceparent && { traceparent }) },
          body: JSON.stringify(body),
        })
        await response.text()
        // prompt_async hands off without awaiting; give it a tick.
        await new Promise((resolve) => setTimeout(resolve, 20))
      },
    })
    return received
  }

  const parts = [{ type: "text", text: "hello" }]

  test("prompt_async creates the turn's message id and binds the trace to it", async () => {
    const input = await post((id) => `/session/${id}/prompt_async`, { parts }, TRACEPARENT)
    expect(input?.messageID).toBeDefined()
    expect(TraceContext.traceId(input!.messageID!)).toBe(TRACE_ID)
  })

  test("a client-supplied message id is the one bound", async () => {
    const messageID = MessageID.ascending()
    const input = await post((id) => `/session/${id}/message`, { parts, messageID }, TRACEPARENT)
    expect(input?.messageID).toBe(messageID)
    expect(TraceContext.traceId(messageID)).toBe(TRACE_ID)
  })

  test("a prompt without traceparent binds nothing", async () => {
    const input = await post((id) => `/session/${id}/prompt_async`, { parts })
    expect(input?.messageID).toBeDefined()
    expect(TraceContext.traceId(input!.messageID!)).toBeUndefined()
  })
})
