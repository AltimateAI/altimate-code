// Pure truncation-selection algorithm shared by `tool/truncate.ts` (the Effect
// Service every `Tool.define()` output is routed through via `tool.ts:wrap()` —
// this is what the bash tool actually uses in production) and
// `tool/truncation.ts` (the plain-async twin used directly by `bash.ts`'s
// description-text constants, `bootstrap.ts`'s cleanup scheduler, and
// `prompt.ts`'s MCP tool-output truncation). Both call this ONE algorithm so a
// future change to truncation behavior cannot silently apply on one call path
// and not the other, the way the pre-existing hand-duplicated implementations
// could.
export const MAX_LINES = 2000
export const MAX_BYTES = 50 * 1024

// Head:tail split for "middle" (head+tail) truncation. First-principles, not
// fitted to any specific corpus: root-cause errors print FIRST for the
// common compiler/build/test tool families (tsc, pytest, gcc, dbt-compile,
// ...) while verdict/success lines print LAST — weighting toward the tail
// keeps the higher-density trailing content while still guaranteeing the
// command's first error line(s) survive at the head. Callers may override
// per call via `Options.headRatio`.
export const DEFAULT_HEAD_RATIO = 1 / 3

// Promoted default (was "head"): pure head truncation silently drops
// trailing content — including the success/verdict line most command
// families print last. "middle" is family-neutral by construction.
export const DEFAULT_DIRECTION: Direction = "middle"

export type Direction = "head" | "tail" | "middle"

export interface Options {
  maxLines?: number
  maxBytes?: number
  direction?: Direction
  headRatio?: number
}

export interface ResolvedOptions {
  maxLines: number
  maxBytes: number
  direction: Direction
  headRatio: number
}

export interface Preview {
  head: string
  tail: string
  removed: number
  unit: "bytes" | "lines"
}

export function fits(lines: string[], totalBytes: number, maxLines: number, maxBytes: number): boolean {
  return lines.length <= maxLines && totalBytes <= maxBytes
}

interface Selection {
  lines: string[]
  bytes: number
  hitBytes: boolean
}

function selectFromHead(lines: string[], maxLines: number, maxBytes: number): Selection {
  const out: string[] = []
  let bytes = 0
  let hitBytes = false
  for (let i = 0; i < lines.length && out.length < maxLines; i++) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      hitBytes = true
      break
    }
    out.push(lines[i])
    bytes += size
  }
  return { lines: out, bytes, hitBytes }
}

// Longest prefix of `text` whose UTF-8 encoding fits in `maxBytes`, cut on a
// character boundary (never mid-codepoint).
function bytePrefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ""
  const buf = Buffer.from(text, "utf-8")
  if (buf.length <= maxBytes) return text
  let end = maxBytes
  // 0b10xxxxxx is a UTF-8 continuation byte: back off until `end` starts a codepoint.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
  return buf.subarray(0, end).toString("utf-8")
}

// Longest suffix of `text` whose UTF-8 encoding fits in `maxBytes`, cut on a
// character boundary.
function byteSuffix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ""
  const buf = Buffer.from(text, "utf-8")
  if (buf.length <= maxBytes) return text
  let start = buf.length - maxBytes
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
  return buf.subarray(start).toString("utf-8")
}

// `notBefore`: lowest index the tail selection may consume, so a "middle"
// selection can never re-select a line already claimed by the head half.
function selectFromTail(lines: string[], maxLines: number, maxBytes: number, notBefore: number): Selection {
  const out: string[] = []
  let bytes = 0
  let hitBytes = false
  for (let i = lines.length - 1; i >= notBefore && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      hitBytes = true
      break
    }
    out.unshift(lines[i])
    bytes += size
  }
  return { lines: out, bytes, hitBytes }
}

/**
 * Selects the preview lines to keep for `lines`/`totalBytes` under the given
 * direction and budget. Callers must first confirm `fits()` is false —
 * `preview()` always assumes at least one line/byte is being removed.
 */
export function preview(lines: string[], totalBytes: number, opts: ResolvedOptions): Preview {
  const { maxLines, maxBytes, direction, headRatio } = opts

  // A "middle" split needs at least one head line AND one tail line; with a
  // 1-line budget the two mandatory halves would keep 2 lines and exceed
  // maxLines. Degrade to tail-only (the verdict/summary line, per the
  // tail-weighted design) instead of overrunning the budget.
  if (direction === "tail" || (direction === "middle" && maxLines <= 1)) {
    const sel = selectFromTail(lines, maxLines, maxBytes, 0)
    // altimate_change start — a boundary line longer than the whole byte budget
    // selected NOTHING, so the tool result reached the model as a bare
    // truncation marker with zero content. Keep a byte-budgeted suffix of the
    // last line instead: some context always beats none.
    let tailLines = sel.lines
    let tailBytes = sel.bytes
    if (tailLines.length === 0 && lines.length > 0) {
      const partial = byteSuffix(lines[lines.length - 1]!, maxBytes)
      if (partial) {
        tailLines = [partial]
        tailBytes = Buffer.byteLength(partial, "utf-8")
      }
    }
    const removed = sel.hitBytes ? totalBytes - tailBytes : lines.length - tailLines.length
    return { head: "", tail: tailLines.join("\n"), removed, unit: sel.hitBytes ? "bytes" : "lines" }
    // altimate_change end
  }

  if (direction === "middle") {
    const headBudgetLines = Math.max(1, Math.floor(maxLines * headRatio))
    const tailBudgetLines = Math.max(1, maxLines - headBudgetLines)
    // altimate_change start — the two byte budgets must never SUM above
    // maxBytes. Forcing both halves to at least 1 overran the configured limit
    // for degenerate budgets; clamp the head share and let the tail share be 0.
    const headBudgetBytes = Math.min(maxBytes, Math.max(1, Math.floor(maxBytes * headRatio)))
    const tailBudgetBytes = Math.max(0, maxBytes - headBudgetBytes)
    // altimate_change end

    const headSel = selectFromHead(lines, headBudgetLines, headBudgetBytes)
    // altimate_change start — oversized-boundary fallback (head half). A first
    // line longer than the head byte share selected nothing; with the tail half
    // in the same position the whole preview came back empty. Keep a
    // byte-budgeted prefix of the first line.
    let headLines = headSel.lines
    let headBytes = headSel.bytes
    let headPartial = false
    if (headLines.length === 0 && lines.length > 0) {
      const partial = bytePrefix(lines[0]!, headBudgetBytes)
      if (partial) {
        headLines = [partial]
        headBytes = Buffer.byteLength(partial, "utf-8")
        headPartial = true
      }
    }
    // The tail walk stops at the boundary of what the head half already
    // claimed, so the two halves never overlap. A PARTIAL head consumed part of
    // line 0, so the tail may only reuse that same line when it is the only one.
    const notBefore = headPartial ? (lines.length > 1 ? 1 : 0) : headLines.length
    const tailSel = selectFromTail(lines, tailBudgetLines, tailBudgetBytes, notBefore)
    // Oversized-boundary fallback (tail half), same rationale as the head.
    let tailLines = tailSel.lines
    let tailBytes = tailSel.bytes
    if (tailLines.length === 0 && lines.length - 1 >= notBefore && tailBudgetBytes > 0) {
      const last = lines[lines.length - 1]!
      // When head and tail share the one line, the suffix must not re-emit the
      // bytes the head prefix already showed.
      const available =
        headPartial && lines.length === 1 ? Math.min(tailBudgetBytes, Buffer.byteLength(last, "utf-8") - headBytes) : tailBudgetBytes
      const partial = byteSuffix(last, available)
      if (partial) {
        tailLines = [partial]
        tailBytes = Buffer.byteLength(partial, "utf-8")
      }
    }
    // altimate_change end

    const keptLines = headLines.length + tailLines.length
    const keptBytes = headBytes + tailBytes
    const linesRemoved = Math.max(0, lines.length - keptLines)
    const bytesRemoved = Math.max(0, totalBytes - keptBytes)
    const hitBytes = headSel.hitBytes || tailSel.hitBytes

    return {
      head: headLines.join("\n"),
      tail: tailLines.join("\n"),
      removed: hitBytes ? bytesRemoved : linesRemoved,
      unit: hitBytes ? "bytes" : "lines",
    }
  }

  // direction === "head"
  const sel = selectFromHead(lines, maxLines, maxBytes)
  // altimate_change start — oversized-boundary fallback, same rationale as the
  // tail-only path above.
  let headLines = sel.lines
  let headBytes = sel.bytes
  if (headLines.length === 0 && lines.length > 0) {
    const partial = bytePrefix(lines[0]!, maxBytes)
    if (partial) {
      headLines = [partial]
      headBytes = Buffer.byteLength(partial, "utf-8")
    }
  }
  const removed = sel.hitBytes ? totalBytes - headBytes : lines.length - headLines.length
  return { head: headLines.join("\n"), tail: "", removed, unit: sel.hitBytes ? "bytes" : "lines" }
  // altimate_change end
}

/** Assembles the final tool-output content from a preview, the retrieval hint, and direction. */
export function assemble(p: Preview, hint: string, direction: Direction): string {
  const marker = `...${p.removed} ${p.unit} truncated...`
  if (direction === "tail") return `${marker}\n\n${hint}\n\n${p.tail}`
  // altimate_change start — a "middle" preview that degraded to tail-only has an
  // empty head; formatting it as middle prefixed the output with a stray blank
  // line before the marker. Fall through to the tail layout instead.
  if (direction === "middle" && !p.head) return `${marker}\n\n${hint}\n\n${p.tail}`
  // altimate_change end
  if (direction === "middle") return `${p.head}\n\n${marker}\n\n${hint}\n\n${p.tail}`
  return `${p.head}\n\n${marker}\n\n${hint}`
}

export * as TruncateCore from "./truncate-core"
