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
