import { displaySlice } from "./display"

export function stripPromptPartIDs<Part extends { id: string; messageID: string; sessionID: string }>(part: Part) {
  const { id: _id, messageID: _messageID, sessionID: _sessionID, ...rest } = part
  return rest
}

export function expandPastedTextPlaceholders(text: string, parts: readonly unknown[]) {
  return parts.reduce<string>((result, part) => {
    if (!isPastedTextPart(part)) return result
    return result.replace(part.source.text.value, () => part.text) // altimate_change — replace with literal pasted content
  }, text)
}

// altimate_change start — rewrite only when each pasted marker can be identified unambiguously
export function expandEnhancedPrompt(original: string, enhanced: string, parts: readonly unknown[], originalExpanded: string) {
  const seen = new Set<string>()
  const ranges: { start: number; end: number; text: string }[] = []
  for (const part of parts.filter(isPastedTextPart)) {
    const marker = part.source.text.value
    if (!marker || seen.has(marker)) return originalExpanded
    seen.add(marker)
    const before = original.indexOf(marker)
    const after = enhanced.indexOf(marker)
    if (before === -1 || before !== original.lastIndexOf(marker)) return originalExpanded
    if (after === -1 || after !== enhanced.lastIndexOf(marker)) return originalExpanded
    ranges.push({ start: after, end: after + marker.length, text: part.text })
  }

  return ranges.sort((a, b) => b.start - a.start).reduce(
    (text, range) => text.slice(0, range.start) + range.text + text.slice(range.end),
    enhanced,
  )
}
// altimate_change end

function isPastedTextPart(part: unknown): part is { type: "text"; text: string; source: { text: { value: string } } } {
  if (!part || typeof part !== "object" || !("type" in part) || part.type !== "text") return false
  if (!("text" in part) || typeof part.text !== "string" || !("source" in part)) return false
  const source = part.source
  if (!source || typeof source !== "object" || !("text" in source)) return false
  const text = source.text
  return Boolean(text && typeof text === "object" && "value" in text && typeof text.value === "string")
}

export function expandTrackedPastedText(text: string, ranges: { start: number; end: number; text: string }[]) {
  return ranges
    .slice()
    .sort((a, b) => b.start - a.start)
    .reduce((result, part) => displaySlice(result, 0, part.start) + part.text + displaySlice(result, part.end), text)
}
