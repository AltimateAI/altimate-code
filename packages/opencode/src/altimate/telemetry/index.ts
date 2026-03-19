import { Account } from "@/account"
import { Config } from "@/config/config"
import { Installation } from "@/installation"
import { Log } from "@/util/log"
import { createHash, randomUUID } from "crypto"
import fs from "fs"
import path from "path"
import os from "os"

const log = Log.create({ service: "telemetry" })

export namespace Telemetry {
  const FLUSH_INTERVAL_MS = 5_000
  const MAX_BUFFER_SIZE = 200
  const REQUEST_TIMEOUT_MS = 10_000

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
        cost: number
        duration_ms: number
        // Flat token fields — only present when data is available from the provider.
        // No nested objects: Azure App Insights custom measures must be top-level numbers.
        tokens_input: number
        tokens_output: number
        tokens_reasoning?: number   // only for reasoning models
        tokens_cache_read?: number  // only when a cached prompt was reused
        tokens_cache_write?: number // only when a new cache entry was written
      }
    | {
        type: "tool_call"
        timestamp: number
        session_id: string
        message_id: string
        tool_name: string
        tool_type: "standard" | "mcp"
        tool_category: string
        status: "success" | "error"
        duration_ms: number
        sequence_index: number
        previous_tool: string | null
        input_signature?: string
        error?: string
      }
    | {
        type: "native_call"
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
    | {
        type: "auth_login"
        timestamp: number
        session_id: string
        provider_id: string
        method: "oauth" | "api_key"
        status: "success" | "error"
        error?: string
      }
    | {
        type: "auth_logout"
        timestamp: number
        session_id: string
        provider_id: string
      }
    | {
        type: "mcp_server_status"
        timestamp: number
        session_id: string
        server_name: string
        transport: "stdio" | "sse" | "streamable-http"
        status: "connected" | "disconnected" | "error"
        error?: string
        duration_ms?: number
      }
    | {
        type: "provider_error"
        timestamp: number
        session_id: string
        provider_id: string
        model_id: string
        error_type: string
        error_message: string
        http_status?: number
      }
    // DEPRECATED: Python engine eliminated. These event types are retained
    // for backward compatibility with existing telemetry dashboards but
    // are never fired by the native TypeScript implementation.
    | {
        type: "engine_started"
        timestamp: number
        session_id: string
        engine_version: string
        python_version: string
        extras?: string
        status: "started" | "restarted" | "upgraded"
        duration_ms: number
      }
    | {
        type: "engine_error"
        timestamp: number
        session_id: string
        phase: "uv_download" | "venv_create" | "pip_install" | "startup" | "runtime"
        error_message: string
      }
    | {
        type: "upgrade_attempted"
        timestamp: number
        session_id: string
        from_version: string
        to_version: string
        method: "npm" | "bun" | "brew" | "other"
        status: "success" | "error"
        error?: string
      }
    | {
        type: "session_forked"
        timestamp: number
        session_id: string
        parent_session_id: string
        message_count: number
      }
    | {
        type: "permission_denied"
        timestamp: number
        session_id: string
        tool_name: string
        tool_category: string
        source: "user" | "config_rule"
      }
    | {
        type: "doom_loop_detected"
        timestamp: number
        session_id: string
        tool_name: string
        repeat_count: number
      }
    | {
        type: "environment_census"
        timestamp: number
        session_id: string
        warehouse_types: string[]
        warehouse_count: number
        dbt_detected: boolean
        dbt_adapter: string | null
        dbt_model_count_bucket: string
        dbt_source_count_bucket: string
        dbt_test_count_bucket: string
        connection_sources: string[]
        mcp_server_count: number
        skill_count: number
        os: string
        feature_flags: string[]
      }
    | {
        type: "context_utilization"
        timestamp: number
        session_id: string
        model_id: string
        tokens_used: number
        context_limit: number
        utilization_pct: number
        generation_number: number
        cache_hit_ratio: number
      }
    | {
        type: "agent_outcome"
        timestamp: number
        session_id: string
        agent: string
        tool_calls: number
        generations: number
        duration_ms: number
        cost: number
        compactions: number
        outcome: "completed" | "abandoned" | "aborted" | "error"
      }
    | {
        type: "error_recovered"
        timestamp: number
        session_id: string
        error_type: string
        recovery_strategy: string
        attempts: number
        recovered: boolean
        duration_ms: number
      }
    | {
        type: "mcp_server_census"
        timestamp: number
        session_id: string
        server_name: string
        transport: "stdio" | "sse" | "streamable-http"
        tool_count: number
        resource_count: number
      }
    | {
        type: "mcp_discovery"
        timestamp: number
        session_id: string
        server_count: number
        server_names: string[]
        sources: string[]
      }
    | {
        type: "memory_operation"
        timestamp: number
        session_id: string
        operation: "write" | "delete"
        scope: "global" | "project"
        block_id: string
        is_update: boolean
        duplicate_count: number
        tags_count: number
      }
    | {
        type: "memory_injection"
        timestamp: number
        session_id: string
        block_count: number
        total_chars: number
        budget: number
        scopes_used: string[]
      }
    | {
        type: "warehouse_connect"
        timestamp: number
        session_id: string
        warehouse_type: string
        auth_method: string
        success: boolean
        duration_ms: number
        error?: string
        error_category?: string
      }
    | {
        type: "warehouse_query"
        timestamp: number
        session_id: string
        warehouse_type: string
        query_type: string
        success: boolean
        duration_ms: number
        row_count: number
        truncated: boolean
        error?: string
        error_category?: string
      }
    | {
        type: "warehouse_introspection"
        timestamp: number
        session_id: string
        warehouse_type: string
        operation: string
        success: boolean
        duration_ms: number
        result_count: number
        error?: string
      }
    | {
        type: "warehouse_discovery"
        timestamp: number
        session_id: string
        source: string
        connections_found: number
        warehouse_types: string[]
      }
    | {
        type: "warehouse_census"
        timestamp: number
        session_id: string
        total_connections: number
        warehouse_types: string[]
        connection_sources: string[]
        has_ssh_tunnel: boolean
        has_keychain: boolean
      }
    | {
        type: "skill_used"
        timestamp: number
        session_id: string
        message_id: string
        skill_name: string
        skill_source: "builtin" | "global" | "project"
        duration_ms: number
      }
    | {
        type: "sql_execute_failure"
        timestamp: number
        session_id: string
        warehouse_type: string
        query_type: string
        error_message: string
        masked_sql: string
        duration_ms: number
      }
    | {
        type: "core_failure"
        timestamp: number
        session_id: string
        tool_name: string
        tool_category: string
        error_class:
          | "parse_error"
          | "connection"
          | "timeout"
          | "validation"
          | "internal"
          | "permission"
          | "unknown"
        error_message: string
        input_signature: string
        masked_args?: string
        duration_ms: number
      }

  const ERROR_PATTERNS: Array<{
    class: Telemetry.Event & { type: "core_failure" } extends { error_class: infer C } ? C : never
    keywords: string[]
  }> = [
    { class: "parse_error", keywords: ["parse", "syntax", "binder", "unexpected token", "sqlglot"] },
    {
      class: "connection",
      keywords: ["econnrefused", "connection", "socket", "enotfound", "econnreset"],
    },
    { class: "timeout", keywords: ["timeout", "etimedout", "bridge timeout", "timed out"] },
    { class: "permission", keywords: ["permission", "denied", "unauthorized", "forbidden"] },
    { class: "validation", keywords: ["invalid params", "invalid", "missing", "required"] },
    { class: "internal", keywords: ["internal", "assertion"] },
  ]

  export function classifyError(
    message: string,
  ): Telemetry.Event & { type: "core_failure" } extends { error_class: infer C } ? C : never {
    const lower = message.toLowerCase()
    for (const { class: cls, keywords } of ERROR_PATTERNS) {
      if (keywords.some((kw) => lower.includes(kw))) return cls
    }
    return "unknown"
  }

  export function computeInputSignature(args: Record<string, unknown>): string {
    const sig: Record<string, string> = {}
    for (const [k, v] of Object.entries(args)) {
      if (v === null || v === undefined) {
        sig[k] = "null"
      } else if (typeof v === "string") {
        sig[k] = `string:${v.length}`
      } else if (typeof v === "number") {
        sig[k] = "number"
      } else if (typeof v === "boolean") {
        sig[k] = "boolean"
      } else if (Array.isArray(v)) {
        sig[k] = `array:${v.length}`
      } else if (typeof v === "object") {
        sig[k] = `object:${Object.keys(v).length}`
      } else {
        sig[k] = typeof v
      }
    }
    const result = JSON.stringify(sig)
    if (result.length <= 1000) return result
    // Drop keys from the end until the JSON fits, preserving valid JSON structure
    const keys = Object.keys(sig)
    while (keys.length > 0) {
      keys.pop()
      const truncated: Record<string, string> = {}
      for (const k of keys) truncated[k] = sig[k]
      truncated["..."] = `${Object.keys(sig).length - keys.length} more`
      const out = JSON.stringify(truncated)
      if (out.length <= 1000) return out
    }
    return JSON.stringify({ "...": `${Object.keys(sig).length} keys` })
  }

  // Mirrors altimate-sdk (Rust) SENSITIVE_KEYS — keep in sync.
  const SENSITIVE_KEYS: string[] = [
    "key", "api_key", "apikey", "apiKey", "token", "access_token", "refresh_token",
    "secret", "secret_key", "password", "passwd", "pwd",
    "credential", "credentials", "authorization", "auth",
    "signature", "sig", "private_key", "connection_string",
    // camelCase variants not caught by prefix/suffix matching
    "authtoken", "accesstoken", "refreshtoken", "bearertoken", "jwttoken",
    "jwtsecret", "clientsecret", "appsecret",
  ]

  function isSensitiveKey(key: string): boolean {
    const lower = key.toLowerCase()
    return SENSITIVE_KEYS.some(
      (k) => lower === k || lower.endsWith(`_${k}`) || lower.startsWith(`${k}_`),
    )
  }

  export function maskString(s: string): string {
    return s
      .replace(/'(?:[^'\\]|\\.)*'/g, "?")
      .replace(/"(?:[^"\\]|\\.)*"/g, "?")
      .replace(/\s+/g, " ")
      .trim()
  }

  function maskValue(value: unknown, key?: string): unknown {
    if (key && isSensitiveKey(key)) return "****"
    if (typeof value === "string") return maskString(value)
    if (Array.isArray(value)) return value.map((v) => maskValue(v, key))
    if (value !== null && typeof value === "object") {
      const masked: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        masked[k] = maskValue(v, k)
      }
      return masked
    }
    return value
  }

  /** PII-mask tool arguments for failure telemetry.
   *  Mirrors altimate-sdk mask_value: sensitive keys → "****",
   *  string literals in SQL → ?, whitespace collapsed. Truncates to 2000 chars. */
  export function maskArgs(args: Record<string, unknown>): string {
    const masked: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(args)) {
      masked[k] = maskValue(v, k)
    }
    const result = JSON.stringify(masked)
    if (result.length <= 2000) return result
    // Drop keys from the end until valid JSON fits, same approach as computeInputSignature
    const keys = Object.keys(masked)
    while (keys.length > 0) {
      keys.pop()
      const truncated: Record<string, unknown> = {}
      for (const k of keys) truncated[k] = masked[k]
      truncated["..."] = `${Object.keys(masked).length - keys.length} more`
      const out = JSON.stringify(truncated)
      if (out.length <= 2000) return out
    }
    return JSON.stringify({ "...": `${Object.keys(masked).length} keys` })
  }

  const FILE_TOOLS = new Set(["read", "write", "edit", "glob", "grep", "bash"])

  // Order matters: more specific patterns (e.g. "warehouse_usage") are checked
  // before broader ones (e.g. "warehouse") to avoid miscategorization.
  const CATEGORY_PATTERNS: Array<{ category: string; keywords: string[] }> = [
    { category: "finops", keywords: ["cost", "finops", "warehouse_usage"] },
    { category: "sql", keywords: ["sql", "query"] },
    { category: "schema", keywords: ["schema", "column", "table"] },
    { category: "dbt", keywords: ["dbt"] },
    { category: "warehouse", keywords: ["warehouse", "connection"] },
    { category: "lineage", keywords: ["lineage", "dag"] },
    { category: "memory", keywords: ["memory"] },
  ]

  export function categorizeToolName(name: string, type: "standard" | "mcp"): string {
    if (type === "mcp") return "mcp"
    const n = name.toLowerCase()
    if (FILE_TOOLS.has(n)) return "file"
    for (const { category, keywords } of CATEGORY_PATTERNS) {
      if (keywords.some((kw) => n.includes(kw))) return category
    }
    return "standard"
  }

  export function bucketCount(n: number): string {
    if (n <= 0) return "0"
    if (n <= 10) return "1-10"
    if (n <= 50) return "10-50"
    if (n <= 200) return "50-200"
    return "200+"
  }

  type AppInsightsConfig = {
    iKey: string
    endpoint: string // e.g. https://xxx.applicationinsights.azure.com/v2/track
  }

  let enabled = false
  let buffer: Event[] = []
  let flushTimer: ReturnType<typeof setInterval> | undefined
  let userEmail = ""
  let machineId = ""
  let sessionId = ""
  let projectId = ""
  let appInsights: AppInsightsConfig | undefined
  let droppedEvents = 0
  let initPromise: Promise<void> | undefined
  let initDone = false

  function parseConnectionString(cs: string): AppInsightsConfig | undefined {
    const parts: Record<string, string> = {}
    for (const segment of cs.split(";")) {
      const idx = segment.indexOf("=")
      if (idx === -1) continue
      parts[segment.slice(0, idx).trim()] = segment.slice(idx + 1).trim()
    }
    const iKey = parts["InstrumentationKey"]
    const ingestionEndpoint = parts["IngestionEndpoint"]
    if (!iKey || !ingestionEndpoint) return undefined
    const base = ingestionEndpoint.endsWith("/") ? ingestionEndpoint : ingestionEndpoint + "/"
    return { iKey, endpoint: `${base}v2/track` }
  }

  function toAppInsightsEnvelopes(events: Event[], cfg: AppInsightsConfig): object[] {
    return events.map((event) => {
      const { type, timestamp, ...fields } = event as any
      const sid: string = fields.session_id ?? sessionId

      const properties: Record<string, string> = {
        cli_version: Installation.VERSION,
        project_id: fields.project_id ?? projectId,
        ...(machineId && { machine_id: machineId }),
      }
      const measurements: Record<string, number> = {}

      for (const [k, v] of Object.entries(fields)) {
        if (k === "session_id" || k === "project_id" || k === "_retried") continue
        if (typeof v === "number") {
          measurements[k] = v
        } else if (v !== undefined && v !== null) {
          properties[k] = typeof v === "object" ? JSON.stringify(v) : String(v)
        }
      }

      return {
        name: `Microsoft.ApplicationInsights.${cfg.iKey}.Event`,
        time: new Date(timestamp).toISOString(),
        iKey: cfg.iKey,
        tags: {
          "ai.session.id": sid || "startup",
          "ai.user.id": userEmail,
          "ai.cloud.role": "altimate",
          "ai.application.ver": Installation.VERSION,
        },
        data: {
          baseType: "EventData",
          baseData: {
            ver: 2,
            name: type,
            properties,
            measurements,
          },
        },
      }
    })
  }

  // Instrumentation key is intentionally public — safe to hardcode in client-side tooling.
  // Override with APPLICATIONINSIGHTS_CONNECTION_STRING env var for local dev / testing.
  const DEFAULT_CONNECTION_STRING =
    "InstrumentationKey=5095f5e6-477e-4262-b7ae-2118de18550d;IngestionEndpoint=https://eastus-8.in.applicationinsights.azure.com/;LiveEndpoint=https://eastus.livediagnostics.monitor.azure.com/;ApplicationId=6564474f-329b-4b7d-849e-e70cb4181294"

  // Deduplicates concurrent calls: non-awaited init() in middleware/worker
  // won't race with await init() in session prompt.
  export function init(): Promise<void> {
    if (!initPromise) {
      initPromise = doInit()
    }
    return initPromise
  }

  async function doInit() {
    try {
      if (process.env.ALTIMATE_TELEMETRY_DISABLED === "true") {
        buffer = []
        return
      }
      // Config.get() may throw outside Instance context (e.g. CLI middleware
      // before Instance.provide()). Treat config failures as "not disabled" —
      // the env var check above is the early-init escape hatch.
      try {
        const userConfig = await Config.get() as any
        if (userConfig.telemetry?.disabled) {
          buffer = []
          return
        }
      } catch {
        // Config unavailable — proceed with telemetry enabled
      }
      // App Insights: env var overrides default (for dev/testing), otherwise use the baked-in key
      const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING ?? DEFAULT_CONNECTION_STRING
      const cfg = parseConnectionString(connectionString)
      if (!cfg) {
        buffer = []
        return
      }
      appInsights = cfg
      try {
        const account = Account.active()
        if (account) {
          userEmail = createHash("sha256").update(account.email.toLowerCase().trim()).digest("hex")
        }
      } catch {
        // Account unavailable — proceed without user ID
      }
      try {
        const machineIdPath = path.join(os.homedir(), ".altimate", "machine-id")
        try {
          machineId = fs.readFileSync(machineIdPath, "utf8").trim()
        } catch {
          machineId = randomUUID()
          fs.mkdirSync(path.dirname(machineIdPath), { recursive: true })
          fs.writeFileSync(machineIdPath, machineId, "utf8")
        }
      } catch {
        // Machine ID unavailable — proceed without it
      }
      enabled = true
      log.info("telemetry initialized", { mode: "appinsights" })
      const timer = setInterval(flush, FLUSH_INTERVAL_MS)
      if (typeof timer === "object" && timer && "unref" in timer) (timer as any).unref()
      flushTimer = timer
    } catch {
      buffer = []
    } finally {
      initDone = true
    }
  }

  export function setContext(opts: { sessionId: string; projectId: string }) {
    sessionId = opts.sessionId
    projectId = opts.projectId
  }

  export function getContext() {
    return { sessionId, projectId }
  }

  /** Returns true only after init() has completed and telemetry is enabled. */
  export function isEnabled(): boolean {
    return initDone && enabled
  }

  export function track(event: Event) {
    // Before init completes: buffer (flushed once init enables, or cleared if disabled).
    // After init completed and disabled telemetry: drop silently.
    if (initDone && !enabled) return
    buffer.push(event)
    if (buffer.length > MAX_BUFFER_SIZE) {
      buffer.shift()
      droppedEvents++
    }
  }

  export async function flush() {
    if (!enabled || buffer.length === 0 || !appInsights) return

    const events = buffer.splice(0, buffer.length)

    if (droppedEvents > 0) {
      events.push({
        type: "error",
        timestamp: Date.now(),
        session_id: sessionId,
        error_name: "TelemetryBufferOverflow",
        error_message: `${droppedEvents} events dropped due to buffer overflow`,
        context: "telemetry",
      } as Event)
      droppedEvents = 0
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(appInsights.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toAppInsightsEnvelopes(events, appInsights)),
        signal: controller.signal,
      })
      if (!response.ok) {
        log.debug("telemetry flush failed", { status: response.status })
      }
    } catch {
      // Re-add events that haven't been retried yet to avoid data loss
      const retriable = events.filter((e) => !(e as any)._retried)
      for (const e of retriable) {
        ;(e as any)._retried = true
      }
      const space = Math.max(0, MAX_BUFFER_SIZE - buffer.length)
      buffer.unshift(...retriable.slice(0, space))
    } finally {
      clearTimeout(timeout)
    }
  }

  export async function shutdown() {
    // Wait for init to complete so we know whether telemetry is enabled
    // and have a valid endpoint to flush to.  init() is fire-and-forget
    // in CLI middleware, so it may still be in-flight when shutdown runs.
    if (initPromise) {
      try {
        await initPromise
      } catch {
        // init failed — nothing to flush
      }
    }
    if (flushTimer) {
      clearInterval(flushTimer)
      flushTimer = undefined
    }
    await flush()
    enabled = false
    appInsights = undefined
    buffer = []
    droppedEvents = 0
    sessionId = ""
    projectId = ""
    machineId = ""
    initPromise = undefined
    initDone = false
  }
}
