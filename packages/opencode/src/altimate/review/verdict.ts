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

export const AiReviewStatus = z.enum(["ok", "skipped", "timeout", "error"])
export type AiReviewStatus = z.infer<typeof AiReviewStatus>
export const NO_MODEL_REASON =
  "no AI model configured (set aiModel in .altimate/review.yml, --ai-model, or the action's model inputs)"

export const AiReviewSummary = z.object({
  status: AiReviewStatus,
  reason: z.string().optional(),
  findings: z.number().int().nonnegative(),
  /** Effective provider/model used by the advisory lane. */
  model: z.string().optional(),
})
export type AiReviewSummary = z.infer<typeof AiReviewSummary>

export interface ReviewPolicySignatureInput {
  severityThreshold: Severity
  enabledReviewers: string[]
  dialect: string
  rubric: Rubric
  aiEnabled: boolean
  /** Explicit advisory model, or `session` when the active session is used. */
  aiModel?: string
  dataDiff: {
    enabled: boolean
    warehouse: string
  }
}

function normalizePolicyValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizePolicyValue)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, normalizePolicyValue(item)]),
    )
  }
  return value
}

/** Compact fingerprint for the settings that determine which findings surface. */
export function makeReviewPolicySignature(input: ReviewPolicySignatureInput): string {
  const { excludeGlobs, ...booleanExclusions } = input.rubric.exclusions
  const enabledExclusions = Object.entries(booleanExclusions)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name)
    .sort()
  const body = JSON.stringify(
    normalizePolicyValue({
      severityThreshold: input.severityThreshold,
      enabledReviewers: [...new Set(input.enabledReviewers)].sort(),
      dialect: input.dialect,
      exclusions: {
        excludeGlobs: [...new Set(excludeGlobs)].sort(),
        enabled: enabledExclusions,
      },
      rubric: {
        version: input.rubric.version,
        blockOn: [...new Set(input.rubric.blockOn)].sort(),
        warningPatternThreshold: input.rubric.warningPatternThreshold,
        thresholds: input.rubric.thresholds,
      },
      aiEnabled: input.aiEnabled,
      aiModel: input.aiModel,
      dataDiff: input.dataDiff,
    }),
  )
  return createHash("sha256").update(body).digest("hex").slice(0, 16)
}

const ReviewSummary = z.object({
  critical: z.number().int().nonnegative(),
  warning: z.number().int().nonnegative(),
  suggestion: z.number().int().nonnegative(),
  /** Compatibility flag for lintOnly or emptyScope. Never reflects individual undecidable findings. */
  degraded: z.boolean(),
  /** True when no changed model resolved against a dbt manifest. */
  lintOnly: z.boolean().optional(),
  /** True when the diff contains no reviewable dbt files. */
  emptyScope: z.boolean().optional(),
  /** Surfaced findings whose deterministic analysis could not decide. */
  undecidableFindings: z.number().int().nonnegative().optional(),
  /** Missing dbt artifacts that reduce lineage/equivalence fidelity. */
  artifactHints: z.array(z.string()).optional(),
  /** Advisory AI lane outcome, when that lane applied. */
  aiReview: AiReviewSummary.optional(),
})

export const EngineVersions = z.object({
  reviewer: z.string().default("dbt-pr-review/1"),
  core: z.string().optional(),
  model: z.string().optional(),
  /** The altimate-code CLI release that generated this verdict — lets an
   *  auditor reconstruct which policy version applied months later, when
   *  the verdict envelope has outlived the running binary. */
  cliVersion: z.string().optional(),
})
export type EngineVersions = z.infer<typeof EngineVersions>

export const VerdictEnvelope = z.object({
  version: z.literal("1"),
  verdict: Verdict,
  /** The verdict before mode-gating, for audit (e.g. would-have-blocked). */
  idealVerdict: Verdict,
  mode: ReviewMode,
  tier: RiskTier,
  /** Fingerprint of the user-configured review settings used for this run. */
  policySignature: z.string().optional(),
  /** G1 — reasons the classifier assigned this tier (only when --explain-tier). */
  tierReasons: z.array(z.string()).optional(),
  /** G2 — true when --force-tier bypassed the classifier. Included in signature so
   *  a tampered envelope claiming natural tier can't fake a forced run. */
  tierForced: z.boolean().optional(),
  /** The classifier's original tier before --force-tier overrode it (G2). */
  tierClassified: RiskTier.optional(),
  findings: z.array(Finding),
  summary: ReviewSummary,
  engine: EngineVersions,
  /** Hash of the dbt manifest the verdict was computed against, when present. */
  manifestHash: z.string().optional(),
  /** True when a change-affecting source file was modified after the manifest
   *  was written (checked via mtime; see run.ts::detectStaleManifest). Durably
   *  records in the signed envelope that the verdict may have been computed
   *  against out-of-date metadata — a stderr warning alone is easy for CI to
   *  swallow. */
  staleManifest: z.boolean().optional(),
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
}).superRefine((env, ctx) => {
  // G2 audit invariant — enforced at the envelope boundary so a hand-built
  // envelope (bypassing runReview) can't sign inconsistent forced-tier
  // metadata. When --force-tier is used, BOTH tierForced=true AND
  // tierClassified must be present (per PR #1027 consensus MINOR #2).
  const hasForced = env.tierForced === true
  const hasClassified = env.tierClassified !== undefined
  if (hasForced !== hasClassified) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "tierForced and tierClassified must both be present or both absent: " +
        `tierForced=${env.tierForced}, tierClassified=${env.tierClassified ?? "undefined"}`,
      path: ["tierForced"],
    })
  }
  // tierForced: false is not a legitimate state — the flag records
  // "was --force-tier used?" as a positive marker; false is indistinguishable
  // from a natural (unforced) run and only adds noise to the canonical body.
  if (env.tierForced === false) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "tierForced must be true or undefined, not false",
      path: ["tierForced"],
    })
  }
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
  /** Run-level lint-only flag. */
  lintOnly?: boolean
  /** Run-level empty-review-scope flag. */
  emptyScope?: boolean
  /** Compatibility input alias for lintOnly. */
  degraded?: boolean
  artifactHints?: string[]
  aiReview?: AiReviewSummary
  policySignature?: string
  /** G1 — classifier reasons for the tier (only surfaced when explainTier=true). */
  tierReasons?: string[]
  /** G2 — set when --force-tier was applied. */
  tierForced?: boolean
  /** G2 — classifier's original tier before the force override. */
  tierClassified?: RiskTier
  /** True when mtime signals the manifest predates a change-affecting file. */
  staleManifest?: boolean
}

function summarize(
  findings: Finding[],
  lintOnly: boolean,
  emptyScope: boolean | undefined,
  artifactHints: string[],
  aiReview?: AiReviewSummary,
): VerdictEnvelope["summary"] {
  const tally: Record<Severity, number> = { critical: 0, warning: 0, suggestion: 0 }
  for (const f of findings) tally[f.severity]++
  return {
    critical: tally.critical,
    warning: tally.warning,
    suggestion: tally.suggestion,
    degraded: lintOnly || emptyScope === true,
    lintOnly,
    emptyScope,
    undecidableFindings: findings.filter((f) => f.degraded).length,
    artifactHints,
    aiReview,
  }
}

/** Assemble the verdict envelope (unsigned). Call signEnvelope to sign it. */
export function buildEnvelope(input: BuildEnvelopeInput): VerdictEnvelope {
  const rubric = input.rubric ?? DEFAULT_RUBRIC
  const ideal = computeIdealVerdict(input.findings, rubric)
  const verdict = applyMode(ideal, input.mode)
  const lintOnly = input.lintOnly ?? input.degraded ?? false
  return VerdictEnvelope.parse({
    version: "1",
    verdict,
    idealVerdict: ideal,
    mode: input.mode,
    tier: input.tier,
    policySignature: input.policySignature,
    tierReasons: input.tierReasons,
    tierForced: input.tierForced,
    tierClassified: input.tierClassified,
    findings: input.findings,
    summary: summarize(input.findings, lintOnly, input.emptyScope, input.artifactHints ?? [], input.aiReview),
    engine: EngineVersions.parse(input.engine ?? {}),
    manifestHash: input.manifestHash,
    staleManifest: input.staleManifest ? true : undefined,
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
