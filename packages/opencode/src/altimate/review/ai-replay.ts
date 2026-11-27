// altimate_change - new file: replay the AI lane's generator findings from an earlier envelope
//
// `ALTIMATE_REVIEW_AI_REPLAY=<path to a review --json envelope>` skips the
// generator model call and rebuilds its findings from that envelope: the AI
// findings it kept (with what the verifier added undone) plus the ones the
// verifier discarded (`ai.verifier.dropped`). The verifier then runs on them as
// usual, so verifier settings can be compared without paying for generation
// again. Ids are the stored ones; benchmark labels are keyed by them.
// Fidelity is approximate: discarded findings come back with bodies clamped to
// 600 characters, and kept ones after the orchestrator's anchoring/cleaning.
import { readFile } from "node:fs/promises"
import z from "zod"
import { Provider } from "@/provider/provider"
import { Log } from "@/altimate/util/log"
import { Finding, ReviewCategory, makeFinding, ruleId } from "./finding"
import type { AiLaneStatus, AiReviewInput, AiReviewResult } from "./ai-review"
import { runAiVerify, type VerifierStatus } from "./ai-verify"
import { switchOn } from "./ai-switches"
import { modelNameFromPath } from "./orchestrate"

const log = Log.create({ service: "ai-replay" })

/** The path of the envelope to replay, when replay is on. */
export function aiReplayPath(env: Record<string, string | undefined> = process.env): string | undefined {
  return env.ALTIMATE_REVIEW_AI_REPLAY || undefined
}

const Tokens = z.object({
  input: z.number(),
  inputTotal: z.number(),
  output: z.number(),
  reasoning: z.number(),
  cacheRead: z.number(),
})

/** The parts of an envelope replay reads; everything else is ignored. */
const ReplayEnvelope = z.object({
  findings: z.array(z.unknown()),
  ai: z
    .object({
      state: z.enum(["ok", "skipped", "timeout", "error"]),
      reason: z.string().optional(),
      model: z.string().optional(),
      tokens: Tokens.optional(),
      cost: z.number().optional(),
      calls: z.number().optional(),
      failedFiles: z.array(z.string()).optional(),
      verifier: z
        .object({
          discarded: z.number().optional(),
          dropped: z
            .array(
              z.object({
                id: z.string(),
                file: z.string(),
                startLine: z.number().optional(),
                title: z.string(),
                body: z.string(),
                category: z.string(),
                severity: z.string(),
              }),
            )
            .optional(),
          decisions: z
            .array(z.object({ id: z.string(), ts: z.object({ lowConfidence: z.boolean() }).partial().optional() }))
            .optional(),
        })
        .optional(),
    })
    .optional(),
})

export interface ReplayedLane {
  findings: Finding[]
  /** The stored generator status: state, reason, model, tokens, cost, calls, failed files. */
  status: Omit<AiLaneStatus, "durationMs" | "verifier">
  /** Problems found while rebuilding (findings that could not be recovered). */
  warnings: string[]
}

/**
 * Rebuild the generator's findings from a parsed envelope (pure). Kept AI
 * findings lose the verifier's record, its `Verified:` body suffix and the
 * tiers set after generation (the generator sets none); discarded ones are
 * rebuilt from `ai.verifier.dropped`. Order follows the verifier's
 * `decisions` (the generator's order) when recorded.
 */
export function replayFindings(raw: unknown): ReplayedLane {
  const env = ReplayEnvelope.parse(raw)
  const ai = env.ai
  if (!ai) throw new Error("the envelope has no AI lane status")
  const status: ReplayedLane["status"] = {
    state: ai.state,
    ...(ai.reason ? { reason: ai.reason } : {}),
    ...(ai.model ? { model: ai.model } : {}),
    ...(ai.tokens ? { tokens: ai.tokens } : {}),
    ...(ai.cost !== undefined ? { cost: ai.cost } : {}),
    ...(ai.calls !== undefined ? { calls: ai.calls } : {}),
    ...(ai.failedFiles?.length ? { failedFiles: ai.failedFiles } : {}),
    replayed: true,
  }
  const warnings: string[] = []
  const out: Finding[] = []
  for (const item of env.findings) {
    const parsed = Finding.safeParse(item)
    if (!parsed.success || parsed.data.evidence?.tool !== "ai-review") continue
    out.push(unverify(parsed.data))
  }

  const v = ai.verifier
  const lowConfidence = new Map((v?.decisions ?? []).map((d) => [d.id, d.ts?.lowConfidence === true]))
  for (const d of v?.dropped ?? []) {
    const category = ReviewCategory.safeParse(d.category)
    if (!category.success) {
      warnings.push(`discarded finding ${d.id} has an unknown category "${d.category}"`)
      continue
    }
    // The envelope does not keep a discarded finding's confidence; the verifier reads only whether it is low.
    const confidence = lowConfidence.get(d.id) ? ("low" as const) : ("medium" as const)
    out.push(
      makeFinding({
        id: d.id,
        severity: d.severity === "warning" ? "warning" : "suggestion",
        category: category.data,
        title: d.title,
        body: d.body,
        file: d.file,
        model: modelNameFromPath(d.file),
        ...(d.startLine ? { startLine: d.startLine, endLine: d.startLine } : {}),
        confidence,
        evidence: { tool: "ai-review", result: { confidence } },
        rule: ruleId("ai-review", d.category),
      }),
    )
  }

  const listed = v?.dropped?.length ?? 0
  if ((v?.discarded ?? 0) > listed)
    warnings.push(`the verifier discarded ${v!.discarded} findings but the envelope lists ${listed}`)
  const have = new Set(out.map((f) => f.id))
  const missing = (v?.decisions ?? []).filter((d) => !have.has(d.id)).length
  if (missing) warnings.push(`${missing} findings the verifier decided are not in the envelope`)

  if (v?.decisions?.length) {
    const order = new Map(v.decisions.map((d, i) => [d.id, i]))
    out.sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity))
  }
  return { findings: out, status: warnings.length ? { ...status, replayIncomplete: true } : status, warnings }
}

/** A kept finding close to how the generator returned it: no verification record, body suffix,
 *  tier, origin, or the orchestrator's `preExisting` / `evidenceLine` (re-derived on the next run). */
function unverify(f: Finding): Finding {
  const { tier: _tier, origin: _origin, preExisting: _pre, evidenceLine: _line, groupedInto: _grouped, ...rest } = f
  // Convention grouping runs again on replay (after the verifier): drop the lead's list of the other files.
  let body = f.body.replace(/\n\nThe same applies to: [^\n]*\.$/, "")
  const prior = f.evidence?.result
  if (!prior || typeof prior !== "object") return { ...rest, body }
  const { verification, ...result } = prior as Record<string, unknown> & {
    verification?: { rule?: string; evidence?: string }
  }
  const suffix = verification?.rule === "verified" && verification.evidence ? `\n\nVerified: ${verification.evidence}` : ""
  if (suffix && body.endsWith(suffix)) body = body.slice(0, -suffix.length)
  return { ...rest, body, evidence: { tool: "ai-review", result } }
}

/**
 * The AI lane in replay mode: no generator call. Fails loudly (stderr) and
 * reports `state: "error"` when the envelope cannot be read; never falls back
 * to calling the generator.
 */
export async function runAiReplay(input: AiReviewInput, path: string): Promise<AiReviewResult> {
  const startedAt = Date.now()
  const done = (findings: Finding[], status: Omit<AiLaneStatus, "durationMs">): AiReviewResult => ({
    findings,
    status: { ...status, durationMs: Date.now() - startedAt },
  })
  let lane: ReplayedLane
  try {
    lane = replayFindings(JSON.parse(await readFile(path, "utf8")))
  } catch (err) {
    const reason = `cannot replay ${path}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300)
    process.stderr.write(`altimate review: ALTIMATE_REVIEW_AI_REPLAY: ${reason}\n`)
    log.error("ai replay failed", { path, error: err })
    return done([], { state: "error", reason, replayed: true })
  }
  for (const w of lane.warnings) {
    process.stderr.write(`altimate review: ALTIMATE_REVIEW_AI_REPLAY: ${w}\n`)
    log.warn("ai replay incomplete", { path, warning: w })
  }
  log.info("ai replay", { path, findings: lane.findings.length })
  if (lane.status.state !== "ok") return done([], lane.status)

  let findings = lane.findings
  let verifier: VerifierStatus | undefined
  if (input.evidence && switchOn("verify", input.switches)) {
    let model: Awaited<ReturnType<typeof Provider.getModel>>
    try {
      const chosen = input.model ? Provider.parseModel(input.model) : await Provider.defaultModel()
      model = await Provider.getModel(chosen.providerID, chosen.modelID)
    } catch (err) {
      // Fail open: the replayed generator findings stand, unverified.
      const reason = `no usable model: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200)
      const n = findings.length
      const skipped: VerifierStatus = {
        state: "skipped",
        reason,
        durationMs: 0,
        turns: 0,
        toolCalls: 0,
        reviewed: 0,
        kept: n,
        discarded: 0,
        summary: 0,
        unreviewed: n,
      }
      return done(findings, { ...lane.status, verifier: skipped })
    }
    const v = await runAiVerify({ findings, grounding: input.grounding, evidence: input.evidence, model })
    findings = v.findings
    verifier = v.status
  }
  return done(findings, { ...lane.status, ...(verifier ? { verifier } : {}) })
}
