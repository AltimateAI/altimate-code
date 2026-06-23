import z from "zod"
import { createHmac, createHash } from "node:crypto"
import { Finding, type Severity } from "./finding"
import { Rubric, DEFAULT_RUBRIC, blockingCategories } from "./rubric"

/**
 * The verdict contract — the signed, replayable artifact that is altimate's
 * stated moat. Every verdict is mechanically derived from the findings + the
 * rubric (never from model free-text) and signed so it is tamper-evident and
 * reproducible against the customer's manifest.
 */

/** The ideal verdict before mode-gating. */
export const Verdict = z.enum(["APPROVE", "COMMENT", "REQUEST_CHANGES"])
export type Verdict = z.infer<typeof Verdict>

/** How aggressively the verdict is enforced on the PR. */
export const ReviewMode = z.enum([
  "comment", // never block; post findings as comments (default, frictionless)
  "gate", // map REQUEST_CHANGES to a blocking review + failing check
])
export type ReviewMode = z.infer<typeof ReviewMode>

/** Maps a Verdict to a VCS review event.
 *
 * An `APPROVE` verdict posts a **COMMENT** review event, NOT a GitHub "APPROVE".
 * The reviewer is a bot: it must never submit a formal approval that could
 * satisfy branch protection / required reviews and let a PR merge without human
 * sign-off (matching CodeRabbit/Greptile/etc., which comment but never approve).
 * The "approved — no findings" outcome is conveyed in the comment body instead.
 * `REQUEST_CHANGES` still maps through (in `gate` mode it blocks; `comment` mode
 * softens it to COMMENT via {@link applyMode}).
 *
 * The value type deliberately EXCLUDES `"APPROVE"`: the no-formal-approval
 * invariant is enforced at compile time, so no future edit can map a verdict
 * back to a GitHub APPROVE without breaking the build. (The narrower union is
 * still assignable to Octokit's `createReview` event param.) */
export const VCS_EVENT: Record<Verdict, "COMMENT" | "REQUEST_CHANGES"> = {
  APPROVE: "COMMENT",
  COMMENT: "COMMENT",
  REQUEST_CHANGES: "REQUEST_CHANGES",
}

/**
 * Compute the verdict purely from findings + rubric. Faithful to Cloudflare's
 * bias-toward-approval rubric:
 *  - any blocking-category `critical`            → REQUEST_CHANGES
 *  - >= warningPatternThreshold warnings         → REQUEST_CHANGES (risk pattern)
 *  - any finding at all                          → COMMENT
 *  - nothing                                     → APPROVE
 */
export function computeIdealVerdict(findings: Finding[], rubric: Rubric = DEFAULT_RUBRIC): Verdict {
  if (findings.length === 0) return "APPROVE"
  const blockers = blockingCategories(rubric)
  const hasBlockingCritical = findings.some((f) => f.severity === "critical" && blockers.has(f.category))
  if (hasBlockingCritical) return "REQUEST_CHANGES"
  // Count only confidently-warned findings toward the risk pattern. Undecidable
  // ("unknown") warnings — e.g. equivalence that couldn't be proven — must not
  // accumulate into a block; that would let unprovable refactors fail the gate.
  // Advisory LLM findings (layer 3) are EXCLUDED: the lane is advisory-only and must
  // never influence the verdict, so its warnings cannot accumulate into a block
  // (otherwise a chatty or prompt-injected AI review could force REQUEST_CHANGES).
  const warningCount = findings.filter(
    (f) => f.severity === "warning" && f.confidence !== "unknown" && f.evidence?.tool !== "ai-review",
  ).length
  if (warningCount >= rubric.warningPatternThreshold) return "REQUEST_CHANGES"
  return "COMMENT"
}

/** Apply mode-gating: in `comment` mode, REQUEST_CHANGES is softened to COMMENT. */
export function applyMode(verdict: Verdict, mode: ReviewMode): Verdict {
  if (mode === "comment" && verdict === "REQUEST_CHANGES") return "COMMENT"
  // APPROVE and COMMENT pass through unchanged in both modes — the no-formal-
  // approval guarantee for APPROVE lives solely in the VCS_EVENT map, not here.
  return verdict
}

export const RiskTier = z.enum(["trivial", "lite", "full"])
export type RiskTier = z.infer<typeof RiskTier>

export const EngineVersions = z.object({
  reviewer: z.string().default("dbt-pr-review/1"),
  core: z.string().optional(),
  model: z.string().optional(),
})
export type EngineVersions = z.infer<typeof EngineVersions>

export const VerdictEnvelope = z.object({
  version: z.literal("1"),
  verdict: Verdict,
  /** The verdict before mode-gating, for audit (e.g. would-have-blocked). */
  idealVerdict: Verdict,
  mode: ReviewMode,
  tier: RiskTier,
  findings: z.array(Finding),
  summary: z.object({
    critical: z.number().int().nonnegative(),
    warning: z.number().int().nonnegative(),
    suggestion: z.number().int().nonnegative(),
    /** True when the review ran without a manifest/warehouse (lint-only). */
    degraded: z.boolean(),
  }),
  engine: EngineVersions,
  /** Hash of the dbt manifest the verdict was computed against, when present. */
  manifestHash: z.string().optional(),
  /** ISO timestamp; injected by the caller (no clock access in pure code). */
  generatedAt: z.string().optional(),
  /** Optional break-glass override record. */
  override: z
    .object({
      by: z.string(),
      reason: z.string(),
      priorVerdict: Verdict,
    })
    .optional(),
  /** HMAC-SHA256 over the canonical body (added by signEnvelope). */
  signature: z.string().optional(),
})
export type VerdictEnvelope = z.infer<typeof VerdictEnvelope>

export interface BuildEnvelopeInput {
  findings: Finding[]
  tier: RiskTier
  mode: ReviewMode
  rubric?: Rubric
  engine?: Partial<EngineVersions>
  manifestHash?: string
  generatedAt?: string
  degraded?: boolean
}

function summarize(findings: Finding[], degraded: boolean): VerdictEnvelope["summary"] {
  const tally: Record<Severity, number> = { critical: 0, warning: 0, suggestion: 0 }
  for (const f of findings) tally[f.severity]++
  return { critical: tally.critical, warning: tally.warning, suggestion: tally.suggestion, degraded }
}

/** Assemble the verdict envelope (unsigned). Call signEnvelope to sign it. */
export function buildEnvelope(input: BuildEnvelopeInput): VerdictEnvelope {
  const rubric = input.rubric ?? DEFAULT_RUBRIC
  const ideal = computeIdealVerdict(input.findings, rubric)
  const verdict = applyMode(ideal, input.mode)
  const degraded = input.degraded ?? input.findings.some((f) => f.degraded)
  return VerdictEnvelope.parse({
    version: "1",
    verdict,
    idealVerdict: ideal,
    mode: input.mode,
    tier: input.tier,
    findings: input.findings,
    summary: summarize(input.findings, degraded),
    engine: EngineVersions.parse(input.engine ?? {}),
    manifestHash: input.manifestHash,
    generatedAt: input.generatedAt,
  })
}

/**
 * Deterministic serialization with object keys sorted at EVERY depth and array
 * order preserved. Note: `JSON.stringify(obj, keysArray)` cannot be used here —
 * an array replacer is a recursive key-allowlist, so nested `findings[]` fields
 * (whose keys aren't top-level envelope keys) would be dropped and the signature
 * would not cover finding content. This walks the value instead.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]"
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}"
}

/** Canonical, signature-independent serialization for hashing/signing. */
export function canonicalBody(env: VerdictEnvelope): string {
  const { signature: _sig, ...rest } = env
  return stableStringify(rest)
}

/**
 * Sign the envelope with HMAC-SHA256. The key comes from
 * ALTIMATE_REVIEW_SIGNING_KEY; when absent we fall back to an unkeyed digest
 * (still tamper-evident for replay, but not authenticated) and mark it so.
 */
export function signEnvelope(env: VerdictEnvelope, key?: string): VerdictEnvelope {
  const signingKey = key ?? process.env["ALTIMATE_REVIEW_SIGNING_KEY"]
  const body = canonicalBody(env)
  const signature = signingKey
    ? "hmac:" + createHmac("sha256", signingKey).update(body).digest("hex")
    : "sha256:" + createHash("sha256").update(body).digest("hex")
  return { ...env, signature }
}

/** Verify a signed envelope. Returns true when the signature matches. */
export function verifyEnvelope(env: VerdictEnvelope, key?: string): boolean {
  if (!env.signature) return false
  const recomputed = signEnvelope({ ...env, signature: undefined }, key).signature
  return recomputed === env.signature
}

/** Record a break-glass override on an envelope and re-sign it. */
export function applyOverride(env: VerdictEnvelope, by: string, reason: string, key?: string): VerdictEnvelope {
  const overridden: VerdictEnvelope = {
    ...env,
    verdict: "COMMENT",
    override: { by, reason, priorVerdict: env.verdict },
    signature: undefined,
  }
  return signEnvelope(overridden, key)
}
