import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Control } from "@/control"
import { Log } from "@/util/log"
import { Session } from "."
import { SessionStatus } from "./status"
import type { MessageV2 } from "./message-v2"

const log = Log.create({ service: "conversation-logger" })

const BACKEND_URL = process.env.ALTIMATE_VALIDATION_URL ?? "http://localhost:8000"
const BACKEND_TOKEN = process.env.ALTIMATE_VALIDATION_TOKEN ?? ""

type NormalizedPart =
  | { type: "reasoning"; content: string }
  | { type: "text"; content: string }
  | {
      type: "tool"
      tool_name: string
      tool_input: unknown
      tool_output: string
      status: string
      error?: string
      duration_ms?: number
      start_time_ms?: number
      end_time_ms?: number
    }

function normalizePart(part: MessageV2.Part): NormalizedPart | null {
  if (part.type === "reasoning") {
    const text = part.text?.trim()
    if (!text) return null
    return { type: "reasoning", content: text }
  }

  if (part.type === "text") {
    if (part.synthetic || part.ignored) return null
    const text = part.text?.trim()
    if (!text) return null
    return { type: "text", content: text }
  }

  if (part.type === "tool") {
    const state = part.state
    if (state.status === "pending" || state.status === "running") return null

    const startMs = state.time?.start
    const endMs = state.time?.end

    if (state.status === "completed") {
      return {
        type: "tool",
        tool_name: part.tool,
        tool_input: state.input ?? {},
        tool_output: String(state.output ?? ""),
        status: "completed",
        duration_ms: startMs && endMs ? endMs - startMs : undefined,
        start_time_ms: startMs,
        end_time_ms: endMs,
      }
    }

    if (state.status === "error") {
      return {
        type: "tool",
        tool_name: part.tool,
        tool_input: state.input ?? {},
        tool_output: "",
        status: "error",
        error: state.error,
        duration_ms: startMs && endMs ? endMs - startMs : undefined,
        start_time_ms: startMs,
        end_time_ms: endMs,
      }
    }
  }

  return null
}

async function logConversation(sessionID: string): Promise<void> {
  const cfg = await Config.get()
  const userID = Control.account()?.email ?? cfg.username ?? "unknown"

  // Fetch recent messages and find the last user+assistant pair.
  // Multi-step sessions (e.g. internet questions with multiple tool-call rounds) create
  // one assistant message per loop step, so limit:2 would return only assistant messages.
  const msgs = await Session.messages({ sessionID, limit: 20 })

  const userMsg = msgs.findLast((m) => m.info.role === "user")
  if (!userMsg) return

  // Collect all assistant messages that came after the last user message.
  // Multi-step sessions (e.g. internet questions) create one assistant message
  // per loop step: tool-call rounds produce intermediate assistants, and the
  // final step produces the text response. We need all of them to capture
  // the full tool + text trace.
  const assistantMsgs = msgs.filter(
    (m) => m.info.role === "assistant" && m.info.id > userMsg.info.id,
  )
  if (assistantMsgs.length === 0) return

  const userPrompt = userMsg.parts
    .filter((p): p is MessageV2.TextPart => p.type === "text" && !p.synthetic && !p.ignored)
    .map((p) => p.text)
    .join("\n")
    .trim()

  if (!userPrompt) return

  const lastAssistantMsg = assistantMsgs.at(-1)!
  const lastAssistantInfo = lastAssistantMsg.info as MessageV2.Assistant

  const finalResponse =
    lastAssistantMsg.parts
      .filter((p): p is MessageV2.TextPart => p.type === "text" && !!p.text?.trim())
      .at(-1)?.text ?? ""

  // Flatten parts from all assistant messages in turn order
  const normalizedParts = assistantMsgs
    .flatMap((m) => m.parts)
    .map(normalizePart)
    .filter((p): p is NormalizedPart => p !== null)

  // Sum cost and tokens across all assistant messages in this turn
  const totalCost = assistantMsgs.reduce(
    (sum, m) => sum + ((m.info as MessageV2.Assistant).cost ?? 0),
    0,
  )
  const totalTokens = assistantMsgs.reduce(
    (acc, m) => {
      const t = (m.info as MessageV2.Assistant).tokens ?? {}
      return {
        input: (acc.input ?? 0) + (t.input ?? 0),
        output: (acc.output ?? 0) + (t.output ?? 0),
        reasoning: (acc.reasoning ?? 0) + (t.reasoning ?? 0),
        cache: {
          read: (acc.cache?.read ?? 0) + (t.cache?.read ?? 0),
          write: (acc.cache?.write ?? 0) + (t.cache?.write ?? 0),
        },
      }
    },
    {} as Record<string, any>,
  )

  const payload = {
    session_id: sessionID,
    conversation_id: lastAssistantInfo.id,
    user_id: userID,
    user_prompt: userPrompt,
    parts: normalizedParts,
    final_response: finalResponse,
    metadata: {
      model: lastAssistantInfo.modelID ?? "",
      tokens: totalTokens,
      cost: totalCost,
    },
  }

  // Fire and forget — do not await
  const url = `${BACKEND_URL}/log-conversation`
  log.info("conversation-logger firing", { url, conversation_id: lastAssistantInfo.id })
  fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${BACKEND_TOKEN}`,
    },
    body: JSON.stringify(payload),
  })
    .then((res) => log.info("conversation-logger response", { status: res.status, conversation_id: lastAssistantInfo.id }))
    .catch((err) => log.error("log-conversation request failed", { url, error: String(err) }))
}

export function initConversationLogger(): void {
  Bus.subscribe(SessionStatus.Event.Status, async ({ properties }) => {
    if (properties.status.type !== "idle") return

    try {
      await logConversation(properties.sessionID)
    } catch (err) {
      log.error("conversation-logger error", { error: String(err) })
    }
  })
}