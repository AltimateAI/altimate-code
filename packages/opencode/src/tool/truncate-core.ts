// Pure truncation-selection algorithm shared by `tool/truncate.ts` (the Effect
// Service every `Tool.define()` output is routed through via `tool.ts:wrap()` —
// this is what the bash tool actually uses in production) and
// `tool/truncation.ts` (the plain-async twin used directly by `bash.ts`'s
// description-text constants, `bootstrap.ts`'s cleanup scheduler, and
// `prompt.ts`'s MCP tool-output truncation). Both call this ONE algorithm so a
// future change to truncation behavior cannot silently apply on one call path
// and not the other, the way the pre-existing hand-duplicated implementations
// could.
export * as TruncateCore from "./truncate-core"

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

  if (direction === "tail") {
    const sel = selectFromTail(lines, maxLines, maxBytes, 0)
    const removed = sel.hitBytes ? totalBytes - sel.bytes : lines.length - sel.lines.length
    return { head: "", tail: sel.lines.join("\n"), removed, unit: sel.hitBytes ? "bytes" : "lines" }
  }

  if (direction === "middle") {
    // A non-finite or out-of-[0,1] headRatio would make one sub-budget larger
    // than the total maxBytes, letting the assembled preview exceed it. Clamp
    // finite values and fall back to the default for invalid ones.
    const safeHeadRatio = Number.isFinite(headRatio) ? Math.min(1, Math.max(0, headRatio)) : DEFAULT_HEAD_RATIO
    const headBudgetLines = Math.max(1, Math.floor(maxLines * safeHeadRatio))
    // Not `Math.max(1, ...)`: flooring the tail budget to 1 would let the
    // two halves together exceed maxLines (e.g. maxLines=1 -> head claims
    // the only line, but tail would still floor up to 1 and add a second).
    const tailBudgetLines = Math.max(0, maxLines - headBudgetLines)
    const headBudgetBytes = Math.max(1, Math.floor(maxBytes * safeHeadRatio))
    const tailBudgetBytes = Math.max(0, maxBytes - headBudgetBytes)

    const headSel = selectFromHead(lines, headBudgetLines, headBudgetBytes)
    // notBefore = headSel.lines.length: the tail walk stops at the boundary
    // of what the head half already claimed, so the two halves never overlap.
    const tailSel = selectFromTail(lines, tailBudgetLines, tailBudgetBytes, headSel.lines.length)

    // A boundary line bigger than its own head/tail share of the split budget
    // used to be dropped by BOTH halves even when it fits the overall maxBytes,
    // returning only the marker/hint with no content. Fall back to a plain head
    // selection against the full (undivided) budget so it survives.
    if (headSel.lines.length === 0 && tailSel.lines.length === 0 && lines.length > 0) {
      const fallback = selectFromHead(lines, maxLines, maxBytes)
      const removed = fallback.hitBytes ? totalBytes - fallback.bytes : lines.length - fallback.lines.length
      return {
        head: fallback.lines.join("\n"),
        tail: "",
        removed,
        unit: fallback.hitBytes ? "bytes" : "lines",
      }
    }

    const keptLines = headSel.lines.length + tailSel.lines.length
    const keptBytes = headSel.bytes + tailSel.bytes
    const linesRemoved = Math.max(0, lines.length - keptLines)
    const bytesRemoved = Math.max(0, totalBytes - keptBytes)
    const hitBytes = headSel.hitBytes || tailSel.hitBytes

    return {
      head: headSel.lines.join("\n"),
      tail: tailSel.lines.join("\n"),
      removed: hitBytes ? bytesRemoved : linesRemoved,
      unit: hitBytes ? "bytes" : "lines",
    }
  }

  // direction === "head"
  const sel = selectFromHead(lines, maxLines, maxBytes)
  const removed = sel.hitBytes ? totalBytes - sel.bytes : lines.length - sel.lines.length
  return { head: sel.lines.join("\n"), tail: "", removed, unit: sel.hitBytes ? "bytes" : "lines" }
}

/** Assembles the final tool-output content from a preview, the retrieval hint, and direction. */
export function assemble(p: Preview, hint: string, direction: Direction): string {
  const marker = `...${p.removed} ${p.unit} truncated...`
  if (direction === "tail") return `${marker}\n\n${hint}\n\n${p.tail}`
  if (direction === "middle") return `${p.head}\n\n${marker}\n\n${hint}\n\n${p.tail}`
  return `${p.head}\n\n${marker}\n\n${hint}`
}
