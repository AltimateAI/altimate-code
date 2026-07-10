import { describe, expect, test } from "bun:test"
import type { TextChunk } from "@opentui/core"
import { formatUrlDisplay, shortenLinkedChunks, splitTerminalLinks } from "../../src/util/terminal-link"

describe("terminal links", () => {
  test("shortens the displayed URL without changing the target", () => {
    const url = "https://example.com/really/long/path/with/query?alpha=one&beta=two&gamma=three"
    const [segment] = splitTerminalLinks(url, { maxUrlDisplayWidth: 32 })

    expect(segment?.href).toBe(url)
    expect(segment?.text).toBe(formatUrlDisplay(url, 32))
    expect(segment?.text).toContain("…")
  })

  test("uses the full source URL when display text was already collapsed", () => {
    const url = "https://example.com/really/long/path/with/query?alpha=one&beta=two&gamma=three"
    const display = url.slice(0, 30) + "…"
    const [segment] = splitTerminalLinks(display, { sourceText: url })

    expect(segment?.href).toBe(url)
    expect(segment?.text).toBe(display)
  })

  test("preserves full link targets on shortened text chunks", () => {
    const url = "https://example.com/really/long/path/with/query?alpha=one&beta=two&gamma=three"
    const chunks: TextChunk[] = [{ __isChunk: true, text: url, link: { url } }]
    const [chunk] = shortenLinkedChunks(chunks, 28)

    expect(chunk?.link?.url).toBe(url)
    expect(chunk?.text).toBe(formatUrlDisplay(url, 28))
    expect(chunk?.text).toContain("…")
  })
})
