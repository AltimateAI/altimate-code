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
 * reflects arbitrary file content back into CLI/tool output. A token is kept
 * only when it BOTH looks like a short keyword phrase AND starts with a known
 * SQL statement keyword — shape alone would pass content like
 * "TOP SECRET PASSWORD" or "AKIAIOSFODNN7EXAMPLE".
 */
const REDACTED = "<non-SQL content redacted>"
const SQL_TOKEN_SHAPE = /^[A-Za-z_][A-Za-z0-9_$ ]{0,31}$/
const SQL_STATEMENT_KEYWORDS = new Set([
  "SELECT", "INSERT", "UPDATE", "DELETE", "DROP", "CREATE", "ALTER", "TRUNCATE",
  "GRANT", "REVOKE", "MERGE", "WITH", "BEGIN", "COMMIT", "ROLLBACK", "SET",
  "USE", "CALL", "EXPLAIN", "ANALYZE", "VACUUM", "COPY", "SHOW", "DESCRIBE",
  "DESC", "EXECUTE", "EXEC", "REPLACE", "VALUES", "LOCK", "UNLOCK", "COMMENT",
  "RENAME", "START", "SAVEPOINT", "RELEASE", "PREPARE", "DEALLOCATE",
])
function isSqlStatementType(token: string): boolean {
  const t = token.trim()
  if (!SQL_TOKEN_SHAPE.test(t)) return false
  return SQL_STATEMENT_KEYWORDS.has(t.split(/\s+/)[0].toUpperCase())
}
export function redactThreatText(text: string): string {
  return (
    text
      .replace(/(Disallowed statement type: )(.+)$/i, (_m, prefix: string, tok: string) =>
        isSqlStatementType(tok) ? `${prefix}${tok}` : `${prefix}${REDACTED}`,
      )
      // GREEDY quoted match — an attacker apostrophe inside the token would
      // otherwise close the match early and leak the remainder
      // (e.g. "Statement type 'DROP'ROOT:X:0' is not…"). Greedy capture spans
      // to the LAST quote; embedded quotes fail the shape check and redact.
      .replace(/(Statement type ')(.*)(')/i, (_m, a: string, tok: string, c: string) =>
        isSqlStatementType(tok) ? `${a}${tok}${c}` : `${a}${REDACTED}${c}`,
      )
  )
}

/**
 * Redact raw-input echoes from a scan result's threats. For `multi_statement`
 * the matched pattern IS the raw input line, so it is always redacted;
 * injection rules keep their SQL-shaped patterns. Pure record manipulation —
 * safe to use from any consumer without loading the NAPI binding.
 */
export function redactScan(scan: Record<string, unknown>): Record<string, unknown> {
  const threats = (scan.threats as any[] | undefined)?.map((t: any) => ({
    ...t,
    message: typeof t.message === "string" ? redactThreatText(t.message) : t.message,
    detail: typeof t.detail === "string" ? redactThreatText(t.detail) : t.detail,
    matched_pattern: t.rule === "multi_statement" ? "<redacted>" : t.matched_pattern,
  }))
  return threats ? { ...scan, threats } : scan
}

export * as EngineCoerce from "./engine-coerce"
