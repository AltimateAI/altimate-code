export * as ClaudeAgentError from "./claude-agent-error"

import { APICallError } from "@ai-sdk/provider"
import type { SDKAssistantMessageError, SDKMessage, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk"

// Keep request-local diagnostics until the terminal result. A usage warning alone
// is not a failed request, and Claude Code owns any retries before this result.
export function make() {
  let code: SDKAssistantMessageError | undefined
  let rejected: SDKRateLimitInfo | undefined
  return (message: SDKMessage): Error | undefined => {
    if (message.type === "rate_limit_event") {
      rejected = message.rate_limit_info.status === "rejected" ? message.rate_limit_info : undefined
    }
    if (message.type === "assistant" && message.parent_tool_use_id === null && message.error) code = message.error
    if (message.type !== "result") return

    const status = message.subtype === "success" ? (message.api_error_status ?? undefined) : undefined
    const httpError = status !== undefined && status >= 400
    if (message.subtype === "success" && !message.is_error && !httpError) return
    const result = (message.subtype === "success" ? message.result : message.errors.join("\n")).replaceAll(
      "Please run /login",
      "Run `claude auth login` in a terminal",
    )
    const failure =
      status !== undefined && status >= 500
        ? (status === 529 ? "Anthropic is overloaded (529)." : `Anthropic returned HTTP ${status}.`) +
          " Claude Code exhausted its retries. Try again shortly."
        : result
    const limited = code === "rate_limit" || (rejected && status === 429)
    const window = rejected?.rateLimitType?.replaceAll("_", " ")
    const limit =
      limited && !failure ? `Claude Code subscription limit reached${window ? ` (${window})` : ""}.` : failure
    const reset = limited && rejected?.resetsAt ? ` Resets at ${new Date(rejected.resetsAt * 1000).toISOString()}.` : ""
    const billing = code === "billing_error" ? " Check your Claude plan and extra-usage settings." : ""
    const text = limit + reset + billing

    // altimate_change start — the shipped session compacts and retries only on an overflow-classified API
    // error; a plain Error becomes UnknownError and ends the chat. Claude Code's own compaction is off.
    if (message.terminal_reason === "prompt_too_long" || /prompt is too long/i.test(result)) {
      return new APICallError({
        message: /prompt is too long/i.test(text) ? text : `Prompt is too long. ${text}`.trim(),
        url: "claude-code://messages",
        requestBodyValues: {},
        statusCode: status,
        isRetryable: false,
      })
    }
    // altimate_change end

    if (text) return new Error(text)
    if (status) return new Error(`Claude Code could not finish its reply (HTTP ${status})`)
    return new Error("Claude Code could not finish its reply")
  }
}
