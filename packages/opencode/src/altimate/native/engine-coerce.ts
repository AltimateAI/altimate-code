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
