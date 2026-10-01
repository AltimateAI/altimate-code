// altimate_change - new file
//
// The reflector: one in-process, tool-less LLM call that turns a session digest
// plus external feedback into proposed playbook deltas. It mirrors
// `Agent.generate` (resolve a model through the Provider service, call
// `generateObject` with an Effect Schema) but with temperature 0, and it never
// writes anything: the curator decides what lands.
import { Effect, Schema } from "effect"
import { generateObject } from "ai"
import { Provider } from "@/provider/provider"
import { ProviderID, ModelID } from "@/provider/schema"
import type { Bullet } from "./playbook"
import type { Delta, Op } from "./curator"
import { redactSecrets } from "./digest"
import PROMPT from "./prompt.txt"

export const FEEDBACK_KINDS = ["verifier", "ci", "review", "user"] as const
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number]

export const FEEDBACK_CAP = 12_000
export const DEFAULT_TIMEOUT_MS = 120_000
const OPS: readonly Op[] = ["ADD", "EDIT", "REMOVE", "HELPFUL", "HARMFUL"]

export const DeltaSchema = Schema.Struct({
  op: Schema.Literals(OPS),
  id: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  reason: Schema.String,
})
export const ReflectionSchema = Schema.Struct({ deltas: Schema.Array(DeltaSchema) })

export interface ReflectInput {
  digest: string
  feedback: string
  kind: FeedbackKind
  bullets: Bullet[]
}

/** The model call, injectable so tests need no provider. Returns the raw object. */
export type Generate = (input: { system: string; prompt: string }) => Promise<unknown>

export function buildPrompt(input: ReflectInput): { system: string; prompt: string } {
  const playbook = input.bullets.length
    ? input.bullets.map((b) => `[${b.id}] (h:${b.helpful} x:${b.harmful}) ${b.text}`).join("\n")
    : "(empty)"
  // Clip first: redaction cost must be bounded by the cap, not by whatever was piped in.
  const raw = input.feedback.trim()
  const over = raw.length > FEEDBACK_CAP
  const clipped = redactSecrets(over ? raw.slice(0, FEEDBACK_CAP) : raw) + (over ? "\n… [truncated]" : "")
  const prompt = [
    "<playbook>",
    playbook,
    "</playbook>",
    "",
    "<digest untrusted=\"true\">",
    input.digest,
    "</digest>",
    "",
    `<feedback kind="${input.kind}" untrusted="true">`,
    clipped || "(empty)",
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
    const { op, id, text, reason } = d as Record<string, unknown>
    if (typeof op !== "string" || !OPS.includes(op as Op)) return []
    return [
      {
        op: op as Op,
        id: typeof id === "string" ? id : undefined,
        text: typeof text === "string" ? text : undefined,
        reason: typeof reason === "string" ? reason : "",
      },
    ]
  })
}

export async function reflect(input: ReflectInput, generate: Generate): Promise<Delta[]> {
  return normalizeDeltas(await generate(buildPrompt(input)))
}

/** The real model call: temperature 0, tool-less, and abandoned after `timeoutMs`. `call` is injectable for tests. */
export function makeGenerate(
  language: Parameters<typeof generateObject>[0]["model"],
  schema: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  call: (opts: any) => Promise<{ object: unknown }> = generateObject as never,
): Generate {
  return ({ system, prompt }) =>
    call({
      model: language,
      temperature: 0,
      schema,
      abortSignal: AbortSignal.timeout(timeoutMs),
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    }).then((r) => r.object)
}

/** Resolves `model` (or the default) through the Provider service. */
export const providerGenerate = Effect.fn("Learn.providerGenerate")(function* (
  model?: { providerID: string; modelID: string },
  timeoutMs = DEFAULT_TIMEOUT_MS,
) {
  const provider = yield* Provider.Service
  const chosen = model ?? (yield* provider.defaultModel())
  const resolved = yield* provider.getModel(ProviderID.make(chosen.providerID), ModelID.make(chosen.modelID))
  const language = yield* provider.getLanguage(resolved)
  const schema = Object.assign(Schema.toStandardSchemaV1(ReflectionSchema), Schema.toStandardJSONSchemaV1(ReflectionSchema))
  return makeGenerate(language, schema, timeoutMs)
})
