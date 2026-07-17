// altimate_change start — preserve full URL hyperlink targets
import { For } from "solid-js"
import { CodeRenderable, detectLinks, type MarkdownOptions, type Renderable, type TextChunk } from "@opentui/core"

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/g
const DEFAULT_MAX_URL_DISPLAY_WIDTH = 64
const ELLIPSIS = "…"
const transformedCodeRenderables = new WeakSet<CodeRenderable>()

export type TerminalLinkSegment = {
  text: string
  href?: string
}

type UrlMatch = {
  href: string
  start: number
  end: number
}

export function splitTerminalLinks(
  displayText: string,
  options: { sourceText?: string; maxUrlDisplayWidth?: number } = {},
): TerminalLinkSegment[] {
  if (!displayText) return []

  const sourceText = options.sourceText ?? displayText
  const maxUrlDisplayWidth = options.maxUrlDisplayWidth ?? DEFAULT_MAX_URL_DISPLAY_WIDTH
  const matches = findUrlMatches(sourceText)
  if (matches.length === 0) return [{ text: displayText }]

  const segments: TerminalLinkSegment[] = []
  let displayOffset = 0

  for (const match of matches) {
    if (match.end <= displayOffset) continue
    if (match.start >= displayText.length) break

    const visibleStart = Math.max(match.start, displayOffset)
    const visibleEnd = Math.min(match.end, displayText.length)
    if (visibleEnd <= visibleStart) continue

    if (visibleStart > displayOffset) {
      segments.push({ text: displayText.slice(displayOffset, visibleStart) })
    }

    const visibleText = displayText.slice(visibleStart, visibleEnd)
    const isSourceDisplay = sourceText === displayText
    segments.push({
      text: formatUrlDisplay(isSourceDisplay ? match.href : visibleText, maxUrlDisplayWidth),
      href: match.href,
    })
    displayOffset = visibleEnd
  }

  if (displayOffset < displayText.length) {
    segments.push({ text: displayText.slice(displayOffset) })
  }

  return mergeAdjacentPlainSegments(segments)
}

export function TerminalLinkText(props: {
  text: string
  sourceText?: string
  maxUrlDisplayWidth?: number
}) {
  return (
    <For each={splitTerminalLinks(props.text, { sourceText: props.sourceText, maxUrlDisplayWidth: props.maxUrlDisplayWidth })}>
      {(segment) => (segment.href ? <a href={segment.href}>{segment.text}</a> : segment.text)}
    </For>
  )
}

export function attachTerminalLinkChunkTransform(
  renderable: Renderable | null | undefined,
  maxUrlDisplayWidth: () => number,
) {
  if (!renderable) return renderable

  if (renderable instanceof CodeRenderable && !transformedCodeRenderables.has(renderable)) {
    transformedCodeRenderables.add(renderable)
    const previous = renderable.onChunks
    renderable.onChunks = async (chunks, context) => {
      const linked = previous ? ((await previous(chunks, context)) ?? chunks) : detectLinks(chunks, context)
      return shortenLinkedChunks(linked, maxUrlDisplayWidth())
    }
  }

  for (const child of renderable.getChildren()) {
    attachTerminalLinkChunkTransform(child, maxUrlDisplayWidth)
  }

  return renderable
}

export function terminalLinkMarkdownRenderNode(
  maxUrlDisplayWidth: () => number,
): NonNullable<MarkdownOptions["renderNode"]> {
  return (_token, context) => attachTerminalLinkChunkTransform(context.defaultRender(), maxUrlDisplayWidth) ?? null
}

export function linkTerminalChunks(maxUrlDisplayWidth: () => number) {
  return (chunks: TextChunk[], context: Parameters<NonNullable<CodeRenderable["onChunks"]>>[1]) => {
    return shortenLinkedChunks(detectLinks(chunks, context), maxUrlDisplayWidth())
  }
}

export function shortenLinkedChunks(chunks: TextChunk[], maxUrlDisplayWidth = DEFAULT_MAX_URL_DISPLAY_WIDTH) {
  return chunks.map((chunk) => {
    const href = chunk.link?.url
    if (!href) return chunk

    const text = formatLinkedText(chunk.text, href, maxUrlDisplayWidth)
    if (text === chunk.text) return chunk
    return { ...chunk, text }
  })
}

export function formatUrlDisplay(url: string, maxWidth = DEFAULT_MAX_URL_DISPLAY_WIDTH) {
  if (maxWidth <= 0 || Bun.stringWidth(url) <= maxWidth) return url
  if (maxWidth <= Bun.stringWidth(ELLIPSIS)) return ELLIPSIS

  const budget = maxWidth - Bun.stringWidth(ELLIPSIS)
  const startWidth = Math.max(1, Math.ceil(budget * 0.58))
  const endWidth = Math.max(1, budget - startWidth)

  return takeColumns(url, startWidth) + ELLIPSIS + takeColumnsEnd(url, endWidth)
}

function formatLinkedText(text: string, href: string, maxUrlDisplayWidth: number) {
  if (text === href || looksLikeUrl(text)) return formatUrlDisplay(text, maxUrlDisplayWidth)

  const index = text.indexOf(href)
  if (index === -1) return text

  return text.slice(0, index) + formatUrlDisplay(href, maxUrlDisplayWidth) + text.slice(index + href.length)
}

function findUrlMatches(text: string): UrlMatch[] {
  const matches: UrlMatch[] = []
  URL_PATTERN.lastIndex = 0

  let match: RegExpExecArray | null
  while ((match = URL_PATTERN.exec(text))) {
    const raw = match[0]
    const suffix = trailingUrlPunctuation(raw)
    const href = raw.slice(0, raw.length - suffix.length)
    if (!href) continue

    matches.push({
      href,
      start: match.index,
      end: match.index + href.length,
    })
  }

  return matches
}

function trailingUrlPunctuation(value: string) {
  let suffix = ""
  let rest = value

  while (/[.,!?;:]$/.test(rest)) {
    suffix = rest.at(-1)! + suffix
    rest = rest.slice(0, -1)
  }

  while (rest.endsWith(")") && count(rest, "(") < count(rest, ")")) {
    suffix = ")" + suffix
    rest = rest.slice(0, -1)
  }

  while (rest.endsWith("]") && count(rest, "[") < count(rest, "]")) {
    suffix = "]" + suffix
    rest = rest.slice(0, -1)
  }

  return suffix
}

function looksLikeUrl(text: string) {
  URL_PATTERN.lastIndex = 0
  const match = URL_PATTERN.exec(text)
  return match?.index === 0
}

function takeColumns(value: string, maxWidth: number) {
  let width = 0
  let output = ""

  for (const char of value) {
    const next = width + Bun.stringWidth(char)
    if (next > maxWidth) break
    width = next
    output += char
  }

  return output
}

function takeColumnsEnd(value: string, maxWidth: number) {
  let width = 0
  let output = ""
  const chars = Array.from(value)

  for (let index = chars.length - 1; index >= 0; index--) {
    const char = chars[index]!
    const next = width + Bun.stringWidth(char)
    if (next > maxWidth) break
    width = next
    output = char + output
  }

  return output
}

function count(value: string, needle: string) {
  let total = 0
  for (const char of value) {
    if (char === needle) total++
  }
  return total
}

function mergeAdjacentPlainSegments(segments: TerminalLinkSegment[]) {
  const merged: TerminalLinkSegment[] = []

  for (const segment of segments) {
    const previous = merged.at(-1)
    if (previous && !previous.href && !segment.href) {
      previous.text += segment.text
      continue
    }
    merged.push(segment)
  }

  return merged
}
// altimate_change end
