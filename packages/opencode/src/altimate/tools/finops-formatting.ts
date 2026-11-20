export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  if (!Number.isFinite(bytes)) return "0 B"
  const abs = Math.abs(bytes)
  const units = ["B", "KB", "MB", "GB", "TB", "PB"]
  const i = Math.max(0, Math.min(Math.floor(Math.log(abs) / Math.log(1024)), units.length - 1))
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(i === 0 ? 0 : 2)} ${units[i]}`
}

export function truncateQuery(text: string, maxLen: number): string {
  if (!text) return "(empty)"
  const oneLine = text.replace(/\s+/g, " ").trim()
  if (!oneLine) return "(empty)"
  if (maxLen <= 0) return ""
  if (maxLen < 4) return oneLine.slice(0, maxLen)
  if (oneLine.length <= maxLen) return oneLine
  return oneLine.slice(0, maxLen - 3) + "..."
}

/** Dollars to the cent below $100, to the dollar from there. */
export function dollars(value: number): string {
  return value >= 100 ? `$${Math.round(value).toLocaleString("en-US")}` : `$${value.toFixed(2)}`
}

/** A low–high dollar range, or one figure when both read the same. */
export function range(low: number, high: number): string {
  return dollars(low) === dollars(high) ? dollars(high) : `${dollars(low)}–${dollars(high)}`
}

/** Free text from the warehouse on one line, with control and invisible characters gone. */
export const oneLine = (value: unknown) =>
  String(value ?? "")
    .replace(/\p{Cf}/gu, "")
    .replace(/[\s\p{Cc}]+/gu, " ")
    .trim()
