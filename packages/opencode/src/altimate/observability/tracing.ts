/**
 * Session tracing (recording/recap) for Altimate CLI.
 *
 * Trace schema aligned with industry standards (OpenTelemetry GenAI semantic
 * conventions, Arize Phoenix / OpenInference, Langfuse).
 *
 * Uses an exporter pattern so trace data can be sent to multiple backends:
 *   - FileExporter:  writes JSON to ~/.local/share/altimate-code/traces/ (default)
 *   - HttpExporter:  POSTs trace JSON to a remote endpoint (config-driven)
 *   - Any custom TraceExporter implementation
 *
 * Configuration (altimate-code.json / opencode.json):
 *   tracing.enabled    — enable/disable tracing (default: true)
 *   tracing.dir        — custom directory for trace files
 *   tracing.maxFiles   — max trace files to keep (default: 100, 0 = unlimited)
 *   tracing.exporters  — additional HTTP exporters [{name, endpoint, headers}]
 */

import fs from "fs/promises"
import fsSync from "fs"
import path from "path"
import { Global } from "../../global"
import { randomUUIDv7 } from "bun"
import { Log } from "../../util/log"

// ---------------------------------------------------------------------------
// Trace data types — v2 schema
// ---------------------------------------------------------------------------

/** Token usage breakdown for a single LLM generation. */
export interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
}

/** A single span within a trace. */
export interface TraceSpan {
  spanId: string
  parentSpanId: string | null
  name: string
  kind: "session" | "generation" | "tool" | "text" | "span"
  startTime: number
  endTime?: number
  status: "ok" | "error"
  statusMessage?: string

  // --- LLM / generation fields (populated for kind=generation) ---
  model?: {
    modelId?: string
    providerId?: string
    /** Variant / reasoning effort (e.g., "high", "max") */
    variant?: string
  }
  /** Why the model stopped: "stop", "length", "tool_calls", "error", etc. */
  finishReason?: string
  tokens?: TokenUsage
  cost?: number

  // --- Tool fields (populated for kind=tool) ---
  tool?: {
    callId?: string
    durationMs?: number
  }

  // --- Common fields ---
  /** Structured or serialized input */
  input?: unknown
  /** Structured or serialized output */
  output?: unknown
  /** Arbitrary key-value attributes for extensibility */
  attributes?: Record<string, unknown>
}

/** Root trace object persisted to disk / exported. */
export interface TraceFile {
  /** Schema version for forward compatibility. */
  version: 2

  // --- Identity ---
  traceId: string
  sessionId: string

  // --- Timing ---
  startedAt: string
  endedAt?: string

  // --- Context ---
  metadata: {
    /** Session title (human-readable, set via --title or auto-generated). */
    title?: string
    model?: string
    providerId?: string
    agent?: string
    variant?: string
    prompt?: string
    /** User identifier (from config or auth). */
    userId?: string
    /** Application environment (e.g., "production", "development"). */
    environment?: string
    /** Application version / release. */
    version?: string
    /** Arbitrary tags for filtering. */
    tags?: string[]
  }

  // --- Spans ---
  spans: TraceSpan[]

  // --- Aggregated summary ---
  summary: {
    totalTokens: number
    totalCost: number
    totalToolCalls: number
    totalGenerations: number
    duration: number
    status: "completed" | "error" | "running" | "crashed"
    error?: string
    tokens: {
      input: number
      output: number
      reasoning: number
      cacheRead: number
      cacheWrite: number
    }
    // altimate_change start — trace: loop detection + post-session summary
    /** Detected tool call loops (same tool+input repeated 3+ times). */
    loops?: Array<{ tool: string; inputHash?: string; count: number; description: string }>
    /** Human-readable session narrative generated at endTrace. */
    narrative?: string
    /** Top tools by call count with total duration. */
    topTools?: Array<{ name: string; count: number; totalDuration: number }>
    // altimate_change end
  }
}

// ---------------------------------------------------------------------------
// Exporter interface
// ---------------------------------------------------------------------------

/**
 * A TraceExporter receives the finalized trace and persists it.
 * Implement this interface to add new backends (cloud, OTLP, etc.).
 */
export interface TraceExporter {
  readonly name: string
  export(trace: TraceFile): Promise<string | undefined>
}

// ---------------------------------------------------------------------------
// Built-in exporters
// ---------------------------------------------------------------------------

const DEFAULT_TRACES_DIR = path.join(Global.Path.data, "traces")
const DEFAULT_MAX_FILES = 100

/**
 * Writes traces as JSON files to the local filesystem.
 * Automatically prunes old files when maxFiles is exceeded.
 */
export class FileExporter implements TraceExporter {
  readonly name = "file"
  private dir: string
  private maxFiles: number

  constructor(dir?: string, maxFiles?: number) {
    this.dir = dir ?? DEFAULT_TRACES_DIR
    this.maxFiles = maxFiles ?? DEFAULT_MAX_FILES
  }

  async export(trace: TraceFile): Promise<string | undefined> {
    let tmpPath: string | undefined
    try {
      await fs.mkdir(this.dir, { recursive: true })
      // Sanitize sessionId for safe file name (defense-in-depth — also sanitized in Trace)
      const safeId = (trace.sessionId ?? "unknown").replace(/[/\\.:]/g, "_") || "unknown"
      const filePath = path.join(this.dir, `${safeId}.json`)
      // Atomic write: write to temp file, then rename — prevents partial reads
      // when concurrent snapshots or exports target the same file
      tmpPath = filePath + `.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
      await fs.writeFile(tmpPath, JSON.stringify(trace, null, 2))
      await fs.rename(tmpPath, filePath)

      if (this.maxFiles > 0) {
        this.pruneOldTraces().catch(() => {})
      }

      return filePath
    } catch {
      if (tmpPath) fs.unlink(tmpPath).catch(() => {})
      return undefined
    }
  }

  getDir(): string {
    return this.dir
  }

  private async pruneOldTraces() {
    const entries = await fs.readdir(this.dir, { withFileTypes: true })
    // Sweep stale temp files (crashes between writeFile and rename leave .tmp.*
    // artifacts). Older than 1 hour = definitely abandoned.
    const staleCutoff = Date.now() - 60 * 60 * 1000
    const tmpFiles = entries.filter((e) => e.isFile() && /\.json\.tmp\.[0-9]+\./.test(e.name))
    await Promise.allSettled(
      tmpFiles.map(async (e) => {
        const p = path.join(this.dir, e.name)
        const stat = await fs.stat(p).catch(() => undefined)
        if (stat && stat.mtimeMs < staleCutoff) await fs.unlink(p).catch(() => undefined)
      }),
    )

    const jsonFiles = entries
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => e.name)
      .sort() // UUIDv7-based filenames are lexicographically time-sorted

    if (jsonFiles.length <= this.maxFiles) return

    const toDelete = jsonFiles.slice(0, jsonFiles.length - this.maxFiles)
    await Promise.allSettled(toDelete.map((name) => fs.unlink(path.join(this.dir, name))))
  }
}

/**
 * POSTs trace data as JSON to an HTTP endpoint.
 * Used for cloud/remote backends configured via tracing.exporters[].
 */
export class HttpExporter implements TraceExporter {
  readonly name: string
  private endpoint: string
  private headers: Record<string, string>

  constructor(name: string, endpoint: string, headers?: Record<string, string>) {
    this.name = name
    this.endpoint = endpoint
    this.headers = headers ?? {}
  }

  async export(trace: TraceFile): Promise<string | undefined> {
    try {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.headers },
        body: JSON.stringify(trace),
        signal: AbortSignal.timeout(5_000),
      })

      if (!res.ok) return undefined

      try {
        const data = (await res.json()) as Record<string, unknown>
        if (typeof data.url === "string") return data.url
      } catch {
        // Response may not be JSON
      }
      return `${this.name}: exported`
    } catch {
      return undefined
    }
  }
}

// ---------------------------------------------------------------------------
// Trace — session recording/recap
// ---------------------------------------------------------------------------

interface TracerOptions {
  maxFiles?: number
}

// altimate_change start — trace: helper utilities for loop detection and narrative
function simpleHash(str: string): string {
  try {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i)
      hash = ((hash << 5) - hash + ch) | 0
    }
    return hash.toString(36)
  } catch {
    return "0"
  }
}

function formatDurationShort(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const mins = Math.floor(ms / 60000)
  const secs = Math.floor((ms % 60000) / 1000)
  return `${mins}m${secs}s`
}
// altimate_change end

export class Trace {
  // Global active trace — set when a session starts, cleared on end.
  private static _active: Trace | null = null
  static get active(): Trace | null { return Trace._active }
  static setActive(trace: Trace | null) { Trace._active = trace }

  private traceId: string
  private sessionId: string | undefined
  private rootSpanId: string | undefined
  private currentGenerationSpanId: string | undefined
  private generationText: string[] = []
  private generationToolCalls: string[] = []
  private pendingToolResults: Array<{ tool: string; summary: string }> = []
  private spans: TraceSpan[] = []
  private startTime: number
  private exporters: TraceExporter[]

  // Cumulative metrics
  private totalTokens = 0
  private totalCost = 0
  private toolCallCount = 0
  private generationCount = 0
  private tokensBreakdown = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }

  // altimate_change start — trace: loop detection state
  private toolCallHistory: Array<{ tool: string; inputHash: string; time: number }> = []
  private loopsDetected: Array<{ tool: string; inputHash: string; count: number; firstSeen: number; lastSeen: number }> = []
  // altimate_change end

  private metadata: TraceFile["metadata"] = {}
  private snapshotDir: string | undefined
  private snapshotPending = false
  private snapshotPromise: Promise<void> | undefined

  private constructor(exporters: TraceExporter[]) {
    this.traceId = randomUUIDv7()
    this.startTime = Date.now()
    this.exporters = exporters

    // Find the FileExporter dir for incremental snapshots
    for (const exp of exporters) {
      if (exp instanceof FileExporter) {
        this.snapshotDir = exp.getDir()
        break
      }
    }
  }

  /**
   * Create a trace with the default local file exporter.
   */
  static create(extraExporters: TraceExporter[] = []): Trace {
    return new Trace([new FileExporter(), ...extraExporters])
  }

  /**
   * Create a trace with explicit exporters (no defaults).
   */
  static withExporters(exporters: TraceExporter[], options?: TracerOptions): Trace {
    if (options?.maxFiles != null) {
      for (const exp of exporters) {
        if (exp instanceof FileExporter) {
          const idx = exporters.indexOf(exp)
          exporters[idx] = new FileExporter(exp.getDir(), options.maxFiles)
          break
        }
      }
    }
    return new Trace(exporters)
  }

  /**
   * Start the root trace for this session.
   */
  startTrace(
    sessionId: string,
    metadata: {
      instance_id?: string
      title?: string
      model?: string
      providerId?: string
      agent?: string
      variant?: string
      prompt?: string
      userId?: string
      environment?: string
      version?: string
      tags?: string[]
    },
  ) {
    this.sessionId = sessionId
    this.metadata = {
      title: metadata.title,
      model: metadata.model,
      providerId: metadata.providerId,
      agent: metadata.agent,
      variant: metadata.variant,
      prompt: metadata.prompt,
      userId: metadata.userId,
      environment: metadata.environment,
      version: metadata.version,
      tags: metadata.tags,
    }
    this.rootSpanId = randomUUIDv7()
    this.spans.push({
      spanId: this.rootSpanId,
      parentSpanId: null,
      name: metadata.instance_id || sessionId,
      kind: "session",
      startTime: this.startTime,
      status: "ok",
      input: metadata.prompt,
    })

    // Write initial snapshot immediately so there's always a trace file
    // even if the process crashes before the first tool call
    this.snapshot()
  }

  /**
   * Enrich the trace with model/provider info from the first assistant message.
   * Called when the message.updated event fires with assistant role.
   */
  enrichFromAssistant(info: {
    modelID?: string
    providerID?: string
    agent?: string
    variant?: string
  }) {
    try {
      if (!info) return
      if (info.modelID) this.metadata.model = `${info.providerID ?? ""}/${info.modelID}`
      if (info.providerID) this.metadata.providerId = info.providerID
      if (info.agent) this.metadata.agent = info.agent
      if (info.variant) this.metadata.variant = info.variant
    } catch {
      // best-effort
    }
  }

  /**
   * Set the trace title and prompt after startTrace.
   * Used by TUI when the user's prompt becomes available.
   */
  setTitle(title: string, prompt?: string) {
    if (title) this.metadata.title = title
    if (prompt) this.metadata.prompt = prompt
  }

  /**
   * Open a generation span from a step-start event.
   */
  logStepStart(part: { id: string }) {
    if (!this.rootSpanId) return
    try {
      const input =
        this.pendingToolResults.length > 0
          ? this.pendingToolResults.map((r) => `[${r.tool}] ${r.summary}`).join("\n")
          : undefined
      this.pendingToolResults = []
      this.generationText = []
      this.generationToolCalls = []

      const genSpanId = randomUUIDv7()
      const genName = `generation-${part?.id ?? "unknown"}`
      this.spans.push({
        spanId: genSpanId,
        parentSpanId: this.rootSpanId,
        name: genName,
        kind: "generation",
        startTime: Date.now(),
        status: "ok",
        model: {
          modelId: this.metadata.model,
          providerId: this.metadata.providerId,
          variant: this.metadata.variant,
        },
        input,
      })
      // Only update state after successful push
      this.currentGenerationSpanId = genSpanId
      this.generationCount++
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
    if (!this.currentGenerationSpanId) return
    try {
      const n = (v: number) => (Number.isFinite(v) ? v : 0)
      const tokens = part.tokens ?? ({} as Record<string, unknown>)
      const cache = (tokens as any).cache ?? {}
      const tIn = n((tokens as any).input ?? 0)
      const tOut = n((tokens as any).output ?? 0)
      const tReasoning = n((tokens as any).reasoning ?? 0)
      const tCacheRead = n(cache.read ?? 0)
      const tCacheWrite = n(cache.write ?? 0)
      const total = tIn + tOut + tReasoning + tCacheRead + tCacheWrite

      this.totalTokens += total
      this.totalCost += n(part.cost)
      this.tokensBreakdown.input += tIn
      this.tokensBreakdown.output += tOut
      this.tokensBreakdown.reasoning += tReasoning
      this.tokensBreakdown.cacheRead += tCacheRead
      this.tokensBreakdown.cacheWrite += tCacheWrite

      const textOutput = this.generationText.join("")
      const output =
        textOutput ||
        (this.generationToolCalls.length > 0
          ? `[tool calls: ${this.generationToolCalls.join(", ")}]`
          : undefined)

      const span = this.spans.find((s) => s.spanId === this.currentGenerationSpanId)
      if (span) {
        span.endTime = Date.now()
        span.output = output
        span.finishReason = part.reason
        span.cost = n(part.cost)
        span.tokens = {
          input: tIn,
          output: tOut,
          reasoning: tReasoning,
          cacheRead: tCacheRead,
          cacheWrite: tCacheWrite,
          total,
        }
      }
      this.currentGenerationSpanId = undefined
      this.snapshot()
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
    if (!this.rootSpanId) return
    try {
      const state = part.state
      const isError = state.status === "error"

      const toolName = part.tool || "unknown"
      this.generationToolCalls.push(toolName)

      const errorStr = isError ? String(state.error ?? "") : ""
      const outputStr = !isError ? String(state.output ?? "") : ""
      const outputSummary = isError
        ? `error: ${errorStr.slice(0, 200)}`
        : outputStr.slice(0, 500)
      this.pendingToolResults.push({ tool: toolName, summary: outputSummary })

      const time = state.time ?? { start: Date.now(), end: Date.now() }
      const durationMs = (time.end ?? 0) - (time.start ?? 0)

      // Safely serialize input — guard against circular references
      let safeInput: unknown
      try {
        safeInput = state.input != null ? JSON.parse(JSON.stringify(state.input)) : undefined
      } catch {
        safeInput = { _serialization_error: "Input contained circular references or non-serializable data" }
      }

      this.spans.push({
        spanId: randomUUIDv7(),
        parentSpanId: this.currentGenerationSpanId ?? this.rootSpanId,
        name: toolName,
        kind: "tool",
        startTime: time.start ?? Date.now(),
        endTime: time.end ?? Date.now(),
        status: isError ? "error" : "ok",
        statusMessage: isError ? errorStr : undefined,
        tool: {
          callId: part.callID,
          durationMs: Number.isFinite(durationMs) ? durationMs : 0,
        },
        input: safeInput,
        output: isError ? { error: errorStr } : outputStr.slice(0, 10000),
      })
      this.toolCallCount++

      // altimate_change start — trace: loop detection
      try {
        const inputStr = safeInput != null ? JSON.stringify(safeInput) : ""
        const inputHash = simpleHash(toolName + inputStr)
        const now = Date.now()
        this.toolCallHistory.push({ tool: toolName, inputHash, time: now })
        // Prune to prevent unbounded growth in long sessions
        if (this.toolCallHistory.length > 200) {
          this.toolCallHistory = this.toolCallHistory.slice(-100)
        }

        // Check last 10 tool calls for repeated tool+input
        const recent = this.toolCallHistory.slice(-10)
        const matchCount = recent.filter((h) => h.tool === toolName && h.inputHash === inputHash).length
        if (matchCount >= 3) {
          const existing = this.loopsDetected.find((l) => l.tool === toolName && l.inputHash === inputHash)
          if (existing) {
            existing.count = matchCount
            existing.lastSeen = now
          } else {
            const firstMatch = recent.find((h) => h.tool === toolName && h.inputHash === inputHash)
            this.loopsDetected.push({
              tool: toolName,
              inputHash,
              count: matchCount,
              firstSeen: firstMatch?.time ?? now,
              lastSeen: now,
            })
          }
        }
      } catch {
        // Loop detection must never crash the trace
      }
      // altimate_change end

      this.snapshot()
    } catch {
      // best-effort
    }
  }

  /**
   * Attach assistant text to the current generation.
   */
  logText(part: { text: string }) {
    if (part.text != null) this.generationText.push(String(part.text))
  }

  /**
   * Log a custom span (e.g., fingerprint detection, skill selection).
   * Used for internal operations that aren't LLM generations or tool calls.
   */
  logSpan(span: {
    name: string
    startTime: number
    endTime: number
    status?: "ok" | "error"
    input?: unknown
    output?: unknown
    attributes?: Record<string, unknown>
  }) {
    if (!this.rootSpanId) return
    try {
      this.spans.push({
        spanId: randomUUIDv7(),
        parentSpanId: this.rootSpanId,
        name: span.name,
        kind: "span",
        startTime: span.startTime,
        endTime: span.endTime,
        status: span.status ?? "ok",
        input: span.input,
        output: span.output,
        attributes: span.attributes,
      })
      this.snapshot()
    } catch {
      // best-effort
    }
  }

  /**
   * Build a TraceFile snapshot of the current state (in-progress or complete).
   * Used for incremental writes and live viewing.
   */
  private buildTraceFile(error?: string): TraceFile {
    const endTime = Date.now()
    const sanitize = (n: number) => (Number.isFinite(n) ? n : 0)

    // Snapshot the spans array and metadata to isolate from concurrent mutations.
    // structuredClone is safer than JSON.parse(JSON.stringify) for undefined values.
    let snapshotSpans: TraceSpan[]
    let snapshotMetadata: TraceFile["metadata"]
    try {
      snapshotSpans = JSON.parse(JSON.stringify(this.spans))
      snapshotMetadata = { ...this.metadata, tags: this.metadata.tags ? [...this.metadata.tags] : undefined }
    } catch {
      // If spans contain non-serializable data, fall back to reference (best-effort)
      snapshotSpans = this.spans
      snapshotMetadata = this.metadata
    }

    return {
      version: 2,
      traceId: this.traceId,
      sessionId: (this.sessionId || "unknown").replace(/[/\\.:]/g, "_"),
      startedAt: new Date(this.startTime).toISOString(),
      endedAt: new Date(endTime).toISOString(),
      metadata: snapshotMetadata,
      spans: snapshotSpans,
      summary: {
        totalTokens: sanitize(this.totalTokens),
        totalCost: sanitize(this.totalCost),
        totalToolCalls: this.toolCallCount,
        totalGenerations: this.generationCount,
        duration: sanitize(endTime - this.startTime),
        status: error ? "error" : this.currentGenerationSpanId ? "running" : "completed",
        ...(error && { error }),
        tokens: {
          input: sanitize(this.tokensBreakdown.input),
          output: sanitize(this.tokensBreakdown.output),
          reasoning: sanitize(this.tokensBreakdown.reasoning),
          cacheRead: sanitize(this.tokensBreakdown.cacheRead),
          cacheWrite: sanitize(this.tokensBreakdown.cacheWrite),
        },
      },
    }
  }

  /**
   * Write an incremental snapshot to disk.
   * Called automatically after each span completion. Best-effort — never blocks.
   */
  private snapshot() {
    if (!this.snapshotDir || !this.sessionId) return
    if (this.snapshotPending) return // Debounce — only one in flight at a time
    this.snapshotPending = true

    const trace = this.buildTraceFile()
    const safeId = (this.sessionId || "unknown").replace(/[/\\.:]/g, "_") || "unknown"
    const filePath = path.join(this.snapshotDir, `${safeId}.json`)
    const tmpPath = filePath + `.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`

    // Atomic write: write to temp file, then rename (prevents partial reads)
    this.snapshotPromise = fs.mkdir(this.snapshotDir, { recursive: true })
      .then(() => fs.writeFile(tmpPath, JSON.stringify(trace, null, 2)))
      .then(() => fs.rename(tmpPath, filePath))
      .catch((err) => {
        Log.Default.debug(`[tracing] failed to write trace snapshot: ${err}`)
        fs.unlink(tmpPath).catch(() => {})
      })
      .finally(() => {
        this.snapshotPending = false
        this.snapshotPromise = undefined
      })
  }

  /**
   * Get the trace file path for the current session (if tracing to a file).
   * Returns undefined if no FileExporter is configured or startTrace hasn't been called.
   */
  getTracePath(): string | undefined {
    if (!this.snapshotDir || !this.sessionId) return undefined
    const safeId = (this.sessionId || "unknown").replace(/[/\\.:]/g, "_") || "unknown"
    return path.join(this.snapshotDir, `${safeId}.json`)
  }

  /**
   * Attach domain-specific attributes to a span.
   *
   * Merges into the span's `attributes` map. Safe to call at any time —
   * if the target span doesn't exist, it's a no-op.
   *
   * @param attrs  Key-value pairs (use DE.* constants for well-known keys)
   * @param target Which span to attach to: "tool" (last tool span), "generation"
   *               (current generation), or "session" (root). Defaults to the most
   *               specific available span.
   */
  setSpanAttributes(attrs: Record<string, unknown>, target?: "tool" | "generation" | "session") {
    try {
      let span: TraceSpan | undefined
      if (target === "session") {
        span = this.spans.find((s) => s.spanId === this.rootSpanId)
      } else if (target === "generation") {
        span = this.spans.find((s) => s.spanId === this.currentGenerationSpanId)
      } else if (target === "tool") {
        // Find the last tool span
        for (let i = this.spans.length - 1; i >= 0; i--) {
          const s = this.spans[i]
          if (s?.kind === "tool") {
            span = s
            break
          }
        }
      } else {
        // Auto: prefer last tool span, then current generation, then session
        for (let i = this.spans.length - 1; i >= 0; i--) {
          const s = this.spans[i]
          if (s?.kind === "tool") {
            span = s
            break
          }
        }
        span ??= this.spans.find((s) => s.spanId === this.currentGenerationSpanId)
        span ??= this.spans.find((s) => s.spanId === this.rootSpanId)
      }

      if (!span) return

      // Merge — only non-undefined values; never overwrite with undefined
      if (!span.attributes) span.attributes = {}
      for (const [key, value] of Object.entries(attrs)) {
        if (value === undefined) continue
        // Guard against non-serializable values (circular refs, functions, etc.)
        try {
          const serialized = JSON.stringify(value)
          // JSON.stringify returns undefined for functions, symbols, etc.
          if (serialized === undefined) {
            span.attributes[key] = String(value)
          } else {
            span.attributes[key] = value
          }
        } catch {
          span.attributes[key] = String(value)
        }
      }
    } catch {
      // best-effort — domain attributes must never crash the tracer
    }
  }

  /**
   * Finalize the trace and send to all exporters.
   * Returns the result from the first exporter that succeeds (typically the file path).
   */
  async endTrace(error?: string): Promise<string | undefined> {
    // Wait for any in-flight snapshot to complete before final write
    if (this.snapshotPromise) await this.snapshotPromise.catch(() => {})

    // Force-close any orphaned generation span
    this.currentGenerationSpanId = undefined

    // Close root span
    const rootSpan = this.spans.find((s) => s.spanId === this.rootSpanId)
    if (rootSpan) {
      rootSpan.endTime = Date.now()
      rootSpan.status = error ? "error" : "ok"
      if (error) rootSpan.statusMessage = error
      const costStr = Number.isFinite(this.totalCost) ? this.totalCost.toFixed(4) : "0.0000"
      rootSpan.output = error
        ? `Error: ${error}`
        : `${this.generationCount} generations, ${this.toolCallCount} tool calls, ${this.totalTokens} tokens, $${costStr}`
    }

    const trace = this.buildTraceFile(error)

    // altimate_change start — trace: post-session summary (narrative, loops, topTools)
    try {
      // Top tools by call count
      const toolCounts = new Map<string, { count: number; totalDuration: number }>()
      for (const span of this.spans) {
        if (span.kind !== "tool") continue
        const entry = toolCounts.get(span.name) ?? { count: 0, totalDuration: 0 }
        entry.count++
        entry.totalDuration += span.tool?.durationMs ?? 0
        toolCounts.set(span.name, entry)
      }
      const topTools = [...toolCounts.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 10)
        .map(([name, stats]) => ({ name, count: stats.count, totalDuration: stats.totalDuration }))
      trace.summary.topTools = topTools

      // Loops
      if (this.loopsDetected.length > 0) {
        trace.summary.loops = this.loopsDetected.map((l) => ({
          tool: l.tool,
          inputHash: l.inputHash,
          count: l.count,
          description: `${l.tool} called ${l.count} times with same input (hash: ${l.inputHash})`,
        }))
      }

      // Narrative
      const dur = formatDurationShort(trace.summary.duration)
      const top3 = topTools.slice(0, 3).map((t) => t.name).join(", ")
      const toolsStr = top3 ? ` using ${toolCounts.size} tools (${top3})` : ""
      const loopWarning = this.loopsDetected.length > 0
        ? ` Warning: ${this.loopsDetected.length} loop(s) detected.`
        : ""
      const costStr = Number.isFinite(this.totalCost) ? `$${this.totalCost.toFixed(4)}` : "$0.0000"
      const statusPrefix = error ? `Failed after ${dur}` : `Completed in ${dur}`
      const llmStr = this.generationCount > 0 ? `. Made ${this.generationCount} LLM call${this.generationCount > 1 ? "s" : ""}` : ""
      trace.summary.narrative = `${statusPrefix}${llmStr}${toolsStr}.${loopWarning} Total cost: ${costStr}.`
    } catch {
      // Narrative generation must never crash the trace
    }
    // altimate_change end

    // Wrap each exporter call with a timeout to prevent hanging exporters
    // from blocking the entire endTrace call
    const EXPORTER_TIMEOUT_MS = 5_000
    const withTimeout = (p: Promise<string | undefined>, name: string) => {
      let timer: ReturnType<typeof setTimeout>
      const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          Log.Default.warn(`[tracing] Exporter "${name}" timed out after ${EXPORTER_TIMEOUT_MS}ms`)
          resolve(undefined)
        }, EXPORTER_TIMEOUT_MS)
      })
      return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
    }

    const results = await Promise.allSettled(
      this.exporters.map((e) => {
        try {
          return withTimeout(Promise.resolve(e.export(trace)), e.name)
        } catch {
          return Promise.resolve(undefined)
        }
      }),
    )

    for (const r of results) {
      if (r.status === "fulfilled" && r.value) return r.value
    }
    return undefined
  }

  /**
   * Best-effort synchronous flush for process exit handlers.
   * Writes the current trace state to disk using Bun.write (synchronous I/O).
   * Does NOT call exporters — only writes the local file.
   *
   * Use this in SIGINT/SIGTERM/beforeExit handlers where async code may not run.
   */
  flushSync(error?: string) {
    try {
      if (!this.snapshotDir || !this.sessionId) return
      this.currentGenerationSpanId = undefined
      const rootSpan = this.spans.find((s) => s.spanId === this.rootSpanId)
      if (rootSpan) {
        rootSpan.endTime = Date.now()
        rootSpan.status = error ? "error" : "ok"
        if (error) rootSpan.statusMessage = error
      }
      const trace = this.buildTraceFile(error || "Process exited before trace completed")
      trace.summary.status = "crashed"
      const safeId = (this.sessionId || "unknown").replace(/[/\\.:]/g, "_") || "unknown"
      const filePath = path.join(this.snapshotDir, `${safeId}.json`)
      // Must be synchronous — async writes won't complete before signal handler exits
      fsSync.mkdirSync(this.snapshotDir, { recursive: true })
      fsSync.writeFileSync(filePath, JSON.stringify(trace, null, 2))
    } catch {
      // best-effort — crash handler must never throw
    }
  }

  // ---------------------------------------------------------------------------
  // Static helpers for reading local traces
  // ---------------------------------------------------------------------------

  static getTracesDir(dir?: string): string {
    return dir ?? DEFAULT_TRACES_DIR
  }

  static async listTraces(dir?: string): Promise<Array<{ sessionId: string; file: string; trace: TraceFile }>> {
    const tracesDir = dir ?? DEFAULT_TRACES_DIR
    try {
      await fs.mkdir(tracesDir, { recursive: true })
      const files = await fs.readdir(tracesDir)
      const traces: Array<{ sessionId: string; file: string; trace: TraceFile }> = []

      for (const file of files) {
        if (!file.endsWith(".json")) continue
        try {
          const content = await fs.readFile(path.join(tracesDir, file), "utf-8")
          const trace = JSON.parse(content) as TraceFile
          traces.push({ sessionId: trace.sessionId, file, trace })
        } catch {
          // Skip corrupted files
        }
      }

      traces.sort((a, b) => new Date(b.trace.startedAt).getTime() - new Date(a.trace.startedAt).getTime())
      return traces
    } catch {
      return []
    }
  }

  /**
   * List traces with pagination support.
   * Returns a page of traces plus total count for building pagination UI.
   */
  static async listTracesPaginated(
    dir?: string,
    options?: { offset?: number; limit?: number },
  ): Promise<{
    traces: Array<{ sessionId: string; file: string; trace: TraceFile }>
    total: number
    offset: number
    limit: number
  }> {
    const all = await Trace.listTraces(dir)
    const rawOffset = options?.offset ?? 0
    const rawLimit = options?.limit ?? 20
    const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.trunc(rawLimit)) : 20
    return {
      traces: all.slice(offset, offset + limit),
      total: all.length,
      offset,
      limit,
    }
  }

  static async loadTrace(sessionId: string, dir?: string): Promise<TraceFile | null> {
    const tracesDir = dir ?? DEFAULT_TRACES_DIR
    try {
      const filePath = path.join(tracesDir, `${sessionId}.json`)
      const content = await fs.readFile(filePath, "utf-8")
      return JSON.parse(content) as TraceFile
    } catch {
      return null
    }
  }
}

// altimate_change start — trace: backward-compat aliases
/** @deprecated Use Trace instead */
export const Tracer = Trace
/** @deprecated Use Trace instead */
export type Tracer = Trace
/** @deprecated Use Trace instead */
export const Recap = Trace
/** @deprecated Use Trace instead */
export type Recap = Trace
// altimate_change end
