/**
 * Shared coercions for altimate-core engine values.
 *
 * The engine's napi surface has two recurring foot-guns for consumers:
 * - `PiiClassification` is a string OR `{ Custom: string }` — naive string
 *   interpolation renders `[object Object]`.
 * - dialect parameters throw on the empty string (`unknown dialect ''`);
 *   `""` must mean "auto-detect" and be passed as undefined.
 */

/** PiiClassification is 'Email' | … | { Custom: string } | 'None'. */
export function classificationToString(c: unknown, fallback = "PII"): string {
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

/** Map the engine's numeric confidence (0..1) to a string band. */
export function bandConfidence(c: unknown): "high" | "medium" | "low" {
  if (typeof c === "string") {
    const s = c.toLowerCase()
    if (s === "high" || s === "medium" || s === "low") return s
  }
  const n = typeof c === "number" ? c : NaN
  if (n >= 0.8) return "high"
  if (n >= 0.5) return "medium"
  return "low"
}
