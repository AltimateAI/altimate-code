export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]"
  const obj = value as Record<string, unknown>
  return (
    "{" +
    Object.keys(obj)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + stableJson(obj[k]))
      .join(",") +
    "}"
  )
}
