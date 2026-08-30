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
const FILE_TOKEN_ALLOWANCE = 16_384
const PDF_TOKEN_ALLOWANCE = 32_768
const PDF_TOKENS_PER_PAGE = 5_000
const PDF_SCAN_BYTE_LIMIT = 64 * 1_024
const DATA_URL_HEADER_LIMIT = 1_024
const PDF_PAGE_LIMIT = 600
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
const FILE_PART_TYPES = new Set(["file", "media", "file-data", "file-url", "file-id"])

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

/** Merge outgoing request headers with HTTP's case-insensitive last-source precedence. */
export function mergeRequestHeaders(...sources: readonly unknown[]): Record<string, string> {
  const result: Record<string, string> = {}
  const set = (name: unknown, value: unknown) => {
    if (typeof name !== "string" || typeof value !== "string") return
    result[name.toLowerCase()] = value
  }
  for (const source of sources) {
    if (!source) continue
    if (source instanceof Headers) {
      source.forEach((value, name) => set(name, value))
      continue
    }
    if (Array.isArray(source)) {
      for (const entry of source) {
        if (Array.isArray(entry)) set(entry[0], entry[1])
      }
      continue
    }
    if (!isRecord(source)) continue
    for (const [name, value] of Object.entries(source)) set(name, value)
  }
  return result
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

/** Return the first transport payload carried by a semantic media part. */
function mediaPayload(part: JsonRecord): unknown {
  for (const key of MEDIA_PAYLOAD_KEYS) {
    if (part[key] !== undefined && part[key] !== null) return part[key]
  }
  return undefined
}

/** Resolve a media part's MIME type from its declared type, data URL, or URL suffix. */
function mediaType(part: JsonRecord, payload: unknown): string | undefined {
  const declared =
    typeof part.mediaType === "string" ? part.mediaType : typeof part.mime === "string" ? part.mime : undefined
  if (declared) return declared.split(";", 1)[0].trim().toLowerCase()

  const value = payload instanceof URL ? payload.href : typeof payload === "string" ? payload : undefined
  const prefix = value?.slice(0, DATA_URL_HEADER_LIMIT)
  const dataType = prefix?.match(/^data:([^;,]+)/i)?.[1]
  if (dataType) return dataType.toLowerCase()
  if (value && /\.pdf(?:[?#]|$)/i.test(value.slice(-DATA_URL_HEADER_LIMIT))) return "application/pdf"
  if (String(part.type).startsWith("image")) return "image/*"
  return undefined
}

/** Return an inline payload's decoded byte size without allocating its encoded contents. */
function inlinePayloadSize(payload: unknown): number | undefined {
  if (ArrayBuffer.isView(payload)) return payload.byteLength
  if (payload instanceof ArrayBuffer) return payload.byteLength
  const value = payload instanceof URL ? payload.href : typeof payload === "string" ? payload : undefined
  if (!value || /^https?:/i.test(value)) return undefined

  const dataURL = /^data:/i.test(value)
  const prefix = dataURL ? value.slice(0, DATA_URL_HEADER_LIMIT) : ""
  const comma = dataURL ? prefix.indexOf(",") : -1
  // A delimiter outside the bounded header prefix is malformed for admission purposes. Charge
  // its complete encoded length without scanning or copying the attacker-controlled payload.
  if (dataURL && comma === -1) return value.length
  const bodyOffset = comma === -1 ? 0 : comma + 1
  const bodyLength = value.length - bodyOffset
  if (comma !== -1 && !/;base64(?:;|$)/i.test(prefix.slice(0, comma))) return bodyLength

  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((bodyLength * 3) / 4) - padding)
}

/** Decode at most one bounded prefix for optional PDF page-tree evidence. */
function inlinePdfPrefix(payload: unknown): string | undefined {
  if (ArrayBuffer.isView(payload)) {
    const length = Math.min(payload.byteLength, PDF_SCAN_BYTE_LIMIT)
    return Buffer.from(payload.buffer, payload.byteOffset, length).toString("latin1")
  }
  if (payload instanceof ArrayBuffer) {
    return Buffer.from(payload, 0, Math.min(payload.byteLength, PDF_SCAN_BYTE_LIMIT)).toString("latin1")
  }

  const value = payload instanceof URL ? payload.href : typeof payload === "string" ? payload : undefined
  if (!value || /^https?:/i.test(value)) return undefined
  const dataURL = /^data:/i.test(value)
  const prefix = dataURL ? value.slice(0, DATA_URL_HEADER_LIMIT) : ""
  const comma = dataURL ? prefix.indexOf(",") : -1
  if (dataURL && comma === -1) return undefined
  const bodyOffset = comma === -1 ? 0 : comma + 1
  if (comma !== -1 && !/;base64(?:;|$)/i.test(prefix.slice(0, comma))) {
    return value.slice(bodyOffset, bodyOffset + PDF_SCAN_BYTE_LIMIT)
  }

  try {
    const encodedLimit = Math.ceil(PDF_SCAN_BYTE_LIMIT / 3) * 4
    return Buffer.from(value.slice(bodyOffset, bodyOffset + encodedLimit), "base64")
      .subarray(0, PDF_SCAN_BYTE_LIMIT)
      .toString("latin1")
  } catch {
    return undefined
  }
}

/** Estimate page count only from the bounded PDF prefix. */
function pdfPageCount(source: string | undefined): number {
  if (!source) return 0
  let pages = 0
  const leaf = /\/Type\s*\/Page\b/g
  while (leaf.exec(source) && pages < PDF_PAGE_LIMIT) pages++

  const trees = [/\/Type\s*\/Pages\b[^>]{0,512}?\/Count\s+(\d+)/g, /\/Count\s+(\d+)[^>]{0,512}?\/Type\s*\/Pages\b/g]
  for (const tree of trees) {
    for (let match = tree.exec(source); match; match = tree.exec(source)) {
      pages = Math.max(pages, Number(match[1]))
    }
  }
  return Math.min(pages, PDF_PAGE_LIMIT)
}

/** Combine fixed, monotonic byte-size, and bounded page evidence for inline PDFs. */
function pdfTokenAllowance(payload: unknown): number {
  const bytes = inlinePayloadSize(payload) ?? 0
  const pages = pdfPageCount(inlinePdfPrefix(payload))
  // One decoded byte per token is deliberately conservative for compressed and multilingual files.
  return Math.max(PDF_TOKEN_ALLOWANCE, bytes, pages * PDF_TOKENS_PER_PAGE)
}

/** Assign an allowance that matches the semantic media kind rather than its encoded bytes. */
function mediaTokenAllowance(part: JsonRecord): number {
  const payload = mediaPayload(part)
  const mime = mediaType(part, payload)
  if (mime?.startsWith("image/") || String(part.type).startsWith("image")) return MEDIA_TOKEN_ALLOWANCE
  if (mime === "application/pdf") return pdfTokenAllowance(payload)
  if (FILE_PART_TYPES.has(String(part.type))) {
    return Math.max(FILE_TOKEN_ALLOWANCE, inlinePayloadSize(payload) ?? 0)
  }
  return MEDIA_TOKEN_ALLOWANCE
}

/** Mark only actual ModelMessage content parts whose payload is provider media. */
function messageMediaAllowances(messages: readonly unknown[]): WeakMap<object, number> {
  const result = new WeakMap<object, number>()
  const visited = new WeakSet<object>()

  const visitContent = (content: unknown) => {
    if (!Array.isArray(content) || visited.has(content)) return
    visited.add(content)
    for (const part of content) {
      if (!isRecord(part)) continue
      if (MEDIA_PART_TYPES.has(String(part.type))) result.set(part, mediaTokenAllowance(part))

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
  mediaContainers?: WeakMap<object, number>,
): { readonly text: string; readonly mediaTokens: number } {
  let mediaTokens = 0
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
        mediaTokens += mediaContainers?.get(child) ?? 0
        ancestors.push(child)
      }
      return child
    }) ?? ""
  return { text, mediaTokens }
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
  let finalValues: string[] = []
  for (const source of input.headerSources ?? []) {
    const values = anthropicBetaValues(source)
    if (values.length > 0) finalValues = values
  }
  for (const value of finalValues) {
    for (const beta of value.split(/[\s,]+/)) {
      context = Math.max(context, CONTEXT_WINDOW_BETAS.get(beta) ?? 0)
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

  const messages = serializeForEstimate(input.messages, messageMediaAllowances(input.messages))
  total += estimateTextTokens(messages.text) + messages.mediaTokens

  if (input.tools !== undefined) {
    const tools = serializeForEstimate(input.tools)
    total += estimateTextTokens(tools.text)
  }

  if (input.instructions !== undefined && input.instructions !== system) {
    const serialized = serializeForEstimate(input.instructions)
    total += estimateTextTokens(serialized.text) + serialized.mediaTokens
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
