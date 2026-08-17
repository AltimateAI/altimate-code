/**
 * Shared coercions for altimate-core engine values.
 *
 * The engine's napi surface has recurring foot-guns for consumers:
 * - `PiiClassification` is a string OR `{ Custom: string }` — naive string
 *   interpolation renders `[object Object]`.
 * - dialect parameters throw on the empty string (`unknown dialect ''`);
 *   `""` must mean "auto-detect" and be passed as undefined.
 * - confidence is numeric (0..1) while several consumers declare string bands.
 *
 * This module must stay free of `@altimateai/altimate-core` imports so tool
 * modules can use it without eagerly loading the native NAPI binding.
 */

/** PiiClassification is 'Email' | … | { Custom: string } | 'None'. */
export function classificationToString(c: unknown, fallback = "UNKNOWN"): string {
  if (typeof c === "string") return c
  if (c && typeof c === "object" && typeof (c as { Custom?: unknown }).Custom === "string") {
    return (c as { Custom: string }).Custom
  }
  return fallback
}

/** Coerce an optional dialect to an engine-safe hint: "" and null mean auto-detect. */
export function dialectHint(dialect: string | undefined | null): string | undefined {
  return dialect || undefined
}

/**
 * Map the engine's numeric confidence (0..1) to a string band.
 * Missing or non-numeric confidence is unknown, not low — band it "medium".
 */
export function bandConfidence(c: unknown): "high" | "medium" | "low" {
  if (typeof c === "string") {
    const s = c.toLowerCase()
    if (s === "high" || s === "medium" || s === "low") return s
  }
  const n = typeof c === "number" && Number.isFinite(c) ? c : 0.5
  if (n >= 0.8) return "high"
  if (n >= 0.5) return "medium"
  return "low"
}

/**
 * Extract the real PII rows from an engine PiiReport.
 *
 * The engine returns `{ columns, pii_count, risk_level, total_columns }` with
 * a row for EVERY column — classification "None" means not PII.
 *
 * Fails closed: a report without an array `columns` field is malformed (the
 * engine always emits one) and throws instead of silently yielding zero
 * findings — silent-empty output is exactly the bug class this fixes.
 */
export function piiColumnsFromReport(piiData: unknown): Array<Record<string, any>> {
  const columns = (piiData as Record<string, any> | null | undefined)?.columns
  if (!Array.isArray(columns)) {
    throw new TypeError("malformed PiiReport: missing columns array")
  }
  return columns.filter((c) => c && c.classification !== "None")
}

/**
 * Redact raw input echoed inside engine threat messages.
 *
 * The engine's `multi_statement` rule quotes the offending "statement type"
 * verbatim — for non-SQL input (e.g. `altimate check /etc/passwd`) that
 * reflects arbitrary file content back into CLI/tool output. Keep the token
 * only when it looks like a SQL keyword phrase; otherwise redact.
 */
const SQL_KEYWORD_LIKE = /^[A-Za-z_][A-Za-z0-9_$ ]{0,31}$/
export function redactThreatText(text: string): string {
  return text
    .replace(/(Disallowed statement type: )(.+)$/i, (_m, prefix: string, tok: string) =>
      SQL_KEYWORD_LIKE.test(tok.trim()) ? `${prefix}${tok}` : `${prefix}<non-SQL content redacted>`,
    )
    .replace(/(Statement type ')([^']*)(')/i, (_m, a: string, tok: string, c: string) =>
      SQL_KEYWORD_LIKE.test(tok) ? `${a}${tok}${c}` : `${a}<non-SQL content redacted>${c}`,
    )
}

export * as EngineCoerce from "./engine-coerce"
