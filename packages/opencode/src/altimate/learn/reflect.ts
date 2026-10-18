// altimate_change - new file
//
// The reflector: one in-process, tool-less LLM call that turns a session digest
// plus external feedback into proposed playbook deltas. It mirrors
// `Agent.generate` (resolve a model through the Provider service, call
// `generateObject` with an Effect Schema) but with temperature 0, and it never
// writes anything: the curator decides what lands.
import { Effect, Schema } from "effect"
import { generateObject, NoObjectGeneratedError, type ProviderMetadata } from "ai"
import { Provider } from "@/provider/provider"
import { ProviderID, ModelID } from "@/provider/schema"
import type { Bullet } from "./playbook"
import type { Delta, Op } from "./curator"
import { redactSecrets } from "./digest"
import { accountUsage, type UsageModel } from "./usage"
import PROMPT from "./prompt.txt"
import REPLACE_PROMPT from "./replace-prompt.txt"

export const FEEDBACK_KINDS = ["verifier", "ci", "review", "user"] as const
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number]

export const FEEDBACK_CAP = 12_000
export const DEFAULT_TIMEOUT_MS = 120_000
const OPS: readonly Op[] = ["ADD", "EDIT", "REMOVE", "HELPFUL", "HARMFUL"]

export const DeltaSchema = Schema.Struct({
  op: Schema.Literals(OPS),
  id: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  supersedes: Schema.optional(Schema.String),
  coexists: Schema.optional(Schema.Array(Schema.String)),
  reason: Schema.String,
})
export const ReflectionSchema = Schema.Struct({ deltas: Schema.Array(DeltaSchema) })
const ReplacementSchema = Schema.Struct({
  text: Schema.NullOr(Schema.String),
  coexists: Schema.optional(Schema.Array(Schema.String)),
})

export interface ReflectInput {
  digest: string
  feedback: string
  kind: FeedbackKind
  bullets: Bullet[]
}

/** The model call, injectable so tests need no provider. Returns the raw object. */
export type Generate = (
  input: { system: string; prompt: string; schema?: unknown },
  onUsage?: (usage: GenerateUsage) => void,
) => Promise<unknown>

export interface GenerateUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  reasoningTokens?: number
  cachedInputTokens?: number
  inputTokenDetails?: { noCacheTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  outputTokenDetails?: { reasoningTokens?: number }
  providerMetadata?: ProviderMetadata
  estimatedCost?: number
  /** Original SDK counts, retained when callbacks expose the session's normalized totals. */
  rawUsage?: { inputTokens?: number; outputTokens?: number }
}

export function feedbackText(feedback: string): string {
  // Preserve complete credential syntax until it has been redacted, including across the cap.
  const raw = redactSecrets(feedback.trim())
  const over = raw.length > FEEDBACK_CAP
  // Keep the generated marker NFKC-stable when the excerpt is redacted again for a replacement.
  return (over ? raw.slice(0, FEEDBACK_CAP) : raw) + (over ? "\n... [truncated]" : "")
}

/** Escape after redaction so untrusted text cannot introduce or close prompt sections. */
function escapePromptSection(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

export function buildPrompt(input: ReflectInput): { system: string; prompt: string } {
  const playbook = input.bullets.length
    ? input.bullets.map((b) => `[${b.id}] (h:${b.helpful} x:${b.harmful}${b.coexists?.length ? ` c:${b.coexists.join(",")}` : ""}) ${redactSecrets(b.text)}`).join("\n")
    : "(empty)"
  const prompt = [
    "<playbook>",
    escapePromptSection(redactSecrets(playbook)),
    "</playbook>",
    "",
    "<digest untrusted=\"true\">",
    escapePromptSection(redactSecrets(input.digest)),
    "</digest>",
    "",
    `<feedback kind="${input.kind}" untrusted="true">`,
    escapePromptSection(feedbackText(input.feedback)) || "(empty)",
    "</feedback>",
    "",
    'Respond with the JSON object {"deltas": [...]} only.',
  ].join("\n")
  return { system: PROMPT, prompt }
}

/** Drops malformed entries rather than failing the whole reflection. */
export function normalizeDeltas(raw: unknown): Delta[] {
  const list = (raw as { deltas?: unknown } | null)?.deltas
  if (!Array.isArray(list)) throw new Error("Reflector returned no `deltas` array.")
  return list.flatMap((d): Delta[] => {
    if (!d || typeof d !== "object") return []
    const { op, id, text, supersedes, coexists, reason } = d as Record<string, unknown>
    if (typeof op !== "string" || !OPS.includes(op as Op)) return []
    if (supersedes !== undefined && (op !== "ADD" || typeof supersedes !== "string")) return []
    if (coexists !== undefined && ((op !== "ADD" && op !== "EDIT") || !Array.isArray(coexists) || coexists.some((id) => typeof id !== "string"))) return []
    return [
      {
        op: op as Op,
        id: typeof id === "string" ? id : undefined,
        text: typeof text === "string" ? text : undefined,
        ...(supersedes !== undefined ? { supersedes: supersedes as string } : {}),
        ...(coexists !== undefined ? { coexists: coexists as string[] } : {}),
        reason: typeof reason === "string" ? reason : "",
      },
    ]
  })
}

export async function reflect(input: ReflectInput, generate: Generate): Promise<Delta[]> {
  return normalizeDeltas(await generate(buildPrompt(input)))
}

/** One narrow follow-up for a contradicted convention the reflector removed without replacing. */
export async function replace(
  input: { text: string; reasons: string[]; feedback: string; feedbackExcerpt?: string; kind: FeedbackKind; bullets: Pick<Bullet, "id" | "text">[] },
  generate: Generate,
): Promise<{ text: string; coexists?: string[] } | null> {
  const prompt = [
    '<removed-bullet untrusted="true">',
    escapePromptSection(redactSecrets(input.text)),
    "</removed-bullet>",
    '<surviving-overlaps untrusted="true">',
    escapePromptSection(input.bullets.map((b) => `[${b.id}] ${redactSecrets(b.text)}`).join("\n")) || "(empty)",
    "</surviving-overlaps>",
    '<reasons untrusted="true">',
    escapePromptSection(feedbackText(input.reasons.join("\n"))),
    "</reasons>",
    `<feedback kind="${input.kind}" untrusted="true">`,
    escapePromptSection(redactSecrets(input.feedbackExcerpt ?? feedbackText(input.feedback))) || "(empty)",
    "</feedback>",
  ].join("\n")
  const raw = await generate({
    system: REPLACE_PROMPT,
    prompt,
    schema: Object.assign(Schema.toStandardSchemaV1(ReplacementSchema), Schema.toStandardJSONSchemaV1(ReplacementSchema)),
  })
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("text" in raw) || (raw.text !== null && typeof raw.text !== "string"))
    throw new Error("Replacement returned no valid `text` string or null.")
  const coexists = (raw as { coexists?: unknown }).coexists
  if (coexists !== undefined && (!Array.isArray(coexists) || coexists.some((id) => typeof id !== "string" || !input.bullets.some((b) => b.id === id))))
    throw new Error("Replacement returned no valid `coexists` ids from surviving overlaps.")
  return raw.text === null ? null : { text: raw.text, ...(coexists !== undefined ? { coexists: coexists as string[] } : {}) }
}

/** The real model call: temperature 0, tool-less, and abandoned after `timeoutMs`. `call` is injectable for tests. */
export function makeGenerate(
  language: Parameters<typeof generateObject>[0]["model"],
  schema: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  call: (opts: any) => Promise<{ object: unknown; usage?: GenerateUsage; providerMetadata?: ProviderMetadata }> = generateObject as never,
  abortSignal?: AbortSignal,
  onUsage?: (usage: GenerateUsage) => void,
  model?: UsageModel,
): Generate {
  const report = async (raw: GenerateUsage | undefined, metadata: ProviderMetadata | undefined, reportUsage?: (usage: GenerateUsage) => void) => {
    if (!raw) return
    const accounted = model ? await accountUsage(model, raw, metadata) : undefined
    const usage = accounted ? {
      ...raw,
      rawUsage: raw.rawUsage ?? { inputTokens: raw.inputTokens, outputTokens: raw.outputTokens },
      ...(metadata ? { providerMetadata: metadata } : {}),
      ...(raw.inputTokens !== undefined ? { inputTokens: accounted.inputTokens } : {}),
      ...(raw.outputTokens !== undefined ? { outputTokens: accounted.outputTokens } : {}),
      estimatedCost: accounted.estimatedCost,
    } : raw
    onUsage?.(usage)
    reportUsage?.(usage)
  }
  return ({ system, prompt, schema: outputSchema = schema }, reportUsage) =>
    call({
      model: language,
      temperature: 0,
      schema: outputSchema,
      abortSignal: abortSignal ? AbortSignal.any([abortSignal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    }).then(
      async (r) => {
        await report(r.usage, r.providerMetadata, reportUsage)
        return r.object
      },
      async (error) => {
        // Invalid structured output still consumed tokens, including on replacement calls.
        if (NoObjectGeneratedError.isInstance(error)) await report(error.usage, undefined, reportUsage)
        throw error
      },
    )
}

/** Resolves `model` (or the default) through the Provider service. */
export const providerGenerate = Effect.fn("Learn.providerGenerate")(function* (
  model?: { providerID: string; modelID: string },
  timeoutMs = DEFAULT_TIMEOUT_MS,
  abortSignal?: AbortSignal,
  onUsage?: (usage: GenerateUsage) => void,
) {
  const provider = yield* Provider.Service
  const chosen = model ?? (yield* provider.defaultModel())
  const resolved = yield* provider.getModel(ProviderID.make(chosen.providerID), ModelID.make(chosen.modelID))
  const language = yield* provider.getLanguage(resolved)
  const schema = Object.assign(Schema.toStandardSchemaV1(ReflectionSchema), Schema.toStandardJSONSchemaV1(ReflectionSchema))
  return makeGenerate(language, schema, timeoutMs, undefined, abortSignal, onUsage, resolved)
})
