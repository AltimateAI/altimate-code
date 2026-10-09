// Auto Mode client routing signals.
//
// The altimate-backend gateway reads `extra_body.routing` and escalates one tier
// on error recovery. The signals are schema-free hints derived from the message
// history the request already carries; any datum that cannot be determined is
// omitted so the backend falls back to its own heuristics.
//
// Transport: @ai-sdk/openai-compatible spreads `providerOptions[<provider name>]`
// into the top-level POST body (minus its own typed keys), so
// `providerOptions["altimate-backend"].extra_body = { routing }` is sent as a
// literal top-level `extra_body` field.
import type { ModelMessage } from "ai"

export namespace RoutingSignals {
  export const PROVIDER_ID = "altimate-backend"
  const TIERS = ["auto", "fast", "max"] as const
  const ROLES = ["plan", "build"] as const
  // Only the tail of the conversation reflects the current state of the turn.
  const RECENT_MESSAGES = 6
  const ERROR_PATTERN = /\b(error|exception|traceback|stack trace|failed|failure|panic)\b/i
  const CODE_FENCE = /```/
  const CODE_TOOLS = new Set(["read", "edit", "write", "patch", "multiedit", "apply_patch"])

  export type Routing = {
    tier?: (typeof TIERS)[number]
    last_tool_ok?: boolean
    retry_count?: number
    has_error_ctx?: boolean
    has_code_ctx?: boolean
    agent_role?: (typeof ROLES)[number]
  }

  type ToolResult = { toolName?: string; output?: { type?: string; value?: unknown } }

  export type Input = {
    providerID: string
    modelID: string
    agentName?: string
    messages: ModelMessage[]
  }

  function tierOf(modelID: string): Routing["tier"] {
    const tier = modelID.startsWith("altimate-") ? modelID.slice("altimate-".length) : undefined
    return TIERS.find((t) => t === tier)
  }

  function toolResults(msg: ModelMessage): ToolResult[] {
    if (msg.role !== "tool" || !Array.isArray(msg.content)) return []
    return (msg.content as unknown as Array<{ type?: string }>).filter((p) => p?.type === "tool-result") as ToolResult[]
  }

  const failed = (r: ToolResult) => r.output?.type === "error-text" || r.output?.type === "error-json"

  function textOf(msg: ModelMessage): string {
    if (typeof msg.content === "string") return msg.content
    if (!Array.isArray(msg.content)) return ""
    return (msg.content as unknown as Array<Record<string, any>>)
      .map((p) => {
        if (typeof p?.text === "string") return p.text
        const v = p?.output?.value
        return typeof v === "string" ? v : ""
      })
      .join("\n")
  }

  export function compute(input: Input): Routing | undefined {
    if (input.providerID !== PROVIDER_ID) return undefined
    const routing: Routing = {}
    const tier = tierOf(input.modelID)
    if (tier) routing.tier = tier
    const role = ROLES.find((r) => r === input.agentName)
    if (role) routing.agent_role = role

    const results = input.messages.flatMap(toolResults)
    const last = results[results.length - 1]
    if (last) {
      routing.last_tool_ok = !failed(last)
      let streak = 0
      for (let i = results.length - 1; i >= 0 && failed(results[i]); i--) streak++
      routing.retry_count = streak
    }

    const recent = input.messages.slice(-RECENT_MESSAGES)
    if (recent.length > 0) {
      routing.has_error_ctx = recent.some(
        (m) => toolResults(m).some(failed) || (m.role === "tool" && ERROR_PATTERN.test(textOf(m))),
      )
      routing.has_code_ctx = recent.some(
        (m) => CODE_FENCE.test(textOf(m)) || toolResults(m).some((r) => CODE_TOOLS.has(String(r.toolName))),
      )
    }
    return routing
  }

  /** Merge routing signals into the provider options for altimate-backend; identity for other providers. */
  export function attach(options: Record<string, any>, input: Input): Record<string, any> {
    try {
      const routing = compute(input)
      if (!routing || Object.keys(routing).length === 0) return options
      const existing = options[PROVIDER_ID] ?? {}
      return {
        ...options,
        [PROVIDER_ID]: { ...existing, extra_body: { ...existing.extra_body, routing } },
      }
    } catch {
      return options
    }
  }
}
