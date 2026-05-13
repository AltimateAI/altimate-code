export function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function normalizeError(value: unknown): string | undefined {
  if (value instanceof Error) return value.message
  if (typeof value === "string") return value
  if (value === null || value === undefined) return undefined
  if (isRecord(value)) {
    if (typeof value.message === "string") return value.message
    return "Error details unavailable."
  }
  return String(value)
}
