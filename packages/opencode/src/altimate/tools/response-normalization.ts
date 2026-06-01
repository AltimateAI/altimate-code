export function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function normalizeError(value: unknown): string | undefined {
  if (value instanceof Error) return value.message
  if (typeof value === "string") return value
  // Treat falsy non-string sentinels (null/undefined/false/0) as "no error" so a
  // dispatcher returning `error: false` is not coerced to the truthy string "false".
  if (value === null || value === undefined || value === false || value === 0) return undefined
  if (isRecord(value)) {
    // Surface common string error shapes without stringifying the whole object,
    // which could leak auth/connection details into user-facing output.
    if (typeof value.message === "string") return value.message
    if (typeof value.error === "string") return value.error
    if (typeof value.detail === "string") return value.detail
    return "Error details unavailable."
  }
  return String(value)
}
