import { describe, expect, test, beforeEach } from "bun:test"

/**
 * Tests for the calm mode streaming optimizations:
 * 1. Delta event merging (sdk.tsx flush logic)
 * 2. Line buffering (sync.tsx line buffer logic)
 * 3. Flag composition (flag.ts calm mode)
 *
 * These test the core algorithms extracted from the TUI components,
 * since the actual Solid/OpenTUI components require a full render context.
 */

// ─── Delta Event Merging ────────────────────────────────────────────────────
// Extracted from sdk.tsx flush() — merges consecutive delta events for the
// same messageID:partID:field into a single event per flush cycle.

type DeltaEvent = {
  type: "message.part.delta"
  properties: { messageID: string; partID: string; field: string; delta: string }
}

type OtherEvent = {
  type: string
  properties: Record<string, unknown>
}

type Event = DeltaEvent | OtherEvent

function mergeDeltaEvents(events: Event[]): Event[] {
  const merged: Event[] = []
  const deltaMap = new Map<string, number>()
  for (const event of events) {
    if (event.type === "message.part.delta") {
      const props = event.properties as DeltaEvent["properties"]
      const key = `${props.messageID}:${props.partID}:${props.field}`
      const existing = deltaMap.get(key)
      if (existing !== undefined) {
        const prev = merged[existing] as DeltaEvent
        merged[existing] = {
          ...prev,
          properties: {
            ...prev.properties,
            delta: prev.properties.delta + props.delta,
          },
        }
        continue
      }
      deltaMap.set(key, merged.length)
    } else {
      deltaMap.clear()
    }
    merged.push(event)
  }
  return merged
}

describe("delta event merging", () => {
  test("merges consecutive deltas for the same part+field", () => {
    const events: Event[] = [
      { type: "message.part.delta", properties: { messageID: "m1", partID: "p1", field: "text", delta: "Hello" } },
      { type: "message.part.delta", properties: { messageID: "m1", partID: "p1", field: "text", delta: " world" } },
      { type: "message.part.delta", properties: { messageID: "m1", partID: "p1", field: "text", delta: "!" } },
    ]
    const merged = mergeDeltaEvents(events)
    expect(merged).toHaveLength(1)
    expect((merged[0] as DeltaEvent).properties.delta).toBe("Hello world!")
  })

  test("keeps deltas for different parts separate", () => {
    const events: Event[] = [
      { type: "message.part.delta", properties: { messageID: "m1", partID: "p1", field: "text", delta: "A" } },
      { type: "message.part.delta", properties: { messageID: "m1", partID: "p2", field: "text", delta: "B" } },
    ]
    const merged = mergeDeltaEvents(events)
    expect(merged).toHaveLength(2)
    expect((merged[0] as DeltaEvent).properties.delta).toBe("A")
    expect((merged[1] as DeltaEvent).properties.delta).toBe("B")
  })

  test("keeps deltas for different fields separate", () => {
    const events: Event[] = [
      { type: "message.part.delta", properties: { messageID: "m1", partID: "p1", field: "text", delta: "A" } },
      { type: "message.part.delta", properties: { messageID: "m1", partID: "p1", field: "reasoning", delta: "B" } },
    ]
    const merged = mergeDeltaEvents(events)
    expect(merged).toHaveLength(2)
  })

  test("keeps deltas for different messages separate", () => {
    const events: Event[] = [
      { type: "message.part.delta", properties: { messageID: "m1", partID: "p1", field: "text", delta: "A" } },
      { type: "message.part.delta", properties: { messageID: "m2", partID: "p1", field: "text", delta: "B" } },
    ]
    const merged = mergeDeltaEvents(events)
    expect(merged).toHaveLength(2)
  })

  test("preserves causal ordering — clears deltaMap on non-delta events", () => {
    const events: Event[] = [
      { type: "message.part.delta", properties: { messageID: "m1", partID: "p1", field: "text", delta: "first" } },
      { type: "message.part.updated", properties: { part: { messageID: "m1", id: "p1" } } },
      { type: "message.part.delta", properties: { messageID: "m1", partID: "p1", field: "text", delta: "second" } },
    ]
    const merged = mergeDeltaEvents(events)
    // Should NOT merge "first" and "second" because a non-delta event intervenes
    expect(merged).toHaveLength(3)
    expect((merged[0] as DeltaEvent).properties.delta).toBe("first")
    expect(merged[1].type).toBe("message.part.updated")
    expect((merged[2] as DeltaEvent).properties.delta).toBe("second")
  })

  test("resumes merging after non-delta event for new deltas", () => {
    const events: Event[] = [
      { type: "message.part.delta", properties: { messageID: "m1", partID: "p1", field: "text", delta: "a" } },
      { type: "message.updated", properties: { info: {} } },
      { type: "message.part.delta", properties: { messageID: "m1", partID: "p1", field: "text", delta: "b" } },
      { type: "message.part.delta", properties: { messageID: "m1", partID: "p1", field: "text", delta: "c" } },
    ]
    const merged = mergeDeltaEvents(events)
    expect(merged).toHaveLength(3)
    expect((merged[0] as DeltaEvent).properties.delta).toBe("a")
    expect((merged[2] as DeltaEvent).properties.delta).toBe("bc")
  })

  test("does not mutate original events", () => {
    const event1: DeltaEvent = {
      type: "message.part.delta",
      properties: { messageID: "m1", partID: "p1", field: "text", delta: "Hello" },
    }
    const event2: DeltaEvent = {
      type: "message.part.delta",
      properties: { messageID: "m1", partID: "p1", field: "text", delta: " world" },
    }
    mergeDeltaEvents([event1, event2])
    expect(event1.properties.delta).toBe("Hello")
    expect(event2.properties.delta).toBe(" world")
  })

  test("handles empty event list", () => {
    const merged = mergeDeltaEvents([])
    expect(merged).toHaveLength(0)
  })

  test("passes through non-delta events unchanged", () => {
    const events: Event[] = [
      { type: "session.updated", properties: { info: { id: "s1" } } },
      { type: "message.updated", properties: { info: { id: "m1" } } },
    ]
    const merged = mergeDeltaEvents(events)
    expect(merged).toHaveLength(2)
    expect(merged[0].type).toBe("session.updated")
    expect(merged[1].type).toBe("message.updated")
  })

  test("handles single delta event", () => {
    const events: Event[] = [
      { type: "message.part.delta", properties: { messageID: "m1", partID: "p1", field: "text", delta: "solo" } },
    ]
    const merged = mergeDeltaEvents(events)
    expect(merged).toHaveLength(1)
    expect((merged[0] as DeltaEvent).properties.delta).toBe("solo")
  })

  test("merges many deltas efficiently", () => {
    const events: Event[] = Array.from({ length: 100 }, (_, i) => ({
      type: "message.part.delta" as const,
      properties: { messageID: "m1", partID: "p1", field: "text", delta: String(i) },
    }))
    const merged = mergeDeltaEvents(events)
    expect(merged).toHaveLength(1)
    expect((merged[0] as DeltaEvent).properties.delta).toBe(Array.from({ length: 100 }, (_, i) => String(i)).join(""))
  })
})

// ─── Line Buffer ────────────────────────────────────────────────────────────
// Extracted from sync.tsx — buffers deltas and flushes only on \n or forceAll.

class LineBuffer {
  private buffers = new Map<string, string>()
  private flushed: { key: string; text: string }[] = []

  append(messageID: string, partID: string, field: string, delta: string) {
    const key = `${messageID}:${partID}:${field}`
    this.buffers.set(key, (this.buffers.get(key) ?? "") + delta)
    this.flush(messageID, partID, field, false)
  }

  flush(messageID: string, partID: string, field: string, forceAll: boolean) {
    const key = `${messageID}:${partID}:${field}`
    const buffer = this.buffers.get(key)
    if (!buffer) return
    let textToFlush: string
    if (forceAll) {
      textToFlush = buffer
      this.buffers.delete(key)
    } else {
      const lastNewline = buffer.lastIndexOf("\n")
      if (lastNewline === -1) return
      textToFlush = buffer.slice(0, lastNewline + 1)
      const remainder = buffer.slice(lastNewline + 1)
      if (remainder) this.buffers.set(key, remainder)
      else this.buffers.delete(key)
    }
    if (textToFlush) {
      this.flushed.push({ key, text: textToFlush })
    }
  }

  flushAllForMessage(messageID: string) {
    for (const [key] of this.buffers) {
      if (!key.startsWith(messageID + ":")) continue
      const [, partID, field] = key.split(":")
      this.flush(messageID, partID, field, true)
    }
  }

  getFlushed() {
    return this.flushed
  }

  getBuffer(messageID: string, partID: string, field: string) {
    return this.buffers.get(`${messageID}:${partID}:${field}`)
  }

  reset() {
    this.buffers.clear()
    this.flushed = []
  }
}

describe("line buffer", () => {
  let lb: LineBuffer

  beforeEach(() => {
    lb = new LineBuffer()
  })

  test("buffers text without newlines — nothing flushed", () => {
    lb.append("m1", "p1", "text", "Hello world")
    expect(lb.getFlushed()).toHaveLength(0)
    expect(lb.getBuffer("m1", "p1", "text")).toBe("Hello world")
  })

  test("flushes complete line on newline", () => {
    lb.append("m1", "p1", "text", "Hello\n")
    expect(lb.getFlushed()).toHaveLength(1)
    expect(lb.getFlushed()[0].text).toBe("Hello\n")
    expect(lb.getBuffer("m1", "p1", "text")).toBeUndefined()
  })

  test("flushes up to last newline, keeps remainder", () => {
    lb.append("m1", "p1", "text", "line1\nline2\npartial")
    expect(lb.getFlushed()).toHaveLength(1)
    expect(lb.getFlushed()[0].text).toBe("line1\nline2\n")
    expect(lb.getBuffer("m1", "p1", "text")).toBe("partial")
  })

  test("accumulates across multiple appends, flushes on newline", () => {
    lb.append("m1", "p1", "text", "Hel")
    lb.append("m1", "p1", "text", "lo ")
    lb.append("m1", "p1", "text", "wor")
    expect(lb.getFlushed()).toHaveLength(0)
    lb.append("m1", "p1", "text", "ld\n")
    expect(lb.getFlushed()).toHaveLength(1)
    expect(lb.getFlushed()[0].text).toBe("Hello world\n")
  })

  test("handles multiple newlines in one append", () => {
    lb.append("m1", "p1", "text", "a\nb\nc\n")
    expect(lb.getFlushed()).toHaveLength(1)
    expect(lb.getFlushed()[0].text).toBe("a\nb\nc\n")
    expect(lb.getBuffer("m1", "p1", "text")).toBeUndefined()
  })

  test("handles newline in middle of append", () => {
    lb.append("m1", "p1", "text", "first\nsecond")
    expect(lb.getFlushed()).toHaveLength(1)
    expect(lb.getFlushed()[0].text).toBe("first\n")
    expect(lb.getBuffer("m1", "p1", "text")).toBe("second")
  })

  test("forceAll flushes everything including partial line", () => {
    lb.append("m1", "p1", "text", "no newline here")
    expect(lb.getFlushed()).toHaveLength(0)
    lb.flush("m1", "p1", "text", true)
    expect(lb.getFlushed()).toHaveLength(1)
    expect(lb.getFlushed()[0].text).toBe("no newline here")
    expect(lb.getBuffer("m1", "p1", "text")).toBeUndefined()
  })

  test("flushAllForMessage flushes all parts of a message", () => {
    lb.append("m1", "p1", "text", "part1 partial")
    lb.append("m1", "p2", "text", "part2 partial")
    lb.append("m2", "p1", "text", "other msg")
    expect(lb.getFlushed()).toHaveLength(0)

    lb.flushAllForMessage("m1")
    expect(lb.getFlushed()).toHaveLength(2)
    expect(
      lb
        .getFlushed()
        .map((f) => f.text)
        .sort(),
    ).toEqual(["part1 partial", "part2 partial"])
    // m2 buffer should be untouched
    expect(lb.getBuffer("m2", "p1", "text")).toBe("other msg")
  })

  test("flushAllForMessage is safe when no buffers exist", () => {
    lb.flushAllForMessage("nonexistent")
    expect(lb.getFlushed()).toHaveLength(0)
  })

  test("handles empty delta", () => {
    lb.append("m1", "p1", "text", "")
    expect(lb.getFlushed()).toHaveLength(0)
    expect(lb.getBuffer("m1", "p1", "text")).toBe("")
  })

  test("handles delta that is just a newline", () => {
    lb.append("m1", "p1", "text", "\n")
    expect(lb.getFlushed()).toHaveLength(1)
    expect(lb.getFlushed()[0].text).toBe("\n")
  })

  test("handles consecutive newlines", () => {
    lb.append("m1", "p1", "text", "\n\n\n")
    expect(lb.getFlushed()).toHaveLength(1)
    expect(lb.getFlushed()[0].text).toBe("\n\n\n")
  })

  test("independent buffers for different fields", () => {
    lb.append("m1", "p1", "text", "text content\n")
    lb.append("m1", "p1", "reasoning", "thinking...")
    expect(lb.getFlushed()).toHaveLength(1)
    expect(lb.getFlushed()[0].text).toBe("text content\n")
    expect(lb.getBuffer("m1", "p1", "reasoning")).toBe("thinking...")
  })

  test("sequential flushes accumulate correctly", () => {
    lb.append("m1", "p1", "text", "line1\n")
    lb.append("m1", "p1", "text", "line2\n")
    lb.append("m1", "p1", "text", "line3\n")
    expect(lb.getFlushed()).toHaveLength(3)
    expect(lb.getFlushed().map((f) => f.text)).toEqual(["line1\n", "line2\n", "line3\n"])
  })

  test("large buffer with many lines", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`)
    lb.append("m1", "p1", "text", lines.join("\n") + "\npartial")
    expect(lb.getFlushed()).toHaveLength(1)
    expect(lb.getFlushed()[0].text).toBe(lines.join("\n") + "\n")
    expect(lb.getBuffer("m1", "p1", "text")).toBe("partial")
  })
})

// ─── Flag Composition ───────────────────────────────────────────────────────

// Simulates the flag resolution logic from flag.ts using function calls
// to avoid TypeScript nullish-expression warnings with literal values.
function resolveFlags(opts: {
  calmMode: boolean
  smoothStreamingFlag: boolean
  lineStreamingFlag: boolean
  contentWidthEnv: number | undefined
  contentWidthFallback: number | undefined
}) {
  const smoothStreaming = opts.calmMode || opts.smoothStreamingFlag
  const lineStreaming = opts.calmMode || opts.lineStreamingFlag
  const contentMaxWidth = opts.contentWidthEnv ?? opts.contentWidthFallback ?? (opts.calmMode ? 100 : undefined)
  return { smoothStreaming, lineStreaming, contentMaxWidth }
}

describe("calm mode flag composition", () => {
  test("ALTIMATE_CALM_MODE enables all three sub-flags", () => {
    const flags = resolveFlags({
      calmMode: true,
      smoothStreamingFlag: false,
      lineStreamingFlag: false,
      contentWidthEnv: undefined,
      contentWidthFallback: undefined,
    })
    expect(flags.smoothStreaming).toBe(true)
    expect(flags.lineStreaming).toBe(true)
    expect(flags.contentMaxWidth).toBe(100)
  })

  test("individual flags work without calm mode", () => {
    const flags = resolveFlags({
      calmMode: false,
      smoothStreamingFlag: true,
      lineStreamingFlag: false,
      contentWidthEnv: undefined,
      contentWidthFallback: undefined,
    })
    expect(flags.smoothStreaming).toBe(true)
    expect(flags.lineStreaming).toBe(false)
    expect(flags.contentMaxWidth).toBeUndefined()
  })

  test("custom content width overrides calm mode default", () => {
    const flags = resolveFlags({
      calmMode: true,
      smoothStreamingFlag: false,
      lineStreamingFlag: false,
      contentWidthEnv: 80,
      contentWidthFallback: undefined,
    })
    expect(flags.contentMaxWidth).toBe(80)
  })

  test("all flags disabled by default", () => {
    const flags = resolveFlags({
      calmMode: false,
      smoothStreamingFlag: false,
      lineStreamingFlag: false,
      contentWidthEnv: undefined,
      contentWidthFallback: undefined,
    })
    expect(flags.smoothStreaming).toBe(false)
    expect(flags.lineStreaming).toBe(false)
    expect(flags.contentMaxWidth).toBeUndefined()
  })
})

// ─── Content Width Capping ──────────────────────────────────────────────────

describe("content width capping", () => {
  function computeCappedWidth(cap: number | undefined, availableWidth: number): number | undefined {
    if (!cap) return undefined
    const desired = cap + 3 // +3 for paddingLeft
    return availableWidth <= desired ? undefined : desired
  }

  test("returns desired width when screen is wide enough", () => {
    expect(computeCappedWidth(100, 200)).toBe(103)
  })

  test("returns undefined (no cap) when screen is smaller than cap", () => {
    expect(computeCappedWidth(100, 80)).toBeUndefined()
  })

  test("returns undefined when screen equals cap + padding", () => {
    expect(computeCappedWidth(100, 103)).toBeUndefined()
  })

  test("returns undefined when cap is undefined", () => {
    expect(computeCappedWidth(undefined, 200)).toBeUndefined()
  })

  test("returns undefined when cap is 0", () => {
    expect(computeCappedWidth(0, 200)).toBeUndefined()
  })

  test("works with very small screens", () => {
    expect(computeCappedWidth(100, 40)).toBeUndefined()
  })

  test("works with very large caps", () => {
    expect(computeCappedWidth(300, 400)).toBe(303)
  })

  test("works with cap of 1", () => {
    expect(computeCappedWidth(1, 10)).toBe(4)
  })
})
