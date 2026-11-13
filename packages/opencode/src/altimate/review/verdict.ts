import z from "zod"
import { createHmac, createHash } from "node:crypto"
import { Finding, type Severity, catalogRuleId, findingOrigin } from "./finding"
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

/** Whether a finding may influence the verdict: deterministic engine
 *  findings always; catalog (pattern) findings only when the rubric names the
 *  rule in `blockingRules`; advisory AI findings never. */
export function verdictEligible(f: Finding, rubric: Rubric = DEFAULT_RUBRIC): boolean {
  const origin = findingOrigin(f)
  if (origin === "engine") return true
  if (origin === "ai") return false
  const rule = catalogRuleId(f)
  return !!rule && rubric.blockingRules.includes(rule)
}

/**
 * Compute the verdict purely from findings + rubric. Faithful to Cloudflare's
 * bias-toward-approval rubric:
 *  - any blocking-category `critical`            → REQUEST_CHANGES
 *  - >= warningPatternThreshold warnings         → REQUEST_CHANGES (risk pattern)
 *  - any finding at all                          → COMMENT
 *  - nothing                                     → APPROVE
 * Only verdict-eligible findings (see verdictEligible) count toward a block:
 * the docs promise that only the deterministic engine blocks, so a regex rule
 * or the AI lane can comment but never fail the gate on its own.
 */
export function computeIdealVerdict(findings: Finding[], rubric: Rubric = DEFAULT_RUBRIC): Verdict {
  if (findings.length === 0) return "APPROVE"
  const blockers = blockingCategories(rubric)
  const eligible = findings.filter((f) => verdictEligible(f, rubric))
  const hasBlockingCritical = eligible.some((f) => f.severity === "critical" && blockers.has(f.category))
  if (hasBlockingCritical) return "REQUEST_CHANGES"
  // Count only confidently-warned findings toward the risk pattern. Undecidable
  // ("unknown") warnings — e.g. equivalence that couldn't be proven — must not
  // accumulate into a block; that would let unprovable refactors fail the gate.
  const warningCount = eligible.filter((f) => f.severity === "warning" && f.confidence !== "unknown").length
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
  /** The altimate-code CLI release that generated this verdict — lets an
   *  auditor reconstruct which policy version applied months later, when
   *  the verdict envelope has outlived the running binary. */
  cliVersion: z.string().optional(),
})
export type EngineVersions = z.infer<typeof EngineVersions>

/** What the review looked at: the resolved base, and files it deliberately
 *  did not review. Signed with the rest of the envelope so a verdict computed
 *  against the wrong base, or with models left unverified, is auditable. */
export const ReviewScope = z.object({
  /** Ref the base was resolved from (e.g. `origin/deployment`). */
  baseRef: z.string().optional(),
  /** Merge-base commit the diff and the old file versions were taken from. */
  baseSha: z.string().optional(),
  baseSource: z
    .enum(["flag", "github_event", "github_env", "gitlab_env", "remote_default", "default_branch", "parent"])
    .optional(),
  /** dbt project directory relative to the repository root ("" = root). */
  projectRoot: z.string().optional(),
  /** Changed files outside the dbt project: counted, not reviewed. */
  outOfScopeFiles: z.number().int().nonnegative().optional(),
  /** Renames with unchanged content and name (pure moves): not re-reviewed. */
  movedUnchangedFiles: z.number().int().nonnegative().optional(),
  /** Models the engine lanes could not verify, with the reason. */
  unverified: z.array(z.object({ path: z.string(), reason: z.string() })).optional(),
})
export type ReviewScope = z.infer<typeof ReviewScope>

export const VerdictEnvelope = z.object({
  version: z.literal("1"),
  verdict: Verdict,
  /** The verdict before mode-gating, for audit (e.g. would-have-blocked). */
  idealVerdict: Verdict,
  mode: ReviewMode,
  tier: RiskTier,
  /** G1 — reasons the classifier assigned this tier (only when --explain-tier). */
  tierReasons: z.array(z.string()).optional(),
  /** G2 — true when --force-tier bypassed the classifier. Included in signature so
   *  a tampered envelope claiming natural tier can't fake a forced run. */
  tierForced: z.boolean().optional(),
  /** The classifier's original tier before --force-tier overrode it (G2). */
  tierClassified: RiskTier.optional(),
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
  /** True when a change-affecting source file was modified after the manifest
   *  was written (checked via mtime; see run.ts::detectStaleManifest). Durably
   *  records in the signed envelope that the verdict may have been computed
   *  against out-of-date metadata — a stderr warning alone is easy for CI to
   *  swallow. */
  staleManifest: z.boolean().optional(),
  /** Base resolution and review coverage (see ReviewScope). */
  scope: ReviewScope.optional(),
  /** The review policy applied: from the base branch, the working tree, or
   *  defaults; its hash; and settings the PR changes but that were not applied. */
  policy: z
    .object({
      source: z.enum(["base", "working_tree", "default"]),
      hash: z.string(),
      changedInPr: z.array(z.string()).optional(),
    })
    .optional(),
  /** Advisory AI lane outcome: ran, skipped, timed out or failed, and why. */
  ai: z
    .object({
      state: z.enum(["ok", "skipped", "timeout", "error"]),
      reason: z.string().optional(),
      model: z.string().optional(),
      durationMs: z.number().int().nonnegative().optional(),
    })
    .optional(),
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
  degraded?: boolean
  /** G1 — classifier reasons for the tier (only surfaced when explainTier=true). */
  tierReasons?: string[]
  /** G2 — set when --force-tier was applied. */
  tierForced?: boolean
  /** G2 — classifier's original tier before the force override. */
  tierClassified?: RiskTier
  /** True when mtime signals the manifest predates a change-affecting file. */
  staleManifest?: boolean
  scope?: ReviewScope
  ai?: VerdictEnvelope["ai"]
  policy?: VerdictEnvelope["policy"]
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
    tierReasons: input.tierReasons,
    tierForced: input.tierForced,
    tierClassified: input.tierClassified,
    findings: input.findings.map((f) => (f.origin ? f : { ...f, origin: findingOrigin(f) })),
    summary: summarize(input.findings, degraded),
    engine: EngineVersions.parse(input.engine ?? {}),
    manifestHash: input.manifestHash,
    staleManifest: input.staleManifest ? true : undefined,
    scope: input.scope,
    ai: input.ai,
    policy: input.policy,
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
