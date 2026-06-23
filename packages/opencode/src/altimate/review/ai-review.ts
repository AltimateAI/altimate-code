// altimate_change - LLM reviewer lane (transport only; prompt + parse live in core)
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { Agent } from "@/agent/agent"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, SessionID } from "@/session/schema"
import { Log } from "@/util/log"
import { Dispatcher } from "../native"
import { type Finding, type ReviewCategory, type Severity, makeFinding } from "./finding"

const log = Log.create({ service: "ai-review" })

const AI_TIMEOUT_MS = 60_000
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
  prTitle?: string
  prBody?: string
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
 * Run the LLM reviewer lane. Returns advisory findings (severity ≤ warning,
 * clamped by core), or [] if no model / core is available or the call fails —
 * a review must never crash because the AI layer is unavailable.
 */
export async function runAiReview(input: AiReviewInput): Promise<Finding[]> {
  const files = input.files.filter((f) => f.status !== "deleted" && (f.diff || f.sql))
  if (!files.length) return []

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS)
  try {
    // Prompt comes from the compiled core, not this file.
    const promptRes = await Dispatcher.call("altimate_core.review_ai_prompt", {})
    const system = ((promptRes.data ?? {}) as Record<string, unknown>).prompt as string | undefined
    if (!system) return []

    const defaultModel = await Provider.defaultModel()
    const model = await Provider.getModel(defaultModel.providerID, defaultModel.modelID)

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
      messages: [{ role: "user", content: buildUserMessage({ ...input, files }) }],
    })
    for await (const _ of stream.fullStream) {
      // drain to avoid SDK hangs
    }
    const text = await Promise.resolve(stream.text).catch((err: unknown) => {
      log.error("ai review stream failed", { error: err })
      return undefined
    })
    if (!text) return []

    // Parse + clamp in core (the prompt-injection-resistant, advisory-only
    // contract). Returns already-validated, severity-clamped, file-checked items.
    const parseRes = await Dispatcher.call("altimate_core.review_ai_parse", {
      text,
      valid_files: files.map((f) => f.path),
    })
    const parsed = (((parseRes.data ?? {}) as Record<string, unknown>).findings as any[]) ?? []
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
    log.info("ai review complete", { findings: out.length })
    return out
  } catch (err) {
    log.error("ai review failed", { error: err })
    return []
  } finally {
    clearTimeout(timeout)
  }
}
