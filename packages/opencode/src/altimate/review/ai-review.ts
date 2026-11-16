// altimate_change - LLM reviewer lane (transport only; prompt + parse live in core)
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { Agent } from "@/agent/agent"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, SessionID } from "@/session/schema"
import { Log } from "@/altimate/util/log"
import { redactSecrets } from "@/installation"
import { Dispatcher } from "../native"
import { type Finding, type ReviewCategory, type Severity, makeFinding, ruleId } from "./finding"
import { readStreamText } from "../llm/stream-text"
import { type AiVerifyEvidence, type VerifierStatus, aiVerifyEnabled, runAiVerify } from "./ai-verify"

const log = Log.create({ service: "ai-review" })

const AI_TIMEOUT_BASE_MS = 60_000
const AI_TIMEOUT_MAX_MS = 300_000
const MAX_DIFF_CHARS = 6_000 // per file, keep the prompt bounded
const MAX_FILES = 20
const CONTEXT_FILE_CHARS = 8_000
const CONTEXT_TOTAL_CHARS = 40_000
const BATCH_CONCURRENCY = 2

/**
 * How much of the PR the lane sends. Defaults keep one bounded call; the
 * `ALTIMATE_REVIEW_AI_*` variables widen it for experiments: more files, longer
 * files, and a per-call size above which files are split across several calls
 * instead of being cut.
 */
export interface AiInputBudget {
  maxFiles: number
  maxFileChars: number
  /** Characters of file sections per call; Infinity keeps a single call. */
  batchChars: number
}
export function aiInputBudget(env: Record<string, string | undefined> = process.env): AiInputBudget {
  const num = (v: string | undefined, d: number) => {
    const n = Number(v)
    return v && Number.isFinite(n) && n > 0 ? n : d
  }
  return {
    maxFiles: num(env.ALTIMATE_REVIEW_AI_MAX_FILES, MAX_FILES),
    maxFileChars: num(env.ALTIMATE_REVIEW_AI_MAX_FILE_CHARS, MAX_DIFF_CHARS),
    batchChars: num(env.ALTIMATE_REVIEW_AI_BATCH_CHARS, Infinity),
  }
}

export interface AiReviewFile {
  path: string
  status: string
  /** Model name for a model; the file's base name for any other dbt file. */
  model: string
  /** dbt role of the file (`model_sql`, `macro`, `schema_yml`, `test`, …); omitted means a model. */
  kind?: string
  /** Unified diff (added/removed lines) for this file. */
  diff?: string
  /** Current content: dbt-compiled (preferred) or raw SQL for a model, the file itself otherwise. */
  sql?: string
}

/** Order under the file cap: models first, then the files whose defects reach the most models. */
const KIND_ORDER = ["model_sql", "python_model", "macro", "test", "snapshot", "schema_yml", "source_yml", "seed", "project_config"]
const KIND_LABEL: Record<string, string> = {
  macro: "macro (Jinja; changes every model that calls it)",
  test: "singular data test",
  snapshot: "snapshot",
  schema_yml: "schema yml (tests, contracts, descriptions)",
  source_yml: "sources yml",
  seed: "seed CSV",
  project_config: "project config",
  python_model: "Python model",
}
const FENCE: Record<string, string> = { schema_yml: "yaml", source_yml: "yaml", project_config: "yaml", seed: "csv", python_model: "python" }

function kindRank(kind: string | undefined): number {
  const i = KIND_ORDER.indexOf(kind ?? "model_sql")
  return i < 0 ? KIND_ORDER.length : i
}

/** Files the lane sends, in priority order, capped at `maxFiles`. */
export function selectAiFiles(files: AiReviewFile[], maxFiles = MAX_FILES): AiReviewFile[] {
  return files
    .filter((f) => f.status !== "deleted" && (f.diff || f.sql))
    .map((f, i) => ({ f, i }))
    .sort((a, b) => kindRank(a.f.kind) - kindRank(b.f.kind) || a.i - b.i)
    .map(({ f }) => f)
    .slice(0, maxFiles)
}

/** One changed file as it appears in the prompt. */
function fileSection(f: AiReviewFile, maxChars: number): string {
  const label = f.kind && KIND_LABEL[f.kind]
  const parts = [`\n### ${f.path} (${f.status}${label ? `, ${label}` : ""})`]
  if (f.diff) parts.push("Diff:\n```diff\n" + truncate(f.diff, maxChars) + "\n```")
  if (f.sql) {
    const isModel = !f.kind || f.kind === "model_sql"
    parts.push(`${isModel ? "Current SQL" : "Current file"}:\n\`\`\`${FENCE[f.kind ?? ""] ?? "sql"}\n` + truncate(f.sql, maxChars) + "\n```")
  }
  return parts.join("\n")
}

/** Split files, in order, into groups whose sections fit `batchChars` (an oversized file goes alone). */
export function batchAiFiles(files: AiReviewFile[], budget: AiInputBudget): AiReviewFile[][] {
  const batches: AiReviewFile[][] = []
  let cur: AiReviewFile[] = []
  let size = 0
  for (const f of files) {
    const n = fileSection(f, budget.maxFileChars).length
    if (cur.length && size + n > budget.batchChars) {
      batches.push(cur)
      cur = []
      size = 0
    }
    cur.push(f)
    size += n
  }
  if (cur.length) batches.push(cur)
  return batches
}

/** An unchanged file the changed ones depend on (dbt DAG parent), sent as read-only context. */
export interface AiContextFile {
  path: string
  /** dbt resource type: `model`, `seed`, `snapshot`, `source`, `macro`. */
  kind: string
  name: string
  /** Changed files that depend on it. */
  forPaths: string[]
  content: string
}

export interface AiReviewInput {
  files: AiReviewFile[]
  /** Unchanged parents of the changed files, for cross-file checks (columns, seeds, macro signatures). */
  context?: AiContextFile[]
  /** Deterministic engine findings — grounding the AI must NOT duplicate. */
  grounding: Finding[]
  prTitle?: string
  prBody?: string
  /** Explicit `provider/model`; omit to use the configured default model. */
  model?: string
  /** What the verifier may read; it runs only when this is set and `ALTIMATE_REVIEW_AI_VERIFY=1`. */
  evidence?: AiVerifyEvidence
}

/** What happened in the advisory lane, reported on the envelope and in the comment. */
export type AiLaneState = "ok" | "skipped" | "timeout" | "error"
export interface AiLaneStatus {
  state: AiLaneState
  /** Why the lane was skipped or failed (never contains credentials). */
  reason?: string
  /** `provider/model` the lane ran with. */
  model?: string
  durationMs?: number
  /** Tokens spent across all calls that reported usage. */
  tokens?: AiTokens
  /** Estimated cost in USD from the model's price table (0 when unpriced). */
  cost?: number
  /** Model calls made (one per batch). */
  calls?: number
  /** The dbt-grounded verifier's outcome, when it ran (opt-in). */
  verifier?: VerifierStatus
}
/** Token counts as `Session.getUsage` reports them: `input` excludes cached
 *  tokens, `inputTotal` includes them. */
export interface AiTokens {
  input: number
  inputTotal: number
  output: number
  reasoning: number
  cacheRead: number
}
export interface AiReviewResult {
  findings: Finding[]
  status: AiLaneStatus
}

/** Timeout scaled to the prompt: 60 s plus 1 s per 2,000 characters, capped at 5 minutes. */
export function aiTimeoutMs(promptChars: number): number {
  return Math.min(AI_TIMEOUT_MAX_MS, AI_TIMEOUT_BASE_MS + Math.ceil(promptChars / 2_000) * 1_000)
}

/** Error text safe to show in a PR comment: one line, bounded, with
 *  credentials masked (authorization headers, `Basic`/`Bearer` values,
 *  `key=value` secrets, `user:pass@` URL userinfo, provider-prefixed tokens).
 *  Redaction runs before whitespace is collapsed so a header match stops at
 *  its own line. */
export function safeReason(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return redactSecrets(raw)
    .replace(/\s+/g, " ")
    .replace(/(bearer\s+)[^\s]+/gi, "$1***")
    .replace(/\b(sk|pk|key|token)[-_][A-Za-z0-9_-]{8,}/gi, "***")
    .slice(0, 200)
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

/** Context sections for the parents of the files in this call, within the context budget. */
function relatedContext(input: AiReviewInput): string[] {
  const paths = new Set(input.files.map((f) => f.path))
  const out: string[] = []
  let used = 0
  for (const c of input.context ?? []) {
    if (paths.has(c.path) || !c.forPaths.some((p) => paths.has(p))) continue
    const section = `\n### ${c.path} (${c.kind} \`${c.name}\`, used by ${c.forPaths.filter((p) => paths.has(p)).join(", ")})\n\`\`\`${c.kind === "source" || c.path.endsWith(".yml") ? "yaml" : c.path.endsWith(".csv") ? "csv" : "sql"}\n${truncate(c.content, CONTEXT_FILE_CHARS)}\n\`\`\``
    if (used + section.length > CONTEXT_TOTAL_CHARS) break
    out.push(section)
    used += section.length
  }
  return out
}

/** Assemble the user message (mechanical formatting — not IP). */
export function buildUserMessage(input: AiReviewInput, maxFileChars = MAX_DIFF_CHARS): string {
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
  for (const f of input.files) parts.push(fileSection(f, maxFileChars))
  const context = relatedContext(input)
  if (context.length) {
    parts.push(
      "\n## RELATED FILES — unchanged dbt parents of the changed files (context only; comment on the changed files, not these):",
      ...context,
    )
  }
  parts.push("\nReturn ONLY the JSON array per the output contract.")
  return parts.join("\n")
}

/**
 * Run the LLM reviewer lane. Returns advisory findings (severity ≤ warning,
 * clamped by core) and a status saying whether the lane ran, was skipped, timed
 * out or failed. Never throws — a review must not crash because the AI layer is
 * unavailable — but never fails silently either: the status reaches the
 * envelope and the PR comment.
 */
export async function runAiReview(input: AiReviewInput): Promise<AiReviewResult> {
  const startedAt = Date.now()
  const done = (findings: Finding[], status: Omit<AiLaneStatus, "durationMs">): AiReviewResult => ({
    findings,
    status: { ...status, durationMs: Date.now() - startedAt },
  })
  const budget = aiInputBudget()
  const files = selectAiFiles(input.files, budget.maxFiles)
  if (!files.length) return done([], { state: "skipped", reason: "no changed dbt files to review" })

  let modelLabel: string | undefined
  try {
    // Prompt comes from the compiled core, not this file.
    const promptRes = await Dispatcher.call("altimate_core.review_ai_prompt", {})
    const system = ((promptRes.data ?? {}) as Record<string, unknown>).prompt as string | undefined
    if (!system) return done([], { state: "error", reason: "the core reviewer prompt is unavailable" })

    let model: Awaited<ReturnType<typeof Provider.getModel>>
    try {
      const chosen = input.model ? Provider.parseModel(input.model) : await Provider.defaultModel()
      model = await Provider.getModel(chosen.providerID, chosen.modelID)
    } catch (err) {
      // An explicitly requested model that cannot be resolved is an error, not
      // the same as `--no-ai`; only a missing default is a skip.
      return done([], {
        state: input.model ? "error" : "skipped",
        reason: `no usable model: ${safeReason(err)}`,
        model: input.model,
      })
    }
    modelLabel = `${model.providerID}/${model.id}`

    // One call per batch; a PR that fits the budget is a single call, as before.
    const batches = batchAiFiles(files, budget)
    const results: BatchResult[] = []
    for (let i = 0; i < batches.length; i += BATCH_CONCURRENCY) {
      const slice = batches.slice(i, i + BATCH_CONCURRENCY)
      results.push(...(await Promise.all(slice.map((b) => reviewBatch(input, b, budget, system, model)))))
    }
    let findings = results.flatMap((r) => r.findings)
    const failed = results.filter((r) => r.state !== "ok")
    log.info("ai review complete", { findings: findings.length, batches: batches.length, failed: failed.length })
    // The lane is ok when any call answered; a partial failure is reported, not hidden.
    const spent = laneUsage(results)
    if (failed.length === results.length)
      return done([], { state: failed[0].state, reason: failed[0].reason, model: modelLabel, ...spent })
    const reason = failed.length ? `${failed.length} of ${results.length} calls failed: ${failed[0].reason}` : undefined
    // Opt-in: try to refute each finding with dbt evidence. Never throws.
    let verifier: VerifierStatus | undefined
    if (input.evidence && aiVerifyEnabled()) {
      const v = await runAiVerify({ findings, grounding: input.grounding, evidence: input.evidence, model })
      findings = v.findings
      verifier = v.status
    }
    return done(findings, { state: "ok", model: modelLabel, ...(reason ? { reason } : {}), ...spent, ...(verifier ? { verifier } : {}) })
  } catch (err) {
    log.error("ai review failed", { error: err })
    return done([], { state: "error", reason: safeReason(err), model: modelLabel })
  }
}

interface BatchResult {
  findings: Finding[]
  state: AiLaneState
  reason?: string
  usage?: BatchUsage
}

export interface BatchUsage {
  tokens: AiTokens
  cost: number
}

export function addUsage(a: BatchUsage, b: BatchUsage): BatchUsage {
  return {
    tokens: {
      input: a.tokens.input + b.tokens.input,
      inputTotal: a.tokens.inputTotal + b.tokens.inputTotal,
      output: a.tokens.output + b.tokens.output,
      reasoning: a.tokens.reasoning + b.tokens.reasoning,
      cacheRead: a.tokens.cacheRead + b.tokens.cacheRead,
    },
    cost: a.cost + b.cost,
  }
}

/** Lane-status accounting fields for a set of batch results: calls made, and
 *  tokens and cost summed over the calls that reported usage. */
export function laneUsage(results: Array<{ usage?: BatchUsage }>): Pick<AiLaneStatus, "tokens" | "cost" | "calls"> {
  const reported = results.flatMap((r) => (r.usage ? [r.usage] : []))
  if (!reported.length) return { calls: results.length }
  const total = reported.reduce(addUsage)
  return { tokens: total.tokens, cost: total.cost, calls: results.length }
}

/**
 * Tokens and cost of one drained stream, with the session's accounting rules.
 * Returns undefined when the provider reported nothing usable: accounting
 * never fails the lane.
 */
export async function streamUsage(
  stream: { totalUsage: PromiseLike<unknown>; providerMetadata: PromiseLike<unknown> },
  model: Pick<Provider.Model, "cost" | "api">,
): Promise<BatchUsage | undefined> {
  try {
    const usage = await stream.totalUsage
    const metadata = await stream.providerMetadata
    if (!usage) return undefined
    // Loaded lazily, as in learn/usage.ts, to keep the session module out of
    // this module's import graph.
    const { Session } = await import("@/session")
    const u = Session.getUsage({ model: model as Provider.Model, usage: usage as any, metadata: (metadata ?? undefined) as any })
    return {
      tokens: {
        input: u.tokens.input,
        inputTotal: u.tokens.inputTotal,
        output: u.tokens.output,
        reasoning: u.tokens.reasoning,
        cacheRead: u.tokens.cache.read,
      },
      cost: u.cost,
    }
  } catch (err) {
    log.warn("ai review usage unavailable", { error: err })
    return undefined
  }
}

/** One model call over a group of files: send, wait (bounded), parse and clamp in core. */
async function reviewBatch(
  input: AiReviewInput,
  files: AiReviewFile[],
  budget: AiInputBudget,
  system: string,
  model: Awaited<ReturnType<typeof Provider.getModel>>,
): Promise<BatchResult> {
  const message = buildUserMessage({ ...input, files }, budget.maxFileChars)
  const controller = new AbortController()
  const timeoutMs = aiTimeoutMs(message.length)
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const timedOut = (): BatchResult => ({ findings: [], state: "timeout", reason: `no answer within ${Math.round(timeoutMs / 1000)} s` })
  let usage: BatchUsage | undefined
  try {
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
    const stream = await LLM.stream({
      agent,
      user,
      system: [system],
      small: false,
      tools: {},
      model,
      abort: controller.signal,
      sessionID: user.sessionID,
      retries: 1,
      messages: [{ role: "user", content: message }],
    })
    const text = await readStreamText(stream)
    if (controller.signal.aborted) return timedOut()
    usage = await streamUsage(stream, model)
    if (!text) return { findings: [], state: "error", reason: "the model returned no text", usage }

    // Parse + clamp in core (the prompt-injection-resistant, advisory-only
    // contract). Returns already-validated, severity-clamped, file-checked items.
    const parseRes = await Dispatcher.call("altimate_core.review_ai_parse", {
      text,
      valid_files: files.map((f) => f.path),
    })
    // The core parser reports failure in-band (`success: false`) rather than
    // throwing; that is an error, never an "ok" run with no findings.
    const parsedRaw = ((parseRes.data ?? {}) as Record<string, unknown>).findings
    if (parseRes.success === false || !Array.isArray(parsedRaw))
      return {
        findings: [],
        state: "error",
        reason: `could not parse the model's answer: ${safeReason(parseRes.error ?? "no findings list")}`,
      }
    const parsed = parsedRaw as any[]
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
            rule: ruleId("ai-review", String(item.category)),
          }),
        )
      } catch (err) {
        log.warn("skipping malformed ai finding", { error: err })
      }
    }
    return { findings: out, state: "ok", usage }
  } catch (err) {
    if (controller.signal.aborted) return timedOut()
    return { findings: [], state: "error", reason: safeReason(err), usage }
  } finally {
    clearTimeout(timeout)
  }
}
