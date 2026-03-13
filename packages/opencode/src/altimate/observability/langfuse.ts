/**
 * Langfuse tracing for altimate CLI.
 *
 * Wraps the Langfuse JS SDK to create traces from CLI event stream data.
 * Activated when LANGFUSE_SECRET_KEY, LANGFUSE_PUBLIC_KEY, and LANGFUSE_BASE_URL
 * environment variables are set. No-op otherwise.
 */

import Langfuse from "langfuse"

export class LangfuseTracer {
  private client: InstanceType<typeof Langfuse>
  private baseUrl: string
  private traceId: string | undefined
  private trace: ReturnType<InstanceType<typeof Langfuse>["trace"]> | undefined
  private currentGeneration:
    | ReturnType<NonNullable<LangfuseTracer["trace"]>["generation"]>
    | undefined
  private generationText: string[] = []

  // Cumulative metrics
  private totalTokens = 0
  private totalCost = 0
  private toolCallCount = 0

  private constructor(client: InstanceType<typeof Langfuse>, baseUrl: string) {
    this.client = client
    this.baseUrl = baseUrl
  }

  /**
   * Create a tracer from environment variables.
   * Returns null if LANGFUSE_SECRET_KEY or LANGFUSE_PUBLIC_KEY are not set.
   */
  static fromEnv(): LangfuseTracer | null {
    const secretKey = process.env.LANGFUSE_SECRET_KEY
    const publicKey = process.env.LANGFUSE_PUBLIC_KEY
    const baseUrl = process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com"

    if (!secretKey || !publicKey) return null

    try {
      const client = new Langfuse({
        secretKey,
        publicKey,
        baseUrl,
      })
      return new LangfuseTracer(client, baseUrl)
    } catch {
      return null
    }
  }

  /**
   * Start a root trace for this session.
   */
  startTrace(
    sessionId: string,
    metadata: {
      instance_id?: string
      model?: string
      agent?: string
      prompt?: string
    },
  ) {
    try {
      this.trace = this.client.trace({
        name: metadata.instance_id || sessionId,
        sessionId,
        input: metadata.prompt,
        metadata: {
          ...metadata,
          timestamp: new Date().toISOString(),
        },
      })
      this.traceId = this.trace.id
    } catch {
      // Silently ignore — tracing is best-effort
    }
  }

  /**
   * Open a generation span from a step-start event.
   */
  logStepStart(part: { id: string }) {
    if (!this.trace) return
    try {
      this.generationText = []
      this.currentGeneration = this.trace.generation({
        name: `generation-${part.id}`,
        startTime: new Date(),
      })
    } catch {
      // best-effort
    }
  }

  /**
   * Close the current generation span with token/cost data from step-finish.
   */
  logStepFinish(part: {
    id: string
    reason: string
    cost: number
    tokens: {
      input: number
      output: number
      reasoning: number
      cache: { read: number; write: number }
    }
  }) {
    if (!this.currentGeneration) return
    try {
      const usage = {
        input: part.tokens.input,
        output: part.tokens.output,
        total:
          part.tokens.input +
          part.tokens.output +
          part.tokens.reasoning +
          part.tokens.cache.read +
          part.tokens.cache.write,
      }

      this.totalTokens += usage.total
      this.totalCost += part.cost

      this.currentGeneration.update({
        endTime: new Date(),
        output: this.generationText.join(""),
        usage,
        metadata: {
          reason: part.reason,
          cost: part.cost,
          tokens_reasoning: part.tokens.reasoning,
          tokens_cache_read: part.tokens.cache.read,
          tokens_cache_write: part.tokens.cache.write,
        },
      })
      this.currentGeneration.end()
      this.currentGeneration = undefined
    } catch {
      // best-effort
    }
  }

  /**
   * Log a completed or errored tool call.
   */
  logToolCall(part: {
    tool: string
    callID: string
    state:
      | {
          status: "completed"
          input: Record<string, unknown>
          output: string
          time: { start: number; end: number }
        }
      | {
          status: "error"
          input: Record<string, unknown>
          error: string
          time: { start: number; end: number }
        }
  }) {
    if (!this.trace) return
    try {
      this.toolCallCount++
      const startTime = new Date(part.state.time.start)
      const endTime = new Date(part.state.time.end)
      const state = part.state
      const isError = state.status === "error"

      this.trace.span({
        name: part.tool,
        startTime,
        endTime,
        input: state.input,
        output: isError ? { error: state.error } : state.output,
        metadata: {
          callID: part.callID,
          status: part.state.status,
          duration_ms: part.state.time.end - part.state.time.start,
        },
        level: isError ? "ERROR" : "DEFAULT",
      })
    } catch {
      // best-effort
    }
  }

  /**
   * Attach assistant text to the current generation.
   */
  logText(part: { text: string }) {
    this.generationText.push(part.text)
  }

  /**
   * Finalize the trace, flush, and return the trace URL.
   */
  async endTrace(error?: string): Promise<string | undefined> {
    if (!this.trace) return undefined
    try {
      this.trace.update({
        output: {
          total_tool_calls: this.toolCallCount,
          total_tokens: this.totalTokens,
          total_cost: this.totalCost,
          ...(error ? { error } : {}),
        },
        metadata: {
          completed_at: new Date().toISOString(),
          status: error ? "error" : "completed",
        },
      })

      await this.client.flushAsync()
    } catch {
      // best-effort
    }
    return this.getTraceUrl()
  }

  /**
   * Get the URL for this trace in the Langfuse dashboard.
   */
  getTraceUrl(): string | undefined {
    if (!this.traceId) return undefined
    return `${this.baseUrl}/trace/${this.traceId}`
  }
}
