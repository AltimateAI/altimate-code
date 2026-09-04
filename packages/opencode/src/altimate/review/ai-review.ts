// altimate_change - LLM reviewer lane (transport only; prompt + parse live in core)
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { Agent } from "@/agent/agent"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, SessionID } from "@/session/schema"
import { Log } from "@/altimate/util/log"
import { Dispatcher } from "../native"
import { type Finding, type ReviewCategory, type Severity, makeFinding } from "./finding"
import { NO_MODEL_REASON, type AiReviewStatus } from "./verdict"
import { DEFAULT_AI_MAX_OUTPUT_TOKENS } from "./config"

const log = Log.create({ service: "ai-review" })

const MAX_DIFF_CHARS = 6_000 // per file, keep the prompt bounded
const MAX_FILES = 20

export interface AiReviewFile {
  path: string
  status: string
  model: string
  /** Unified diff (added/removed lines) for this file. */
  diff?: string
  /** dbt-compiled (preferred) or raw SQL for context. */
  sql?: string
}

export interface AiReviewInput {
  files: AiReviewFile[]
  /** Deterministic engine findings — grounding the AI must NOT duplicate. */
  grounding: Finding[]
  /** Explicit provider/model for this advisory lane. */
  model?: string
  /** Allow the interactive tool to fall back to the current session model. */
  allowSessionModel: boolean
  /** Active provider/model supplied by the interactive tool context. */
  sessionModel?: string
  prTitle?: string
  prBody?: string
  /** Override the review deadline (primarily for tests). */
  timeoutMs?: number
  /** Total output budget, including reasoning tokens. */
  maxOutputTokens?: number
}

export interface AiReviewResult {
  findings: Finding[]
  status: AiReviewStatus
  reason?: string
  /** Effective provider/model used by the advisory lane. */
  model?: string
  durationMs?: number
  promptChars?: number
  promptTokens?: number
  completionTokens?: number
  reasoningTokens?: number
}

/**
 * IP boundary: the reviewer's system prompt (its remit + "what NOT to flag"
 * guardrails + output contract) and the response parse/clamp logic live in the
 * compiled core (`altimate_core.review_ai_*`), not in this public file. This
 * module only does TRANSPORT — assemble the user message, run the LLM through
 * the harness, and hand the raw response back to core to parse and clamp.
 */

function truncate(s: string | undefined, n: number): string {
  if (!s) return ""
  return s.length > n ? s.slice(0, n) + "\n… (truncated)" : s
}

function errorReason(err: unknown): string {
  const name =
    err instanceof Error ? (err.name && err.name !== "Error" ? err.name : err.constructor.name || "Error") : "Error"
  const message = err instanceof Error ? err.message : String(err)
  const raw = message && message !== name ? `${name}: ${message}` : name
  const clean = raw
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<redacted-url>")
    .replace(/sk-(?:ant-)?[A-Za-z0-9_-]{20,}/g, "sk-***")
    .replace(/Bearer\s+[A-Za-z0-9._-]{20,}/gi, "Bearer ***")
    .replace(/\s+/g, " ")
    .trim()
  return truncateAtWord(clean, 120)
}

/** Cut at the last word boundary before `max` and mark the cut, so a rendered
 *  reason never ends mid-word ("…able to ac"). */
function truncateAtWord(s: string, max: number): string {
  if (s.length <= max) return s
  const cut = s.lastIndexOf(" ", max - 1)
  return `${s.slice(0, cut > max / 2 ? cut : max - 1).trimEnd()}…`
}

function noModelError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err instanceof Provider.ModelNotFoundError || err instanceof Provider.NoModelsError) return true
  return err.message === "no providers found" || err.message === "no models found"
}

interface AiUsage {
  promptTokens?: number
  completionTokens?: number
  reasoningTokens?: number
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0
    ? value
    : undefined
}

function findTokenCount(value: unknown, keys: ReadonlySet<string>, seen = new Set<unknown>()): number | undefined {
  if (!value || typeof value !== "object" || seen.has(value)) return undefined
  seen.add(value)
  for (const [key, item] of Object.entries(value)) {
    if (keys.has(key)) {
      const count = tokenCount(item)
      if (count !== undefined) return count
    }
  }
  for (const item of Object.values(value)) {
    const count = findTokenCount(item, keys, seen)
    if (count !== undefined) return count
  }
  return undefined
}

function readUsage(usage: unknown, providerMetadata: unknown): AiUsage {
  const normalized = usage && typeof usage === "object" ? (usage as Record<string, unknown>) : undefined
  const details =
    normalized?.outputTokenDetails && typeof normalized.outputTokenDetails === "object"
      ? (normalized.outputTokenDetails as Record<string, unknown>)
      : undefined
  const sources = { usage, providerMetadata }
  return {
    promptTokens:
      tokenCount(normalized?.inputTokens) ??
      findTokenCount(sources, new Set(["promptTokens", "prompt_tokens", "input_tokens"])),
    completionTokens:
      tokenCount(normalized?.outputTokens) ??
      findTokenCount(sources, new Set(["completionTokens", "completion_tokens", "output_tokens"])),
    reasoningTokens:
      tokenCount(details?.reasoningTokens) ??
      tokenCount(normalized?.reasoningTokens) ??
      findTokenCount(sources, new Set(["reasoningTokens", "reasoning_tokens"])),
  }
}

function mergeUsage(current: AiUsage, next: AiUsage): AiUsage {
  return {
    promptTokens: next.promptTokens ?? current.promptTokens,
    completionTokens: next.completionTokens ?? current.completionTokens,
    reasoningTokens: next.reasoningTokens ?? current.reasoningTokens,
  }
}

function isLengthFinishReason(reason: unknown): boolean {
  return reason === "length" || reason === "max_tokens" || reason === "max_output_tokens"
}

function suggestedFindingCount(text: string): number {
  return text.match(/["']file["']\s*:/g)?.length ?? 0
}

/** Assemble the user message (mechanical formatting — not IP). */
function buildUserMessage(input: AiReviewInput): string {
  const parts: string[] = []
  if (input.prTitle) parts.push(`PR title: ${truncate(input.prTitle, 200)}`)
  if (input.prBody) parts.push(`PR description:\n${truncate(input.prBody, 1500)}`)

  if (input.grounding.length) {
    parts.push(
      "\n## GROUNDING — deterministic engine findings (DO NOT repeat these):",
      ...input.grounding.slice(0, 40).map((f) => `- [${f.severity}] ${f.category} · ${f.file}: ${f.title}`),
    )
  } else {
    parts.push("\n## GROUNDING — the engine produced no findings.")
  }

  parts.push("\n## CHANGED FILES (review for what the engine missed):")
  for (const f of input.files.slice(0, MAX_FILES)) {
    parts.push(`\n### ${f.path} (${f.status})`)
    if (f.diff) parts.push("Diff:\n```diff\n" + truncate(f.diff, MAX_DIFF_CHARS) + "\n```")
    if (f.sql) parts.push("Current SQL:\n```sql\n" + truncate(f.sql, MAX_DIFF_CHARS) + "\n```")
  }
  parts.push("\nReturn ONLY the JSON array per the output contract.")
  return parts.join("\n")
}

/**
 * Run the LLM reviewer lane. Findings are advisory (severity ≤ warning,
 * clamped by core), and failures are returned as status rather than thrown — a
 * review must never crash because the AI layer is unavailable.
 */
export async function runAiReview(input: AiReviewInput): Promise<AiReviewResult> {
  const startedAt = Date.now()
  let effectiveModel: string | undefined
  let promptChars = 0
  let usage: AiUsage = {}
  const finish = (result: AiReviewResult): AiReviewResult => ({
    ...result,
    ...(effectiveModel ? { model: effectiveModel } : {}),
    durationMs: Math.max(0, Date.now() - startedAt),
    promptChars,
    ...(usage.promptTokens !== undefined ? { promptTokens: usage.promptTokens } : {}),
    ...(usage.completionTokens !== undefined ? { completionTokens: usage.completionTokens } : {}),
    ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
  })
  if (!input.model && !input.allowSessionModel) {
    return finish({ findings: [], status: "skipped", reason: NO_MODEL_REASON })
  }

  const files = input.files.filter((f) => f.status !== "deleted" && (f.diff || f.sql))
  if (!files.length) return finish({ findings: [], status: "skipped", reason: "no reviewable files" })

  const userMessage = buildUserMessage({ ...input, files })
  promptChars = userMessage.length
  const aiTimeoutMs =
    input.timeoutMs ?? Math.min(300, 120 + 4 * Math.min(files.length, MAX_FILES)) * 1_000
  const maxOutputTokens = input.maxOutputTokens ?? DEFAULT_AI_MAX_OUTPUT_TOKENS
  const timeoutReason = `timed out after ${aiTimeoutMs / 1000}s (raise aiTimeoutSeconds / --ai-timeout)`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), aiTimeoutMs)
  const setupTimedOut = Symbol("setupTimedOut")
  const abortPromise = new Promise<typeof setupTimedOut>((resolve) => {
    controller.signal.addEventListener("abort", () => resolve(setupTimedOut), { once: true })
  })
  let streamAborted = false
  let finishReason: unknown
  let rawFinishReason: unknown
  let providerMetadata: unknown
  try {
    const setup = (async () => {
      let model: Awaited<ReturnType<typeof Provider.getModel>>
      if (input.model) {
        const parsed = Provider.parseModel(input.model)
        if (!parsed.providerID.length || !parsed.modelID.length || /\s/.test(input.model)) {
          return { modelError: "Error: expected provider/model" }
        }
        effectiveModel = input.model
        try {
          model = await Provider.getModel(parsed.providerID, parsed.modelID)
        } catch (err) {
          return { modelError: errorReason(err) }
        }
      } else if (input.sessionModel) {
        const parsed = Provider.parseModel(input.sessionModel)
        if (!parsed.providerID.length || !parsed.modelID.length || /\s/.test(input.sessionModel)) {
          const defaultModel = await Provider.defaultModel()
          model = await Provider.getModel(defaultModel.providerID, defaultModel.modelID)
        } else {
          effectiveModel = input.sessionModel
          try {
            model = await Provider.getModel(parsed.providerID, parsed.modelID)
          } catch (err) {
            return { modelError: errorReason(err) }
          }
        }
      } else {
        const defaultModel = await Provider.defaultModel()
        model = await Provider.getModel(defaultModel.providerID, defaultModel.modelID)
      }
      effectiveModel = `${model.providerID}/${model.id}`

      // Prompt comes from the compiled core, not this file.
      const promptRes = await Dispatcher.call("altimate_core.review_ai_prompt", {})
      const system = ((promptRes.data ?? {}) as Record<string, unknown>).prompt as string | undefined
      if (!system) return undefined
      return { system, model }
    })()
    const setupResult = await Promise.race([setup, abortPromise])
    if (setupResult === setupTimedOut) return finish({ findings: [], status: "timeout", reason: timeoutReason })
    if (!setupResult) return finish({ findings: [], status: "skipped", reason: "reviewer prompt unavailable" })
    if ("modelError" in setupResult) {
      return finish({
        findings: [],
        status: "error",
        reason: `configured AI model not available: ${input.model ?? input.sessionModel} — ${setupResult.modelError}`,
      })
    }
    const { system, model } = setupResult

    const agent: Agent.Info = {
      name: "dbt-ai-reviewer",
      mode: "primary",
      hidden: true,
      options: {},
      permission: [],
      prompt: system,
      temperature: 0,
    }
    const user: MessageV2.User = {
      id: MessageID.ascending(),
      sessionID: SessionID.descending(),
      role: "user",
      time: { created: Date.now() },
      agent: agent.name,
      model: { providerID: model.providerID, modelID: model.id },
    }

    const streamResult = await Promise.race([
      LLM.stream({
        agent,
        user,
        system: [system],
        small: false,
        tools: {},
        model,
        abort: controller.signal,
        sessionID: user.sessionID,
        retries: 1,
        messages: [{ role: "user", content: userMessage }],
        // Reasoning models spend from the same budget before emitting the JSON
        // array, so the advisory lane must reserve enough for both phases.
        maxOutputTokens,
      }),
      abortPromise,
    ])
    if (streamResult === setupTimedOut || controller.signal.aborted) {
      return finish({ findings: [], status: "timeout", reason: timeoutReason })
    }
    const stream = streamResult
    const drain = (async () => {
      for await (const event of stream.fullStream) {
        // drain to avoid SDK hangs
        if (event.type === "abort") streamAborted = true
        if (event.type === "error") throw event.error
        if (event.type === "finish-step") {
          finishReason = event.finishReason ?? finishReason
          rawFinishReason = event.rawFinishReason ?? rawFinishReason
          providerMetadata = event.providerMetadata ?? providerMetadata
          usage = mergeUsage(usage, readUsage(event.usage, providerMetadata))
        }
        if (event.type === "finish") {
          finishReason = event.finishReason ?? finishReason
          rawFinishReason = event.rawFinishReason ?? rawFinishReason
          usage = mergeUsage(usage, readUsage(event.totalUsage, providerMetadata))
        }
      }
    })()
    const drainResult = await Promise.race([drain, abortPromise])
    if (drainResult === setupTimedOut || controller.signal.aborted || streamAborted) {
      return finish({ findings: [], status: "timeout", reason: timeoutReason })
    }
    const resultDetails = await Promise.race([
      Promise.all([
        Promise.resolve(stream.text),
        Promise.resolve(stream.finishReason),
        Promise.resolve(stream.rawFinishReason),
        Promise.resolve(stream.totalUsage),
        Promise.resolve(stream.providerMetadata),
      ]),
      abortPromise,
    ])
    if (resultDetails === setupTimedOut || controller.signal.aborted) {
      return finish({ findings: [], status: "timeout", reason: timeoutReason })
    }
    const [text, streamFinishReason, streamRawFinishReason, streamUsage, streamProviderMetadata] = resultDetails
    finishReason = streamFinishReason ?? finishReason
    rawFinishReason = streamRawFinishReason ?? rawFinishReason
    providerMetadata = streamProviderMetadata ?? providerMetadata
    usage = mergeUsage(usage, readUsage(streamUsage, providerMetadata))
    const outputTruncated = isLengthFinishReason(finishReason) || isLengthFinishReason(rawFinishReason)
    const truncated = (): AiReviewResult =>
      finish({
        findings: [],
        status: "error",
        reason: `output truncated at ${usage.completionTokens ?? maxOutputTokens} tokens (raise aiMaxOutputTokens)`,
      })
    if (!text?.trim()) {
      return outputTruncated ? truncated() : finish({ findings: [], status: "error", reason: "empty response" })
    }

    // Parse + clamp in core (the prompt-injection-resistant, advisory-only
    // contract). Returns already-validated, severity-clamped, file-checked items.
    let parseResult: Awaited<ReturnType<typeof Dispatcher.call>> | typeof setupTimedOut
    try {
      parseResult = await Promise.race([
        Dispatcher.call("altimate_core.review_ai_parse", {
          text,
          valid_files: files.map((f) => f.path),
        }),
        abortPromise,
      ])
    } catch (err) {
      if (outputTruncated) return truncated()
      throw err
    }
    if (parseResult === setupTimedOut || controller.signal.aborted) {
      return finish({ findings: [], status: "timeout", reason: timeoutReason })
    }
    const parseRes = parseResult
    if (parseRes.success === false) {
      if (outputTruncated) return truncated()
      throw new Error(parseRes.error ?? "AI response parse failed")
    }
    const parsedValue = ((parseRes.data ?? {}) as Record<string, unknown>).findings
    if (!Array.isArray(parsedValue)) {
      if (outputTruncated) return truncated()
      throw new Error("AI response parse failed")
    }
    const parsed = parsedValue as any[]
    if (outputTruncated && parsed.length < suggestedFindingCount(text)) return truncated()
    const byFile = new Map(files.map((f) => [f.path, f]))

    const out: Finding[] = []
    for (const item of parsed) {
      // Per-item guard: a single malformed finding (e.g. an out-of-enum severity that
      // makes makeFinding's schema throw) must NOT discard the whole batch.
      try {
        const file = byFile.get(String(item?.file ?? ""))
        if (!file || !item?.title || !item?.body) continue
        // Defense-in-depth clamp in the transport layer too: the advisory lane is
        // never allowed to emit `critical` (or any non-enum value), independent of
        // what core returns. Only `warning` survives as `warning`; everything else
        // degrades to `suggestion`.
        const severity: Severity = item.severity === "warning" ? "warning" : "suggestion"
        out.push(
          makeFinding({
            severity,
            category: item.category as ReviewCategory,
            title: `${file.model}: ${item.title}`,
            body: String(item.body),
            file: file.path,
            model: file.model,
            startLine: typeof item.line === "number" ? item.line : undefined,
            endLine: typeof item.line === "number" ? item.line : undefined,
            confidence: item.confidence === "high" ? "high" : item.confidence === "low" ? "low" : "medium",
            evidence: { tool: "ai-review", result: { confidence: item.confidence } },
            ruleKey: `ai:${item.category}:${String(item.title).slice(0, 60)}`,
          }),
        )
      } catch (err) {
        log.warn("skipping malformed ai finding", { error: err })
      }
    }
    log.info("ai review complete", { findings: out.length, ...usage })
    return finish({ findings: out, status: "ok" })
  } catch (err) {
    log.error("ai review failed", { error: err })
    if (noModelError(err)) return finish({ findings: [], status: "skipped", reason: NO_MODEL_REASON })
    if (controller.signal.aborted || streamAborted || (err as { name?: unknown } | undefined)?.name === "AbortError") {
      return finish({ findings: [], status: "timeout", reason: timeoutReason })
    }
    return finish({ findings: [], status: "error", reason: errorReason(err) })
  } finally {
    clearTimeout(timeout)
  }
}
