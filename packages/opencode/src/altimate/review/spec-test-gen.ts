// altimate_change - greenfield spec-test synthesis (P0: advisory transport + guard)
import { createHash } from "node:crypto"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { Agent } from "@/agent/agent"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, SessionID } from "@/session/schema"
import { Log } from "@/util/log"

/**
 * Auxiliary spec-test synthesis for GREENFIELD (git-added) dbt models.
 *
 * A brand-new model has no base to diff against, so the equivalence / data-diff
 * lanes (which own the reference-exists world) can't verify it. This feature
 * instead works in TWO strictly separated tracks — see
 * specs/greenfield-spec-test-synthesis.md:
 *
 *   Track A (block-eligible, NO LLM): materialize dbt constraints the author
 *     DECLARED but did not enforce (schema.yml not_null/unique/accepted_values/
 *     relationships, contract types). The assertion is built from the PARSED
 *     constraint, not from model text — no LLM is in this loop, so it cannot be
 *     tricked into a back-labeled false positive. An executed failure is a real
 *     contract violation.
 *
 *   Track B (advisory, LLM): propose NEW tests from soft intent (column
 *     descriptions, ref() edges, PR text). These are hypotheses — emitted at
 *     confidence "unknown" under a dedicated evidence tool and STRUCTURALLY
 *     excluded from the verdict. They never block; at worst they are noise in a
 *     proposed patch.
 *
 * IP boundary: P0 intentionally inlines a minimal prompt in TS for speed. The
 * track-B generation prompt and response parse/clamp should move into compiled
 * core (`altimate_core.review_spec_test_*`) before GA. The DETERMINISTIC guard
 * below MUST stay in open TS: it is inspectable and unit-tested, never a black box.
 */

const log = Log.create({ service: "spec-test-gen" })

const SPEC_TEST_GEN_TIMEOUT_MS = 60_000
const MAX_SPEC_SOURCES = 80

/** Whether a spec source is an author-DECLARED constraint (machine-readable,
 *  block-eligible) or merely INFERRED context (advisory only). This split — not
 *  a tag check — is what keeps the feature honest. */
export type SpecOrigin = "declared_constraint" | "inferred_context"

/**
 * A source of author intent. `declared_constraint` sources are parsed dbt
 * constraints; `inferred_context` sources are soft signals the LLM may propose
 * from. Extracted from the dbt project BEFORE generation — the generator never
 * reads the model's current output, so a test can only be grounded in stated
 * intent, not observed behavior.
 */
export interface SpecSource {
  origin: SpecOrigin
  kind:
    | "not_null"
    | "unique"
    | "accepted_values"
    | "relationships"
    | "column_type" // declared_constraint kinds ↑
    | "schema_desc"
    | "ref_edge"
    | "pr_intent" // inferred_context kinds ↑
  /** Stable identifier of the spec element we extracted, e.g.
   *  "schema.yml:dim_customer.email" or "ref:stg_customers". Generated tests cite
   *  this in `derivedFrom.ref`; the guard rejects any citation we did not provide. */
  ref: string
  /** The declared text/value/description, when any. */
  text?: string
  /** Parsed constraint args (accepted_values set, relationships target). */
  args?: Record<string, unknown>
}

/** Test classes. `not_null`/`unique`/`accepted_values`/`relationships`/
 *  `column_type` map to track-A declared constraints; `range` is an
 *  inferred-context proposal. No golden/snapshot class exists — current output
 *  is never an expected value. */
export type GeneratedTestKind = "not_null" | "unique" | "accepted_values" | "relationships" | "column_type" | "range"

/** Kinds that can derive from a declared constraint (track A, block-eligible when
 *  executed). `range` and any description-derived test are advisory only. */
export const DECLARED_CONSTRAINT_KINDS: ReadonlySet<GeneratedTestKind> = new Set<GeneratedTestKind>([
  "not_null",
  "unique",
  "accepted_values",
  "relationships",
  "column_type",
])

/** All kinds a proposal may carry; a test whose `kind` is outside this set is
 *  dropped by the advisory-track guard. */
export const ALLOWED_TEST_KINDS: ReadonlySet<GeneratedTestKind> = new Set<GeneratedTestKind>([
  "not_null",
  "unique",
  "accepted_values",
  "relationships",
  "range",
])

export interface GeneratedTest {
  /** Deterministic id. `runGeneratedTests` returns results KEYED BY this id, so a
   *  dropped/errored/batched test can never attach its result to the wrong test. */
  id: string
  kind: GeneratedTestKind
  /** Preferred: a dbt schema test spec (persists as YAML). */
  dbtTest?: { column?: string; test: string; args?: Record<string, unknown> }
  /** Advisory track only, and sandboxed before execution (SELECT-only, allowlisted
   *  relations, row cap, timeout). Track A never uses raw SQL — it materializes
   *  bounded dbt generic tests from the parsed constraint. */
  assertionSql?: string
  /** Why this test follows from the cited spec element. */
  rationale: string
  /** REQUIRED. The intent source this test derives from. `derivedFrom.origin`
   *  decides block-eligibility: `declared_constraint` (track A) can block when
   *  executed; `inferred_context` (track B) never blocks. */
  derivedFrom: SpecSource
}

export interface SpecTestGenInput {
  model: string
  file: string
  dialect: string
  /** dbt-compiled SQL — context only; NEVER used to derive an expected value. */
  compiledSql: string
  /** Author intent, extracted before generation (both origins). */
  specSources: SpecSource[]
  /** Upstream models + their output columns (for referential proposals). */
  upstream: Array<{ model: string; columns: string[] }>
  prTitle?: string
  prBody?: string
  /** Learned per-repo priors (corrective-app-memory.md) — bias only, P2. */
  priors?: Array<{ derivedFromKind: string; polarity: "prefer" | "suppress" }>
}

/** Per-test execution outcome (P1). 0 violating rows = pass. */
export interface GeneratedTestResult {
  status: "pass" | "fail" | "error"
  violatingRows?: number
  detail?: string
}

/** Reason a proposal was rejected by the advisory-track guard. */
export type GuardDropReason = "no_derived_from" | "kind_not_allowed" | "empty_ref" | "ref_not_provided"

/**
 * ADVISORY-TRACK anti-fabrication guard (deterministic; no LLM trust).
 *
 * NOTE ON SCOPE: this is NOT what makes the feature sound — the block path is
 * kept safe by having no LLM in it at all (track A materializes from parsed
 * constraints). This guard hardens the ADVISORY track: it drops LLM proposals
 * that are unusable or fabricated, so the proposed-test patch stays grounded.
 *
 * Keep a proposal ONLY when:
 *   1. it carries a `derivedFrom`,
 *   2. whose `kind` is allowed, and
 *   3. whose `ref` is EXACTLY one of the `providedSources` refs — a spec element
 *      WE extracted, not a string the model invented (anti-fabrication).
 *
 * It deliberately does NOT try to prove the assertion follows from the ref — a
 * back-labeled test can still pass this. That is acceptable precisely because a
 * proposal can never block (verdict excludes the proposed tool); the block path
 * does not rely on this function.
 *
 * Pure and total: same inputs → same partition. Unit-tested.
 */
export function filterToSpecDerived(
  tests: GeneratedTest[],
  providedSources: SpecSource[],
): { kept: GeneratedTest[]; dropped: Array<{ test: GeneratedTest; reason: GuardDropReason }> } {
  const providedRefs = new Set(providedSources.map((s) => s.ref))
  const kept: GeneratedTest[] = []
  const dropped: Array<{ test: GeneratedTest; reason: GuardDropReason }> = []
  for (const t of tests) {
    const df = t.derivedFrom
    if (!df) {
      dropped.push({ test: t, reason: "no_derived_from" })
      continue
    }
    if (!ALLOWED_TEST_KINDS.has(t.kind)) {
      dropped.push({ test: t, reason: "kind_not_allowed" })
      continue
    }
    if (!df.ref || !df.ref.trim()) {
      dropped.push({ test: t, reason: "empty_ref" })
      continue
    }
    if (!providedRefs.has(df.ref)) {
      dropped.push({ test: t, reason: "ref_not_provided" })
      continue
    }
    kept.push(t)
  }
  return { kept, dropped }
}

/**
 * Is a generated test eligible to BLOCK a PR (when executed and failed)?
 * True only for track-A tests: a declared-constraint origin AND a
 * declared-constraint kind. Never true for anything the LLM proposed from soft
 * intent. The verdict layer enforces the execution requirement separately.
 */
export function isBlockEligible(test: GeneratedTest): boolean {
  return test.derivedFrom.origin === "declared_constraint" && DECLARED_CONSTRAINT_KINDS.has(test.kind)
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]"
  const obj = value as Record<string, unknown>
  return (
    "{" +
    Object.keys(obj)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + stableJson(obj[k]))
      .join(",") +
    "}"
  )
}

function generatedTestId(test: GeneratedTest): string {
  const payload = stableJson({
    kind: test.kind,
    ref: test.derivedFrom?.ref ?? "",
    dbtTest: test.dbtTest ?? null,
    assertionSql: test.assertionSql ?? "",
  })
  return "gst_" + createHash("sha256").update(payload).digest("hex").slice(0, 16)
}

function buildSystemPrompt(): string {
  return [
    "You propose dbt generic tests for a newly added dbt model.",
    "Rules:",
    "- Use ONLY the provided specSources. Do not infer expected values from current output or observed data.",
    "- Propose dbt generic tests only. Fill dbtTest; do not use assertionSql.",
    "- Every proposal must copy one derivedFrom object from specSources exactly, including derivedFrom.ref.",
    "- The derivedFrom.ref must be one of the provided refs. Never invent refs.",
    "- Allowed kind values: not_null, unique, accepted_values, relationships, range.",
    "- Return ONLY a JSON array of GeneratedTest objects. Return [] when there is no grounded proposal.",
  ].join("\n")
}

function buildUserMessage(input: SpecTestGenInput): string {
  return JSON.stringify(
    {
      model: input.model,
      file: input.file,
      dialect: input.dialect,
      specSources: input.specSources.slice(0, MAX_SPEC_SOURCES),
      upstream: input.upstream,
    },
    null,
    2,
  )
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  return fenced ? fenced[1].trim() : trimmed
}

function objectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function normalizeDbtTest(value: unknown): GeneratedTest["dbtTest"] | undefined {
  const obj = objectOrUndefined(value)
  if (!obj || typeof obj.test !== "string" || !obj.test.trim()) return undefined
  const args = objectOrUndefined(obj.args)
  return {
    column: typeof obj.column === "string" && obj.column.trim() ? obj.column : undefined,
    test: obj.test,
    args,
  }
}

function parseGeneratedTests(text: string): GeneratedTest[] {
  const raw = JSON.parse(stripJsonFence(text))
  if (!Array.isArray(raw)) return []
  const out: GeneratedTest[] = []
  for (const item of raw) {
    const obj = objectOrUndefined(item)
    if (!obj) continue
    const dbtTest = normalizeDbtTest(obj.dbtTest)
    if (!dbtTest) continue
    const test: GeneratedTest = {
      id: "",
      kind: String(obj.kind ?? "") as GeneratedTestKind,
      dbtTest,
      rationale: typeof obj.rationale === "string" ? obj.rationale : "",
      derivedFrom: obj.derivedFrom as SpecSource,
    }
    test.id = generatedTestId(test)
    out.push(test)
  }
  return out
}

/**
 * Run the spec-test proposal lane. Returns proposed dbt generic tests grounded in
 * provided `specSources`, or [] if the model/LLM is unavailable or any failure
 * occurs. Reviews must never crash because this advisory LLM lane is absent.
 */
export async function runSpecTestGen(input: SpecTestGenInput): Promise<GeneratedTest[]> {
  if (!input.specSources.length) return []

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SPEC_TEST_GEN_TIMEOUT_MS)
  try {
    const defaultModel = await Provider.defaultModel()
    const model = await Provider.getModel(defaultModel.providerID, defaultModel.modelID)
    const system = buildSystemPrompt()
    const agent: Agent.Info = {
      name: "dbt-spec-test-generator",
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
      messages: [{ role: "user", content: buildUserMessage(input) }],
    })
    for await (const _ of stream.fullStream) {
      // drain to avoid SDK hangs
    }
    const text = await Promise.resolve(stream.text).catch((err: unknown) => {
      log.error("spec-test generation stream failed", { error: err })
      return undefined
    })
    if (!text) return []

    const tests = parseGeneratedTests(text)
    const { kept } = filterToSpecDerived(tests, input.specSources)
    return kept
  } catch (err) {
    log.error("spec-test generation failed", { error: err })
    return []
  } finally {
    clearTimeout(timeout)
  }
}
