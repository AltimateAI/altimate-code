export namespace Token {
  // Default ratio for mixed content (slightly more conservative than 4.0)
  const DEFAULT_CHARS_PER_TOKEN = 3.7

  // Content-type specific ratios based on empirical measurement
  // against cl100k_base (GPT-4/Claude) tokenizer
  const RATIOS = {
    code: 3.0,
    json: 3.2,
    sql: 3.5,
    text: 4.0,
  } as const

  /**
   * Estimate token count for a string.
   * Uses content-aware heuristics for better accuracy.
   */
  export function estimate(input: string): number {
    if (!input || typeof input !== "string") return 0
    const ratio = detectRatio(input)
    return Math.max(0, Math.round(input.length / ratio))
  }

  /**
   * Estimate with an explicit content type hint.
   */
  export function estimateWithHint(
    input: string,
    hint: keyof typeof RATIOS,
  ): number {
    if (!input || typeof input !== "string") return 0
    const ratio = RATIOS[hint] ?? DEFAULT_CHARS_PER_TOKEN
    return Math.max(0, Math.round(input.length / ratio))
  }

  function detectRatio(input: string): number {
    // Sample first 500 chars for classification (perf)
    const sample = input.length > 500 ? input.slice(0, 500) : input

    // JSON: starts with { or [, or high density of : and "
    if (/^\s*[\[{]/.test(sample)) {
      const jsonChars = (sample.match(/[{}[\]:,"]/g) || []).length
      if (jsonChars / sample.length > 0.15) return RATIOS.json
    }

    // SQL: contains common SQL keywords
    const sqlKeywords =
      /\b(SELECT|FROM|WHERE|JOIN|INSERT|UPDATE|DELETE|CREATE|ALTER|GROUP BY|ORDER BY)\b/i
    if (sqlKeywords.test(sample)) return RATIOS.sql

    // Code: high density of special characters ({, }, (, ), ;, =)
    const codeChars = (sample.match(/[{}();=<>!&|+\-*/]/g) || []).length
    if (codeChars / sample.length > 0.08) return RATIOS.code

    return DEFAULT_CHARS_PER_TOKEN
  }
}
