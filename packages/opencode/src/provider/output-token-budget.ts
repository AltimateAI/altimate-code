// altimate_change start — keep output reservations inside the provider context window
import type { Provider } from "./provider"
import { Log } from "@/util/log"
import { Token } from "@/util/token"

const log = Log.create({ service: "provider.output-token-budget" })

/** Smallest completion budget worth sending for an agent turn. */
export const OUTPUT_TOKEN_FLOOR = 1_024

const CLAMP_MARGIN_FRACTION = 0.02
const CLAMP_MARGIN_MIN = 512
const ESTIMATE_CHUNK_SIZE = 400
const MEDIA_TOKEN_ALLOWANCE = 2_048
const MIN_REASONING_BUDGET = 1_024
const EMOJI = /\p{Extended_Pictographic}/u
const REASONING_BUDGET_KEYS = new Set(["budgetTokens", "thinkingBudget", "budget_tokens"])
const CONTEXT_WINDOW_BETAS = new Map([["context-1m-2025-08-07", 1_000_000]])
const MEDIA_PART_TYPES = new Set([
  "image",
  "file",
  "media",
  "audio",
  "video",
  "file-data",
  "file-url",
  "file-id",
  "image-data",
  "image-url",
  "image-file-id",
])
const MEDIA_PAYLOAD_KEYS = new Set(["data", "image", "file", "audio", "video", "url", "fileId"])

type JsonRecord = Record<string, unknown>

/** Numbers captured when a prompt cannot leave a usable completion budget. */
export type OutputTokenBudgetInfo = {
  readonly modelID: string
  readonly providerID: string
  readonly inputTokens: number
  readonly requested: number
  readonly context: number
  readonly floor: number
}

/** Numbers captured when a prompt exceeds a model's dedicated input ceiling. */
export type InputTokenBudgetInfo = {
  readonly modelID: string
  readonly providerID: string
  readonly inputTokens: number
  readonly inputLimit: number
  readonly margin: number
}

/** Thrown before transport when the prompt leaves no usable completion budget. */
export class OutputTokenBudgetError extends Error {
  constructor(readonly info: OutputTokenBudgetInfo) {
    super(
      [
        "Context budget exceeded before the request was sent.",
        `${info.providerID}/${info.modelID} declares a ${info.context}-token context window,`,
        `the prompt is ~${info.inputTokens} tokens, and ${info.requested} tokens are reserved for`,
        `the completion — ${info.inputTokens + info.requested} in total.`,
        `Even after clamping, fewer than ${info.floor} tokens would remain for the response.`,
        "Reduce the system prompt (fewer instructions, skills, or AGENTS.md content), lower the",
        "output reservation via OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX, or use a model with a",
        "larger context window.",
      ].join(" "),
    )
    this.name = "OutputTokenBudgetError"
  }
}

/** Thrown before transport when the estimated prompt exceeds a dedicated input limit. */
export class InputTokenBudgetError extends Error {
  constructor(readonly info: InputTokenBudgetInfo) {
    super(
      [
        "Input budget exceeded before the request was sent.",
        `${info.providerID}/${info.modelID} declares a ${info.inputLimit}-token input limit,`,
        `the prompt is ~${info.inputTokens} tokens, and ${info.margin} safety tokens are required.`,
        "Reduce the prompt or use a model with a larger input limit.",
      ].join(" "),
    )
    this.name = "InputTokenBudgetError"
  }
}

/** Thrown when preserving enabled reasoning would leave no useful visible response. */
export class ReasoningTokenBudgetError extends Error {
  constructor(
    readonly info: {
      readonly path: string
      readonly configured: number
      readonly maxOutputTokens: number
    },
  ) {
    super(
      [
        "The context-window clamp cannot preserve the configured reasoning budget.",
        `${info.path} is ${info.configured} tokens while maxOutputTokens is ${info.maxOutputTokens},`,
        `which cannot leave ${OUTPUT_TOKEN_FLOOR} tokens for the visible response.`,
        "Use a larger-context model, shorten the prompt, or select a lower reasoning effort.",
      ].join(" "),
    )
    this.name = "ReasoningTokenBudgetError"
  }
}

/** Return true for plain record-like values used in request payloads. */
function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Estimate heterogeneous text in small chunks and conservatively count non-ASCII scripts. */
function estimateTextTokens(input: string): number {
  let total = 0
  for (let offset = 0; offset < input.length; offset += ESTIMATE_CHUNK_SIZE) {
    const chunk = input.slice(offset, offset + ESTIMATE_CHUNK_SIZE)
    let ascii = ""
    let nonAscii = 0
    let emoji = 0
    for (const character of chunk) {
      if (character.codePointAt(0)! <= 0x7f) {
        ascii += character
      } else {
        nonAscii++
        if (EMOJI.test(character)) emoji++
      }
    }
    const multilingualFloor = Token.estimate(ascii) + nonAscii + emoji
    total += Math.max(Token.estimate(chunk), multilingualFloor)
  }
  return total
}

/** Mark only actual ModelMessage content parts whose payload is provider media. */
function messageMediaContainers(messages: readonly unknown[]): WeakSet<object> {
  const result = new WeakSet<object>()
  const visited = new WeakSet<object>()

  const visitContent = (content: unknown) => {
    if (!Array.isArray(content) || visited.has(content)) return
    visited.add(content)
    for (const part of content) {
      if (!isRecord(part)) continue
      if (MEDIA_PART_TYPES.has(String(part.type))) result.add(part)

      // Tool-result media is nested in the AI SDK's typed content output.
      if (part.type !== "tool-result" || !isRecord(part.output)) continue
      if (part.output.type === "content") visitContent(part.output.value)
    }
  }

  for (const message of messages) {
    if (isRecord(message)) visitContent(message.content)
  }
  return result
}

/** Serialize request structures without expanding semantic media payloads into fake text tokens. */
function serializeForEstimate(
  value: unknown,
  mediaContainers?: WeakSet<object>,
): { readonly text: string; readonly mediaParts: number } {
  let mediaParts = 0
  const ancestors: object[] = []
  const text =
    JSON.stringify(value, function (key, child) {
      while (ancestors.length > 0 && ancestors.at(-1) !== this) ancestors.pop()

      const mediaField =
        typeof this === "object" && this !== null && mediaContainers?.has(this) && MEDIA_PAYLOAD_KEYS.has(key)
      if (mediaField && child !== undefined && child !== null) {
        return "[media omitted]"
      }
      if (typeof child === "object" && child !== null) {
        if (ancestors.includes(child)) return "[circular value omitted]"
        // Count transport occurrences, not object identities: JSON duplicates shared aliases.
        if (mediaContainers?.has(child)) mediaParts++
        ancestors.push(child)
      }
      return child
    }) ?? ""
  return { text, mediaParts }
}

/** Collect Anthropic beta values only from header-shaped records. */
function anthropicBetaValues(source: unknown, depth = 0): string[] {
  if (!isRecord(source) || depth > 4) return []
  const result: string[] = []
  for (const [key, value] of Object.entries(source)) {
    const normalized = key.toLowerCase()
    if (normalized === "anthropic-beta") {
      if (typeof value === "string") result.push(value)
      if (Array.isArray(value)) result.push(...value.filter((item): item is string => typeof item === "string"))
      continue
    }
    if (normalized === "headers" || normalized.endsWith("headers")) {
      result.push(...anthropicBetaValues(value, depth + 1))
    }
  }
  return result
}

/** Resolve catalog context limits with known provider beta headers applied. */
export function effectiveContextWindow(input: {
  readonly model: Provider.Model
  readonly headerSources?: readonly unknown[]
}): number {
  let context = input.model.limit.context
  for (const source of input.headerSources ?? []) {
    for (const value of anthropicBetaValues(source)) {
      for (const beta of value.split(/[\s,]+/)) {
        context = Math.max(context, CONTEXT_WINDOW_BETAS.get(beta) ?? 0)
      }
    }
  }
  return context
}

/** Estimate the text, finalized tools, instructions, and media allowance sent in one request. */
export function estimateInputTokens(input: {
  readonly system: readonly string[]
  readonly messages: readonly unknown[]
  readonly tools?: Readonly<Record<string, unknown>>
  readonly instructions?: unknown
}): number {
  const system = input.system.join("\n")
  let total = estimateTextTokens(system)

  const messages = serializeForEstimate(input.messages, messageMediaContainers(input.messages))
  total += estimateTextTokens(messages.text) + messages.mediaParts * MEDIA_TOKEN_ALLOWANCE

  if (input.tools !== undefined) {
    const tools = serializeForEstimate(input.tools)
    total += estimateTextTokens(tools.text)
  }

  if (input.instructions !== undefined && input.instructions !== system) {
    const serialized = serializeForEstimate(input.instructions)
    total += estimateTextTokens(serialized.text) + serialized.mediaParts * MEDIA_TOKEN_ALLOWANCE
  }
  return total
}

/** Resolve a direct or lazy input estimate after cheap no-op checks have passed. */
function resolveInputTokens(value: number | (() => number)): number {
  return typeof value === "function" ? value() : value
}

/** Clamp a completion reservation so estimated input, margin, and output fit the effective window. */
export function clampOutputTokens(input: {
  readonly model: Provider.Model
  readonly requested: number | undefined
  readonly inputTokens: number | (() => number)
  readonly context?: number
}): number | undefined {
  const requested = input.requested
  if (requested === undefined) return undefined

  const context = input.context ?? input.model.limit.context
  const inputLimit = input.model.limit.input
  if ((!context || context <= OUTPUT_TOKEN_FLOOR) && (!inputLimit || inputLimit <= 0)) return requested

  const inputTokens = resolveInputTokens(input.inputTokens)
  if (!Number.isFinite(inputTokens) || inputTokens <= 0) return requested

  const margin = Math.max(CLAMP_MARGIN_MIN, Math.ceil(inputTokens * CLAMP_MARGIN_FRACTION))
  if (inputLimit && inputLimit > 0 && inputTokens + margin > inputLimit) {
    throw new InputTokenBudgetError({
      modelID: input.model.id,
      providerID: input.model.providerID,
      inputTokens,
      inputLimit,
      margin,
    })
  }
  if (!context || context <= OUTPUT_TOKEN_FLOOR) return requested
  if (inputTokens + requested + margin <= context) return requested

  // Do not reject a model for failing to reach a floor above its own reservation.
  const floor = Math.min(OUTPUT_TOKEN_FLOOR, requested)
  const clamped = Math.floor(context - inputTokens - margin)
  if (clamped < floor) {
    // If only the estimator margin causes the failure, preserve a reservation that still fits
    // the declared window. The provider remains authoritative for its exact tokenizer.
    const withoutMargin = Math.floor(context - inputTokens)
    if (withoutMargin >= floor) return Math.min(requested, withoutMargin)
    throw new OutputTokenBudgetError({
      modelID: input.model.id,
      providerID: input.model.providerID,
      inputTokens,
      requested,
      context,
      floor,
    })
  }
  log.warn("clamped output token reservation to fit context window", {
    providerID: input.model.providerID,
    modelID: input.model.id,
    context,
    inputTokens,
    requested,
    clamped,
  })
  return clamped
}

/** Recursively copy and clamp explicit reasoning-token fields in provider options. */
function transformReasoningBudgets(
  value: JsonRecord,
  ceiling: number,
  maxOutputTokens: number,
  path?: readonly string[],
): JsonRecord
function transformReasoningBudgets(
  value: unknown,
  ceiling: number,
  maxOutputTokens: number,
  path?: readonly string[],
): unknown
function transformReasoningBudgets(
  value: unknown,
  ceiling: number,
  maxOutputTokens: number,
  path: readonly string[] = [],
): unknown {
  if (Array.isArray(value)) {
    let changed = false
    const result = value.map((item, index) => {
      const next = transformReasoningBudgets(item, ceiling, maxOutputTokens, [...path, String(index)])
      changed ||= next !== item
      return next
    })
    return changed ? result : value
  }
  if (!isRecord(value)) return value

  let result = value
  for (const [key, child] of Object.entries(value)) {
    let next = child
    if (REASONING_BUDGET_KEYS.has(key) && typeof child === "number" && child > 0 && child > ceiling) {
      if (ceiling < MIN_REASONING_BUDGET) {
        throw new ReasoningTokenBudgetError({
          path: [...path, key].join("."),
          configured: child,
          maxOutputTokens,
        })
      }
      next = ceiling
      log.warn("clamped reasoning token budget with output reservation", {
        path: [...path, key].join("."),
        configured: child,
        clamped: ceiling,
        maxOutputTokens,
      })
    } else {
      next = transformReasoningBudgets(child, ceiling, maxOutputTokens, [...path, key])
    }
    if (next !== child) {
      if (result === value) result = { ...value }
      result[key] = next
    }
  }
  return result
}

/** Clamp explicit thinking budgets while preserving room for a visible response. */
export function clampReasoningBudget(
  options: Record<string, any>,
  maxOutputTokens: number | undefined,
): Record<string, any> {
  if (maxOutputTokens === undefined) return options
  const ceiling = Math.floor(maxOutputTokens - OUTPUT_TOKEN_FLOOR)
  return transformReasoningBudgets(options, ceiling, maxOutputTokens)
}

export * as OutputTokenBudget from "./output-token-budget"
// altimate_change end
