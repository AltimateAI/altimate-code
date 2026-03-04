import { Control } from "@/control"
import { Installation } from "@/installation"
import { Log } from "@/util/log"

const log = Log.create({ service: "telemetry" })

export namespace Telemetry {
  const FLUSH_INTERVAL_MS = 5_000
  const MAX_BUFFER_SIZE = 200
  const REQUEST_TIMEOUT_MS = 10_000

  export type TokensPayload = {
    input: number
    output: number
    reasoning: number
    cache_read: number
    cache_write: number
  }

  export type Event =
    | {
        type: "session_start"
        timestamp: number
        session_id: string
        model_id: string
        provider_id: string
        agent: string
        project_id: string
      }
    | {
        type: "session_end"
        timestamp: number
        session_id: string
        total_cost: number
        total_tokens: number
        tool_call_count: number
        duration_ms: number
      }
    | {
        type: "generation"
        timestamp: number
        session_id: string
        message_id: string
        model_id: string
        provider_id: string
        agent: string
        finish_reason: string
        tokens: TokensPayload
        cost: number
        duration_ms: number
      }
    | {
        type: "tool_call"
        timestamp: number
        session_id: string
        message_id: string
        tool_name: string
        tool_type: "standard" | "mcp"
        status: "success" | "error"
        duration_ms: number
        error?: string
      }
    | {
        type: "bridge_call"
        timestamp: number
        session_id: string
        method: string
        status: "success" | "error"
        duration_ms: number
        error?: string
      }
    | {
        type: "error"
        timestamp: number
        session_id: string
        error_name: string
        error_message: string
        context: string
      }
    | {
        type: "command"
        timestamp: number
        session_id: string
        command_name: string
        command_source: "command" | "mcp" | "skill" | "unknown"
        message_id: string
      }
    | {
        type: "context_overflow_recovered"
        timestamp: number
        session_id: string
        model_id: string
        provider_id: string
        tokens_used: number
      }
    | {
        type: "compaction_triggered"
        timestamp: number
        session_id: string
        trigger: "overflow_detection" | "error_recovery"
        attempt: number
      }
    | {
        type: "tool_outputs_pruned"
        timestamp: number
        session_id: string
        count: number
        tokens_pruned: number
      }

  type Batch = {
    session_id: string
    cli_version: string
    user_email: string
    project_id: string
    timestamp: number
    events: Event[]
  }

  let enabled = false
  let authenticated = false
  let buffer: Event[] = []
  let flushTimer: ReturnType<typeof setInterval> | undefined
  let accountUrl = ""
  let cachedToken = ""
  let userEmail = ""
  let sessionId = ""
  let projectId = ""

  export async function init() {
    if (enabled || flushTimer) return
    try {
      const account = Control.account()
      if (account) {
        const token = await Control.token()
        if (token) {
          accountUrl = account.url
          cachedToken = token
          userEmail = account.email
          authenticated = true
        }
      }

      // Fall back to env var for anonymous users
      if (!accountUrl) {
        const envUrl = process.env.ALTIMATE_TELEMETRY_URL
        if (!envUrl) {
          enabled = false
          return
        }
        accountUrl = envUrl
      }

      enabled = true

      const timer = setInterval(flush, FLUSH_INTERVAL_MS)
      if (typeof timer === "object" && timer && "unref" in timer) (timer as any).unref()
      flushTimer = timer

      log.info("telemetry initialized", { authenticated })
    } catch {
      enabled = false
    }
  }

  export function setContext(opts: { sessionId: string; projectId: string }) {
    sessionId = opts.sessionId
    projectId = opts.projectId
  }

  export function getContext() {
    return { sessionId, projectId }
  }

  export function track(event: Event) {
    if (!enabled) return
    buffer.push(event)
    if (buffer.length > MAX_BUFFER_SIZE) {
      buffer.shift()
    }
  }

  export async function flush() {
    if (!enabled || buffer.length === 0) return

    const events = buffer.splice(0, buffer.length)
    const batch: Batch = {
      session_id: sessionId,
      cli_version: Installation.VERSION,
      user_email: userEmail,
      project_id: projectId,
      timestamp: Date.now(),
      events,
    }

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" }
      if (authenticated && cachedToken) {
        headers["Authorization"] = `Bearer ${cachedToken}`
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

      const response = await fetch(`${accountUrl}/api/observability/ingest`, {
        method: "POST",
        headers,
        body: JSON.stringify(batch),
        signal: controller.signal,
      })
      clearTimeout(timeout)

      if (authenticated && response.status === 401) {
        const newToken = await Control.token()
        if (!newToken) return
        cachedToken = newToken
        const retryController = new AbortController()
        const retryTimeout = setTimeout(() => retryController.abort(), REQUEST_TIMEOUT_MS)
        await fetch(`${accountUrl}/api/observability/ingest`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cachedToken}`,
          },
          body: JSON.stringify(batch),
          signal: retryController.signal,
        })
        clearTimeout(retryTimeout)
      }
    } catch {
      // Silently drop on failure — telemetry must never break the CLI
    }
  }

  export async function shutdown() {
    if (flushTimer) {
      clearInterval(flushTimer)
      flushTimer = undefined
    }
    await flush()
    enabled = false
    authenticated = false
    buffer = []
    sessionId = ""
    projectId = ""
  }
}
