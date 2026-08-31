import { Token } from "@/util/token"
import { TruncateCore } from "@/tool/truncate-core"

// Per-tool-result dispatch cap: a single tool result must never exceed a
// bounded token estimate when it enters the conversation. The per-tool
// truncation service (tool.ts:wrap → truncate.ts) already middle-truncates
// most outputs, but observed production bypasses let one giant duckdb/query
// dump jump a ~4K-token conversation past a 65K window in a single step. This
// module is the session-side hard cap enforced in processor.ts on every
// completed tool result, sized relative to the EFFECTIVE context limit (the
// declared limit scaled by the estimator safety fraction).
// Fraction of the effective context limit one tool result may occupy.
export const DEFAULT_LIMIT_FRACTION = 0.15

// Densest chars-per-token ratio Token.estimate can return (RATIOS.code = 3.0):
// a string held to capTokens * 3 bytes can never estimate above capTokens.
export const MIN_CHARS_PER_TOKEN = 3.0

// Long single-line dumps (minified JSON, one-row query results) are re-chunked
// at this many chars so the middle-truncation byte walk can keep a head and
// tail instead of dropping the entire line.
const LINE_CHUNK_CHARS = 2_000

// altimate_change start — one source of truth for the estimator safety
// fraction default. It was written as a bare 0.65 in two places here, so a
// change to the shared default silently skipped this module.
/** Mirrors SessionCompaction's DEFAULT_CONTEXT_SAFETY_FRACTION. */
export const DEFAULT_SAFETY_FRACTION = 0.65
// altimate_change end

// Conservative bound when the model's limits are unknown: size the cap as if
// the model had the smallest window this cap protects (64K, scaled by the
// default safety fraction) rather than trusting the byte-derived cap
// (~17K tokens), which can overwhelm a small window on its own.
/** The smallest window this cap protects; the unknown-model fallback is sized against it. */
export const UNKNOWN_MODEL_CONTEXT = 65_536

export const UNKNOWN_MODEL_CAP_TOKENS = Math.floor(
  Math.floor(UNKNOWN_MODEL_CONTEXT * DEFAULT_SAFETY_FRACTION) * DEFAULT_LIMIT_FRACTION,
)

// altimate_change start — cap partial output preserved on interrupted tools
/**
 * Resolve the per-result token cap: an explicit `tool_output.dispatch_max_tokens`
 * config wins; otherwise min(existing byte-cap expressed in tokens, 15% of the
 * effective context limit). Unknown or degenerate model limits fall back to a
 * conservative small-window bound, never the raw byte-derived cap alone.
 */
export function resolve(input: {
  config?: {
    tool_output?: { max_bytes?: number; dispatch_max_tokens?: number }
    compaction?: { context_safety_fraction?: number }
  }
  model?: { limit?: { context?: number; input?: number } }
  /** Estimator safety fraction; callers pass SessionCompaction.contextSafetyFraction(config). */
  safetyFraction?: number
}): number {
  const configured = input.config?.tool_output?.dispatch_max_tokens
  if (configured && configured > 0) return configured

  const maxBytes = input.config?.tool_output?.max_bytes ?? TruncateCore.MAX_BYTES
  const existingCapTokens = Math.ceil(maxBytes / MIN_CHARS_PER_TOKEN)

  // Default to the estimator safety fraction, not 1: an omitted fraction must
  // fail conservative (tool outputs are estimate-domain), never fail open.
  // altimate_change start — `config.compaction.context_safety_fraction` was
  // declared on this input and never read, so a caller that passed only the
  // config (every caller except processor.ts) silently got the default
  // instead of the configured fraction. Honour it as the second choice.
  // Resolved BEFORE the unknown-model branch so the conservative fallback is
  // scaled by the configured fraction too, not only the known-limit path.
  const configuredFraction = input.config?.compaction?.context_safety_fraction
  const requestedFraction = input.safetyFraction ?? configuredFraction ?? DEFAULT_SAFETY_FRACTION
  // Config parsing deliberately accepts out-of-range numeric values so one
  // typo cannot discard the whole config document. Keep this config-only
  // resolution path consistent with SessionCompaction.contextSafetyFraction:
  // non-finite values fall back, finite values clamp to the safe [0.1, 1]
  // runtime range.
  const fraction = Number.isFinite(requestedFraction)
    ? Math.min(1, Math.max(0.1, requestedFraction))
    : DEFAULT_SAFETY_FRACTION
  // Same shape as UNKNOWN_MODEL_CAP_TOKENS, but at the resolved fraction; with
  // the default fraction the two are identical.
  const unknownCapTokens = Math.floor(Math.floor(UNKNOWN_MODEL_CONTEXT * fraction) * DEFAULT_LIMIT_FRACTION)
  // altimate_change end

  const base = input.model?.limit?.input ?? input.model?.limit?.context ?? 0
  if (base <= 0) return Math.min(existingCapTokens, unknownCapTokens)

  const effectiveLimit = Math.floor(base * fraction)
  const limitCapTokens = Math.floor(effectiveLimit * DEFAULT_LIMIT_FRACTION)
  if (limitCapTokens <= 0) return Math.min(existingCapTokens, unknownCapTokens)
  return Math.min(existingCapTokens, limitCapTokens)
}

/**
 * Enforce the cap on one tool-result output. Outputs whose token estimate fits
 * return unchanged; oversized outputs are middle-truncated (same machinery and
 * marker as the tool-level truncation service) with a notice telling the model
 * the output was truncated.
 */
export function apply(
  output: string,
  capTokens: number,
  // altimate_change start — the hint must match the OUTCOME. The cap is now
  // applied to failed tool results too, and the success wording would have
  // told the model a real failure was a truncated success.
  opts?: { outcome?: "success" | "error" },
  // altimate_change end
): { content: string; truncated: boolean } {
  if (capTokens <= 0) return { content: output, truncated: false }
  if (Token.estimate(output) <= capTokens) return { content: output, truncated: false }

  const lines: string[] = []
  for (const line of output.split("\n")) {
    if (line.length <= LINE_CHUNK_CHARS) {
      lines.push(line)
      continue
    }
    // Chunk on code-point boundaries. `slice` counts UTF-16 code units, so a
    // fixed stride can land between the high and low halves of an astral
    // character (emoji, CJK ext, ...). The truncation machinery may then keep
    // one half, and the replayed diagnostic carries a lone surrogate instead
    // of the original text.
    for (let i = 0; i < line.length; ) {
      let end = Math.min(i + LINE_CHUNK_CHARS, line.length)
      if (end < line.length) {
        const code = line.charCodeAt(end - 1)
        // High surrogate at the boundary: its pair starts here, so end the
        // chunk before it and let the next chunk carry the whole character.
        if (code >= 0xd800 && code <= 0xdbff) end -= 1
      }
      // Defensive: never fail to advance, whatever LINE_CHUNK_CHARS becomes.
      if (end <= i) end = Math.min(i + 2, line.length)
      lines.push(line.slice(i, end))
      i = end
    }
  }
  const totalBytes = Buffer.byteLength(output, "utf-8")
  // altimate_change start — outcome-accurate hint (see `opts.outcome`).
  const hint =
    opts?.outcome === "error"
      ? "The tool call FAILED and its error output exceeded the per-result context budget, so the error text below was truncated before dispatch. The failure is real — do not treat this as a successful result. Re-run with a narrower scope if you need the full error."
      : "The tool call succeeded but the output exceeded the per-result context budget and was truncated before dispatch. Re-run the tool with a narrower query (filters, LIMIT, offset/limit) to view specific sections."
  // altimate_change end
  const frame = (bodyBytes: number) => {
    const preview = TruncateCore.preview(lines, totalBytes, {
      maxLines: Number.MAX_SAFE_INTEGER,
      maxBytes: bodyBytes,
      direction: "middle",
      headRatio: TruncateCore.DEFAULT_HEAD_RATIO,
    })
    return TruncateCore.assemble(preview, hint, "middle")
  }

  // The marker/hint framing counts against the cap: build, re-measure, and
  // shrink the body budget until the ASSEMBLED result fits. Spending the full
  // cap on the preview and then appending framing produced results above cap.
  let bodyBytes = Math.max(1, Math.floor(capTokens * MIN_CHARS_PER_TOKEN))
  let content = frame(bodyBytes)
  for (let i = 0; i < 6; i++) {
    const over = Token.estimate(content) - capTokens
    if (over <= 0) return { content, truncated: true }
    // Remove at least the overage at the loosest chars-per-token ratio (4.0)
    // so each pass makes definite progress.
    bodyBytes -= Math.ceil(over * 4)
    if (bodyBytes <= 0) break
    content = frame(bodyBytes)
  }
  if (Token.estimate(content) <= capTokens) return { content, truncated: true }
  // Degenerate caps (smaller than the framing itself): drop the framing and
  // hard-slice — a ≤ capTokens * 3-char head can never estimate above the cap.
  return { content: output.slice(0, Math.max(1, Math.floor(capTokens * MIN_CHARS_PER_TOKEN))), truncated: true }
}

/**
 * Preserve an interrupted tool's diagnostic metadata without letting partial
 * stdout/stderr bypass the same dispatch cap enforced for settled results.
 */
export function capInterruptedMetadata(
  metadata: Record<string, unknown> | undefined,
  capTokens: number,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...metadata, interrupted: true }
  if (typeof next.output === "string") {
    next.output = apply(next.output, capTokens, { outcome: "error" }).content
  }
  return next
}
// altimate_change end

export * as ToolResultCap from "./tool-result-cap"
