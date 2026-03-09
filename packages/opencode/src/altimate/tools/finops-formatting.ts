export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB", "PB"]
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(i === 0 ? 0 : 2)} ${units[i]}`
}

export function truncateQuery(text: string, maxLen: number): string {
  if (!text) return "(empty)"
  const oneLine = text.replace(/\s+/g, " ").trim()
  if (oneLine.length <= maxLen) return oneLine
  return oneLine.slice(0, maxLen - 3) + "..."
}
