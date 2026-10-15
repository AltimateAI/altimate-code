import { Plugin } from "@opencode/plugin"

export type GenerationTelemetry = {
  type: "generation"
  timestamp: number
  session_id: string
  message_id: string
  model_id: string
  provider_id: string
  agent: string
  finish_reason: string
  raw_finish_reason?: string
  outcome: "completed" | "error" | "interrupted"
  duration_ms: number
  cost?: number
  tokens_input?: number
  tokens_input_total?: number
  tokens_output?: number
  tokens_visible_output?: number
  tokens_reasoning?: number
  tokens_cache_read?: number
  tokens_cache_write?: number
}

export type ToolTelemetry = {
  type: "tool_call"
  timestamp: number
  session_id: string
  message_id: string
  tool_call_id: string
  tool_name: string
  duration_ms: number
  status: "success" | "error" | "interrupted"
  after_hook?: "completed" | "error"
  error?: string
}

export type TelemetryRecord = GenerationTelemetry | ToolTelemetry

/** The caller owns export policy; this slice neither transmits nor persists records. */
export function telemetry(exportRecord: (record: TelemetryRecord) => void) {
  return Plugin.define({
    id: "altimate-telemetry",
    async setup(ctx) {
      const steps = new Map<
        string,
        {
          model: { providerID: string; id: string }
          agent: string
          started: number
          streamed?: number
        }
      >()
      const tools = new Map<
        string,
        {
          name: string
          started: number
          after?: "completed" | "error"
        }
      >()
      const controller = new AbortController()
      const consume = (async () => {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.location?.directory !== ctx.location.directory) continue
          if (event.type === "session.step.started") {
            steps.set(`${event.data.sessionID}:${event.data.assistantMessageID}`, {
              model: event.data.model,
              agent: event.data.agent,
              started: event.data.started,
            })
          }
          if (event.type === "session.step.streamed") {
            const step = steps.get(`${event.data.sessionID}:${event.data.assistantMessageID}`)
            if (step) step.streamed = event.created
          }
          if (event.type === "session.step.ended" || event.type === "session.step.failed") {
            const key = `${event.data.sessionID}:${event.data.assistantMessageID}`
            const step = steps.get(key)
            if (!step) continue
            steps.delete(key)
            const tokens = event.data.tokens
            exportRecord({
              type: "generation",
              timestamp: event.created,
              session_id: event.data.sessionID,
              message_id: event.data.assistantMessageID,
              model_id: step.model.id,
              provider_id: step.model.providerID,
              agent: step.agent,
              finish_reason: event.data.finish ?? "error",
              raw_finish_reason: event.data.rawFinish,
              outcome:
                event.type === "session.step.ended"
                  ? "completed"
                  : event.data.error.type === "aborted"
                    ? "interrupted"
                    : "error",
              // Model duration stops at the response-body boundary, before tool settlement.
              duration_ms: (step.streamed ?? event.created) - step.started,
              cost: event.data.cost,
              ...(tokens
                ? {
                    tokens_input: tokens.input,
                    tokens_input_total: tokens.input + tokens.cache.read + tokens.cache.write,
                    // v1's output counter includes reasoning; v2 separates visible output.
                    tokens_output: tokens.output + tokens.reasoning,
                    tokens_visible_output: tokens.output,
                    tokens_reasoning: tokens.reasoning,
                    tokens_cache_read: tokens.cache.read,
                    tokens_cache_write: tokens.cache.write,
                  }
                : {}),
            })
          }
          if (event.type === "session.tool.success" || event.type === "session.tool.failed") {
            const key = `${event.data.sessionID}:${event.data.assistantMessageID}:${event.data.id}`
            const tool = tools.get(key)
            if (!tool) continue
            tools.delete(key)
            exportRecord({
              type: "tool_call",
              timestamp: event.created,
              session_id: event.data.sessionID,
              message_id: event.data.assistantMessageID,
              tool_call_id: event.data.id,
              tool_name: tool.name,
              duration_ms: event.created - tool.started,
              status:
                event.type === "session.tool.success"
                  ? "success"
                  : event.data.error.type === "aborted"
                    ? "interrupted"
                    : "error",
              after_hook: tool.after,
              ...(event.type === "session.tool.failed" ? { error: event.data.error.message } : {}),
            })
          }
        }
      })()
      await ctx.tool.hook("execute.before", (event) => {
        const key = `${event.sessionID}:${event.messageID}:${event.id}`
        // Code Mode inner calls reuse the outer execute call ID and have no independent terminal event.
        if (!tools.has(key)) tools.set(key, { name: event.tool, started: Date.now() })
      })
      await ctx.tool.hook("execute.after", (event) => {
        const tool = tools.get(`${event.sessionID}:${event.messageID}:${event.id}`)
        if (tool?.name === event.tool) tool.after = event.status
      })
      return async () => {
        controller.abort()
        await consume
        steps.clear()
        tools.clear()
      }
    },
  })
}

export function memoryTelemetry() {
  const records: TelemetryRecord[] = []
  return { records, plugin: telemetry((record) => records.push(record)) }
}
