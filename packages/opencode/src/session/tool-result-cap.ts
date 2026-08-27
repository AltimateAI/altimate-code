import { Token } from "@/util/token"
import { TruncateCore } from "@/tool/truncate-core"

// W3.2 per-tool-result dispatch cap: a single tool result must never exceed a
// bounded token estimate when it enters the conversation. The per-tool
// truncation service (tool.ts:wrap → truncate.ts) already middle-truncates
// most outputs, but observed production bypasses let one giant duckdb/query
// dump jump a ~4K-token conversation past a 65K window in a single step. This
// module is the session-side hard cap enforced in processor.ts on every
// completed tool result, sized relative to the EFFECTIVE context limit (the
// declared limit scaled by the W3.1 estimator safety fraction).
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

  /**
   * Resolve the per-result token cap: an explicit `tool_output.dispatch_max_tokens`
   * config wins; otherwise min(existing byte-cap expressed in tokens, 15% of the
   * effective context limit). Returns 0 (uncapped) only when nothing is known.
   */
  export function resolve(input: {
    config?: {
      tool_output?: { max_bytes?: number; dispatch_max_tokens?: number }
      compaction?: { context_safety_fraction?: number }
    }
    model?: { limit?: { context?: number; input?: number } }
    /** W3.1 safety fraction; callers pass SessionCompaction.contextSafetyFraction(config). */
    safetyFraction?: number
  }): number {
    const configured = input.config?.tool_output?.dispatch_max_tokens
    if (configured && configured > 0) return configured

    const maxBytes = input.config?.tool_output?.max_bytes ?? TruncateCore.MAX_BYTES
    const existingCapTokens = Math.ceil(maxBytes / MIN_CHARS_PER_TOKEN)

    const base = input.model?.limit?.input ?? input.model?.limit?.context ?? 0
    if (base <= 0) return existingCapTokens

    const fraction = input.safetyFraction ?? 1
    const effectiveLimit = Math.floor(base * fraction)
    const limitCapTokens = Math.floor(effectiveLimit * DEFAULT_LIMIT_FRACTION)
    if (limitCapTokens <= 0) return existingCapTokens
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

    const maxBytes = Math.max(1, Math.floor(capTokens * MIN_CHARS_PER_TOKEN))
    const lines: string[] = []
    for (const line of output.split("\n")) {
      if (line.length <= LINE_CHUNK_CHARS) {
        lines.push(line)
        continue
      }
      for (let i = 0; i < line.length; i += LINE_CHUNK_CHARS) lines.push(line.slice(i, i + LINE_CHUNK_CHARS))
    }
    const totalBytes = Buffer.byteLength(output, "utf-8")
    const preview = TruncateCore.preview(lines, totalBytes, {
      maxLines: Number.MAX_SAFE_INTEGER,
      maxBytes,
      direction: "middle",
      headRatio: TruncateCore.DEFAULT_HEAD_RATIO,
    })
    const hint =
      "The tool call succeeded but the output exceeded the per-result context budget and was truncated before dispatch. Re-run the tool with a narrower query (filters, LIMIT, offset/limit) to view specific sections."
    return { content: TruncateCore.assemble(preview, hint, "middle"), truncated: true }
  }
}
