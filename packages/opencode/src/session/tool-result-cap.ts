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
export namespace ToolResultCap {
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
  export const UNKNOWN_MODEL_CAP_TOKENS = Math.floor(
    Math.floor(65_536 * DEFAULT_SAFETY_FRACTION) * DEFAULT_LIMIT_FRACTION,
  )

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

    const base = input.model?.limit?.input ?? input.model?.limit?.context ?? 0
    if (base <= 0) return Math.min(existingCapTokens, UNKNOWN_MODEL_CAP_TOKENS)

    // Default to the estimator safety fraction, not 1: an omitted fraction must
    // fail conservative (tool outputs are estimate-domain), never fail open.
    // altimate_change start — `config.compaction.context_safety_fraction` was
    // declared on this input and never read, so a caller that passed only the
    // config (every caller except processor.ts) silently got the default
    // instead of the configured fraction. Honour it as the second choice.
    const configuredFraction = input.config?.compaction?.context_safety_fraction
    const fraction =
      input.safetyFraction ??
      (typeof configuredFraction === "number" && Number.isFinite(configuredFraction) && configuredFraction > 0
        ? configuredFraction
        : DEFAULT_SAFETY_FRACTION)
    // altimate_change end
    const effectiveLimit = Math.floor(base * fraction)
    const limitCapTokens = Math.floor(effectiveLimit * DEFAULT_LIMIT_FRACTION)
    if (limitCapTokens <= 0) return Math.min(existingCapTokens, UNKNOWN_MODEL_CAP_TOKENS)
    return Math.min(existingCapTokens, limitCapTokens)
  }

  /**
   * Enforce the cap on one tool-result output. Outputs whose token estimate fits
   * return unchanged; oversized outputs are middle-truncated (same machinery and
   * marker as the tool-level truncation service) with a notice telling the model
   * the output was truncated.
   */
  export function apply(output: string, capTokens: number): { content: string; truncated: boolean } {
    if (capTokens <= 0) return { content: output, truncated: false }
    if (Token.estimate(output) <= capTokens) return { content: output, truncated: false }

    const lines: string[] = []
    for (const line of output.split("\n")) {
      if (line.length <= LINE_CHUNK_CHARS) {
        lines.push(line)
        continue
      }
      for (let i = 0; i < line.length; i += LINE_CHUNK_CHARS) lines.push(line.slice(i, i + LINE_CHUNK_CHARS))
    }
    const totalBytes = Buffer.byteLength(output, "utf-8")
    const hint =
      "The tool call succeeded but the output exceeded the per-result context budget and was truncated before dispatch. Re-run the tool with a narrower query (filters, LIMIT, offset/limit) to view specific sections."
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
}
