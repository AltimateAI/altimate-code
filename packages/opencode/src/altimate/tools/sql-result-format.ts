import type { SqlExecuteResult } from "../native/types"

export const SQL_MAX_PREVIEW_ROWS = 50
export const SQL_MAX_PREVIEW_COLUMNS = 60
export const SQL_MAX_PREVIEW_BYTES = 16 * 1024
export const SQL_MAX_SPILL_BYTES = 32 * 1024 * 1024

interface FormatOptions {
  mcpClient?: boolean
  limit: number
  maxBytes?: number
  maxLines?: number
  fullTextColumns?: string[] | null
  notes?: string[]
  /** The executed statement; enables the empty-result hint. */
  sql?: string
  write: (text: string) => Promise<string>
  /** MCP: called when the result spills; stores every returned row as a scratch table and returns its name. */
  store?: () => Promise<string | undefined>
}

/** MCP spills show a short preview; the full rows are queryable in scratch. */
const MCP_SPILL_PREVIEW_ROWS = 10
const MCP_SPILL_CELL_BYTES = 160

function lineCount(text: string): number {
  let lines = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++
  return lines
}

function clipText(text: string, maxBytes: number, maxLines: number, marker: string): string | undefined {
  if (Buffer.byteLength(text, "utf8") <= maxBytes && lineCount(text) <= maxLines) return text
  let bytes = Buffer.byteLength(marker, "utf8")
  if (bytes > maxBytes || maxLines < 1) return
  let end = 0
  let lines = 1
  // Walk code points, so a clipped prefix never splits a UTF-8 sequence or surrogate pair.
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8")
    if (bytes + size > maxBytes || (char === "\n" && lines >= maxLines)) break
    bytes += size
    if (char === "\n") lines++
    end += char.length
  }
  return text.slice(0, end) + marker
}

function clipCell(text: string, maxBytes: number, maxLines: number): string | undefined {
  if (Buffer.byteLength(text, "utf8") <= maxBytes && lineCount(text) <= maxLines) return text
  let chars = 0
  for (const _ of text) chars++
  return clipText(text, maxBytes, maxLines, `…[cell clipped, ${chars} chars]`)
}

function previewSchema(columns: string[], maxBytes: number, maxLines: number, priority?: Set<string>) {
  const order = columns.map((_, index) => index)
  if (priority) order.sort((a, b) => Number(priority.has(columns[b]!)) - Number(priority.has(columns[a]!)))
  const render = (name: string) => (/[\n\r]| \| /.test(name) ? JSON.stringify(name) : name)
  for (let count = Math.min(columns.length, SQL_MAX_PREVIEW_COLUMNS); count > 0; count--) {
    const omitted = count < columns.length ? `(+${columns.length - count} more columns, see spill)\n` : ""
    // Both the aliases and their separator consume space, along with delimiters/newlines.
    const available = maxBytes - Buffer.byteLength(omitted, "utf8") - 2 - (count - 1) * 6
    const aliasBytes = Math.min(128, Math.floor(available / (2 * count)))
    if (aliasBytes < 4) continue
    // Retain named columns even beyond the ordinary prefix, without relaxing the
    // column or alias caps. Display the chosen columns in their original order.
    const indices = order.slice(0, count).sort((a, b) => a - b)
    const rendered = indices.map((index) => render(columns[index]!))
    const aliases = rendered.map((name) => clipText(name, aliasBytes, 1, "…[alias clipped]"))
    if (aliases.some((name) => name === undefined)) continue
    const names = aliases as string[]
    const text =
      names.join(" | ") + "\n" + names.map((name) => "-".repeat(Math.max(name.length, 4))).join("-+-") + "\n" + omitted
    if (Buffer.byteLength(text, "utf8") > maxBytes || lineCount(text) > maxLines) continue
    return {
      text,
      indices,
      columns: count,
      clipped: count < columns.length || names.some((name, i) => name !== rendered[i]),
    }
  }
  return { text: "", indices: [], columns: 0, clipped: columns.length > 0 }
}

function displayObject(value: object, ancestors: Set<unknown>): { text: string; clipped: boolean } {
  let clipped = false
  const path: object[] = []
  let json: string
  try {
    json =
      JSON.stringify(value, function (_key, item: unknown) {
        if (item && typeof item === "object") {
          // JSON visits siblings after their children; retain only the current path.
          while (path.length && path[path.length - 1] !== this) ancestors.delete(path.pop())
          if (ancestors.has(item) || ancestors.size >= 100) {
            clipped = true
            return "…[nested cell clipped]"
          }
          ancestors.add(item)
          path.push(item)
        }
        return typeof item === "bigint" ? item.toString() : item
      }) ?? "undefined"
  } catch {
    // A throwing toJSON or getter must not abort the whole preview.
    json = "…[cell not serializable]"
    clipped = true
  } finally {
    for (const item of path) ancestors.delete(item)
  }
  const text = clipCell(json, SQL_MAX_PREVIEW_BYTES, Infinity)!
  return { text, clipped: clipped || text !== json }
}

function displayCell(value: unknown, ancestors = new Set<unknown>()): { text: string; clipped: boolean } {
  // Only encode a bounded binary prefix before the preview applies its byte cap.
  if (value instanceof Uint8Array) {
    const clipped = value.byteLength > SQL_MAX_PREVIEW_BYTES
    const text = "base64:" + Buffer.from(value.subarray(0, SQL_MAX_PREVIEW_BYTES)).toString("base64")
    return { text: clipped ? text + `…[cell clipped, ${value.byteLength} bytes]` : text, clipped }
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return { text: "", clipped: false } // Array.toString omits cycles.
    if (ancestors.size >= 100) return { text: "…[nested cell clipped]", clipped: true }
    // An empty array is rendered explicitly so it differs from an empty string.
    if (value.length === 0) return { text: "[]", clipped: false }
    ancestors.add(value)
    let text = ""
    let bytes = 0
    for (let i = 0; i < value.length; i++) {
      // A null element keeps a marker; with quoted empty strings and `[]`, `[NULL]`, `['']` and `[[]]` stay distinct.
      const item = value[i] == null ? { text: "NULL", clipped: false } : displayCell(value[i], ancestors)
      const delimiter = i ? "," : ""
      const size = Buffer.byteLength(item.text, "utf8") + delimiter.length
      if (item.clipped || bytes + size > SQL_MAX_PREVIEW_BYTES) {
        const marker = `…[array clipped, ${value.length} items]`
        const prefix =
          clipCell(item.text, SQL_MAX_PREVIEW_BYTES - bytes - delimiter.length - Buffer.byteLength(marker), Infinity) ??
          ""
        ancestors.delete(value)
        return { text: text + delimiter + prefix + marker, clipped: true }
      }
      text += delimiter + item.text
      bytes += size
    }
    ancestors.delete(value)
    return { text, clipped: false }
  }
  if (typeof value === "string") {
    const quote =
      value === "NULL" ||
      value === "[]" ||
      /[\n\r]| \| /.test(value) ||
      (ancestors.size > 0 && (value === "" || value.includes(",")))
    return { text: quote ? JSON.stringify(value) : value, clipped: false }
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value)
    if (prototype === Object.prototype || prototype === null) return displayObject(value, ancestors)
  }
  // Date's default string form drops milliseconds and the zone; ISO 8601 is lossless and matches the spill's `$date`.
  if (value instanceof Date) return { text: Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString(), clipped: false }
  return { text: value === null ? "NULL" : String(value), clipped: false }
}

function previewRows(
  rows: unknown[][],
  maxBytes: number,
  maxLines: number,
  columns: number,
  maxRows = SQL_MAX_PREVIEW_ROWS,
  cellCap?: number,
) {
  if (!columns) return { body: "", rows: 0, clipped: rows.length > 0 }
  const shown: string[] = []
  let bytes = 0
  let lines = 0
  let clipped = false
  for (const row of rows.slice(0, maxRows)) {
    const values = row.slice(0, columns).map((v) => {
      const cell = displayCell(v)
      const text = cellCap === undefined ? cell.text : clipCell(cell.text, cellCap, 1)!
      clipped ||= cell.clipped || text !== cell.text
      return text
    })
    const remainingBytes = maxBytes - bytes - (shown.length ? 1 : 0)
    const remainingLines = maxLines - lines
    const rowBytes =
      values.reduce((sum, v) => sum + Buffer.byteLength(v, "utf8"), 0) + Math.max(0, values.length - 1) * 3
    const rowLines = values.reduce((sum, v) => sum + lineCount(v) - 1, 1)
    if (rowBytes <= remainingBytes && rowLines <= remainingLines) {
      shown.push(values.join(" | "))
      bytes += rowBytes + (shown.length > 1 ? 1 : 0)
      lines += rowLines
      continue
    }

    // Preserve the first rows, with a visible partial cell when a row itself is oversized.
    const cells: string[] = []
    let cellBytes = remainingBytes - Math.max(0, values.length - 1) * 3
    let cellLines = remainingLines
    for (const value of values) {
      const cell = clipCell(value, Math.floor(cellBytes / (values.length - cells.length)), cellLines)
      if (cell === undefined) break
      cells.push(cell)
      cellBytes -= Buffer.byteLength(cell, "utf8")
      cellLines -= lineCount(cell) - 1
    }
    if (cells.length === values.length && remainingLines > 0) shown.push(cells.join(" | "))
    clipped = true
    break
  }
  return { body: shown.join("\n"), rows: shown.length, clipped: clipped || shown.length < rows.length }
}

const CONTINUED_CELL = "…[continued in spill]"
const OMITTED_CELLS = "…[remaining cells omitted; see spill]"

function namedCell(value: unknown, maxBytes: number, maxLines: number): { text?: string; clipped: boolean } {
  // Strings and NULL use table rendering; structured/binary values use the spill's tagged JSON.
  if (typeof value === "string" || value === null) {
    const rendered = displayCell(value).text
    const text = clipText(rendered, maxBytes, maxLines, CONTINUED_CELL)
    return { text, clipped: text !== rendered }
  }
  let text = ""
  let bytes = 0
  let lines = 1
  try {
    for (const chunk of spillValue(value)) {
      const prefix = clipText(chunk, maxBytes - bytes, maxLines - lines + 1, "") ?? ""
      text += prefix
      bytes += Buffer.byteLength(prefix, "utf8")
      lines += lineCount(prefix) - 1
      if (prefix !== chunk) {
        const head = clipText(text, maxBytes - Buffer.byteLength(CONTINUED_CELL), maxLines, "")
        return { text: head === undefined ? undefined : head + CONTINUED_CELL, clipped: true }
      }
    }
    return { text, clipped: false }
  } catch {
    // Cyclic/deep values also fail the spill preflight; the banner reports that failure.
    return { text: clipText("…[cell unavailable; see spill status]", maxBytes, maxLines, ""), clipped: true }
  }
}

function fullTextRows(
  rows: unknown[][],
  names: string[],
  selected: Set<string>,
  maxBytes: number,
  maxLines: number,
  reserveNote = false,
): { body: string; rows: number; clipped: boolean } {
  if (!names.length || !rows.length) return { body: "", rows: 0, clipped: rows.length > 0 }
  // Named cells spend the shared allowance first, in row order. If cells must be
  // omitted, retry with space reserved for one trailing note. Each pass is bounded.
  const noteBytes = reserveNote ? Buffer.byteLength(OMITTED_CELLS) + 1 : 0
  const noteLines = reserveNote ? 1 : 0
  let count = rows.length
  while (count && ((names.length - 1) * 3 * count + count - 1 + noteBytes > maxBytes || count + noteLines > maxLines))
    count--
  if (!count) return { body: clipText(OMITTED_CELLS, maxBytes, maxLines, "") ?? "", rows: 0, clipped: true }
  let bytes = maxBytes - (names.length - 1) * 3 * count - (count - 1) - noteBytes
  let lines = maxLines - count + 1 - noteLines
  const cells: (string | undefined)[][] = Array.from({ length: count }, () => Array(names.length))
  const named = names.map((name, index) => (selected.has(name) ? index : -1)).filter((index) => index >= 0)
  const ordinary = names.map((name, index) => (!selected.has(name) ? index : -1)).filter((index) => index >= 0)
  let clipped = count < rows.length
  let omitted = count < rows.length
  for (const indices of [named, ordinary]) {
    let remaining = count * indices.length
    for (let row = 0; row < count; row++) {
      for (const column of indices) {
        if (bytes <= 0 || lines <= 0) {
          omitted = clipped = true
          continue
        }
        const priority = selected.has(names[column]!)
        const value = rows[row]![column]
        const cell = priority ? namedCell(value, bytes, lines) : displayCell(value)
        const text = priority ? cell.text : clipCell(cell.text!, Math.floor(bytes / remaining), lines)
        remaining--
        clipped ||= cell.clipped || text !== cell.text
        if (text === undefined) {
          omitted = clipped = true
          continue
        }
        cells[row]![column] = text
        bytes -= Buffer.byteLength(text, "utf8")
        lines -= lineCount(text) - 1
        // A clipped named cell consumes the remaining allowance; do not emit a
        // continuation marker for every later cell when only a few bytes remain.
        if (priority && cell.clipped) bytes = 0
      }
    }
  }
  if (omitted && !reserveNote) return fullTextRows(rows, names, selected, maxBytes, maxLines, true)
  const shown = cells.flatMap((row) => {
    const last = row.findLastIndex((cell) => cell !== undefined)
    return last < 0
      ? []
      : [
          row
            .slice(0, last + 1)
            .map((cell) => cell ?? "")
            .join(" | "),
        ]
  })
  return {
    body: shown.join("\n") + (omitted ? (shown.length ? "\n" : "") + OMITTED_CELLS : ""),
    rows: shown.length,
    clipped,
  }
}

// Preflight before encoding/stringifying, bounding nested values and binary expansion
// without materializing them. The binary estimate is deliberately conservative.
function checkSpillSize(value: unknown, budget: { left: number }, ancestors = new Set<object>()) {
  if (typeof value === "string") budget.left -= Buffer.byteLength(value, "utf8") + 2
  else if (typeof value === "bigint") budget.left -= value.toString().length + 2
  else if (value instanceof Uint8Array) budget.left -= value.byteLength * 4 + 32
  else if (value && typeof value === "object") {
    if (ancestors.has(value) || ancestors.size >= 100) throw new Error("SQL result is cyclic or too deeply nested")
    ancestors.add(value)
    budget.left -= 2
    if (Array.isArray(value)) {
      for (const item of value) {
        budget.left--
        checkSpillSize(item, budget, ancestors)
      }
    } else {
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue
        budget.left -= Buffer.byteLength(key, "utf8") + 4
        checkSpillSize((value as Record<string, unknown>)[key], budget, ancestors)
      }
    }
    ancestors.delete(value)
  } else budget.left -= 8
  if (budget.left < 0) throw new Error("result exceeds the SQL spill size limit")
}

/** Tagged JSON chunks are shared by the spill and bounded named-cell previews. */
function* spillValue(value: unknown, ancestors = new Set<object>()): Generator<string> {
  if (typeof value === "bigint") return yield* spillValue({ $bigint: value.toString() }, ancestors)
  if (value instanceof Date) return yield* spillValue({ $date: value.toISOString() }, ancestors)
  if (value instanceof Uint8Array) {
    yield '{"$bytes":"'
    // Multiples of three preserve base64 grouping without copying the entire BLOB.
    for (let start = 0; start < value.byteLength; start += 768) {
      yield Buffer.from(value.buffer, value.byteOffset + start, Math.min(768, value.byteLength - start)).toString(
        "base64",
      )
    }
    yield '"}'
    return
  }
  if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))) {
    return yield* spillValue({ $sql_type: "number", value: Object.is(value, -0) ? "-0" : String(value) }, ancestors)
  }
  if (value === undefined) return yield* spillValue({ $sql_type: "undefined" }, ancestors)
  if (typeof value === "string") {
    yield '"'
    for (let start = 0; start < value.length; ) {
      let end = Math.min(start + 1024, value.length)
      const last = value.charCodeAt(end - 1)
      if (end < value.length && last >= 0xd800 && last <= 0xdbff) end--
      yield JSON.stringify(value.slice(start, end)).slice(1, -1)
      start = end
    }
    yield '"'
    return
  }
  if (value && typeof value === "object") {
    if (ancestors.has(value) || ancestors.size >= 100) throw new Error("SQL result is cyclic or too deeply nested")
    ancestors.add(value)
    if (Array.isArray(value)) {
      yield "["
      for (let i = 0; i < value.length; i++) {
        if (i) yield ","
        yield* spillValue(value[i], ancestors)
      }
      yield "]"
    } else {
      yield "{"
      let first = true
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue
        if (!first) yield ","
        first = false
        yield* spillValue(key, ancestors)
        yield ":"
        yield* spillValue((value as Record<string, unknown>)[key], ancestors)
      }
      yield "}"
    }
    ancestors.delete(value)
    return
  }
  yield JSON.stringify(value) ?? "null"
}

/** Ordered columns/values retain duplicate aliases; tags preserve special values. */
export function serializeRows(result: SqlExecuteResult, emit: (chunk: string) => void): void {
  let bytes = 0
  for (const values of result.rows) {
    const row = {
      columns: result.columns,
      values: result.columns.map((_, index) => (index in values ? values[index] : null)),
    }
    checkSpillSize(row, { left: SQL_MAX_SPILL_BYTES - bytes })
    let text = ""
    for (const chunk of spillValue(row)) {
      bytes += Buffer.byteLength(chunk, "utf8")
      if (bytes + 1 > SQL_MAX_SPILL_BYTES) throw new Error("result exceeds the SQL spill size limit")
      text += chunk
    }
    bytes++
    // Retain one bounded string per row instead of a reference per JSON token.
    emit(text + "\n")
  }
}

const EMPTY_RESULT_HINT =
  "Hint: 0 rows. If a literal filter was used, verify the stored values first, e.g. SELECT DISTINCT <col> FROM <table> LIMIT 50 or a LIKE '%…%' probe — stored formats often differ (case, whitespace, prefixes)."

// A string literal compared with `=` or listed in `IN (...)`. Conservative on purpose:
// anything not matching gets no hint.
const LITERAL_EQUALS = /(?:^|[^<>!=])=\s*'(?:[^']|'')+'/
const LITERAL_IN = /\bIN\s*\(\s*'(?:[^']|'')*'/i

/** Mask comments so a quoted literal inside one is not mistaken for a filter. */
function hasStringLiteralFilter(sql: string): boolean {
  const code = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ")
  if (!/^\s*(?:WITH|SELECT|\()/i.test(code) || !/\bWHERE\b/i.test(code)) return false
  return LITERAL_EQUALS.test(code) || LITERAL_IN.test(code)
}

function emptyResultHint(result: SqlExecuteResult, sql: string | undefined): string {
  if (!sql || result.truncated || result.rows.length > 2) return ""
  if (!hasStringLiteralFilter(sql) || isScalar(result)) return ""
  return result.rows.length === 0
    ? EMPTY_RESULT_HINT
    : EMPTY_RESULT_HINT.replace("Hint: 0 rows.", `Hint: only ${result.rows.length} row(s).`)
}

/** A single numeric cell (e.g. COUNT(*)) is an answer in its own right; leave it untouched. */
function isScalar(result: SqlExecuteResult): boolean {
  return result.rows.length === 1 && result.columns.length === 1 && typeof result.rows[0]?.[0] !== "string"
}

export async function formatSqlResult(result: SqlExecuteResult, options: FormatOptions) {
  const fullTextColumns = new Set(options.fullTextColumns ?? [])
  const fullText = fullTextColumns.size > 0
  const limit = fullText ? Math.min(options.limit, 20) : options.limit
  const rows = result.rows.slice(0, limit)
  const excess = result.rows.length > limit
  const missing = [...fullTextColumns].filter((column) => !result.columns.includes(column))
  const notes = [...(options.notes ?? [])]
  if (missing.length) {
    notes.push(
      `Note: Unknown full_text_columns: ${missing.join(", ")}. Available columns: ${result.columns.join(", ") || "(none)"}.`.replace(
        /[\r\n]/g,
        " ",
      ),
    )
  }
  const maxBytes = Math.max(0, Math.min(SQL_MAX_PREVIEW_BYTES, options.maxBytes ?? SQL_MAX_PREVIEW_BYTES))
  const maxLines = Math.max(0, options.maxLines ?? 2000)
  const fits = (text: string) => Buffer.byteLength(text, "utf8") <= maxBytes && lineCount(text) <= maxLines
  const note = notes.length ? "\n\n" + notes.join("\n\n") : ""
  const footer = result.rows.length ? `\n\n(${result.row_count} rows)` : "(0 rows)"
  const metadata = {
    rowCount: result.row_count,
    rows_returned: result.rows.length,
    preview_rows: 0,
    preview_columns: 0,
    schema_truncated: false,
    row_limited: result.truncated || excess,
    output_truncated: false,
    result_path: undefined as string | undefined,
    scratch_table: undefined as string | undefined,
    // This tool owns clipping; the generic truncator must not clip away the envelope.
    truncated: false,
  }
  const bounded = (text: string) => {
    if (fits(text)) return text
    metadata.output_truncated = metadata.truncated = true
    return clipText(text, maxBytes, maxLines, "…[output clipped]") ?? ""
  }
  const hint = emptyResultHint(result, options.sql)
  const withHint = (text: string) => (hint && fits(text + "\n\n" + hint) ? text + "\n\n" + hint : text)
  if (!fullText && result.rows.length === 0 && !result.truncated) {
    return { output: bounded(withHint(footer + note)), metadata }
  }

  const rowsFor = (bytes: number, lines: number, indices: number[], maxRows?: number, cellBytes?: number) =>
    fullText
      ? fullTextRows(
          rows.map((row) => indices.map((index) => (index in row ? row[index] : null))),
          indices.map((index) => result.columns[index]!),
          fullTextColumns,
          bytes,
          lines,
        )
      : previewRows(rows, bytes, lines, indices.length, maxRows, cellBytes)
  // Ordinary, complete results retain their compact presentation. Full-text mode
  // always takes the spill path, even for empty results or unknown selected names.
  if (!fullText) {
    const schema = previewSchema(
      result.columns,
      maxBytes - Buffer.byteLength(footer + note),
      maxLines - lineCount(footer + note) + 1,
    )
    const preview = rowsFor(
      Math.max(0, maxBytes - Buffer.byteLength(schema.text + footer + note)),
      Math.max(0, maxLines - lineCount(schema.text + footer + note) + 1),
      schema.indices,
    )
    if (
      !preview.clipped &&
      !schema.clipped &&
      !metadata.row_limited &&
      fits(schema.text + preview.body + footer + note)
    ) {
      metadata.preview_rows = preview.rows
      metadata.preview_columns = schema.columns
      return { output: withHint(schema.text + preview.body + footer + note), metadata }
    }
  }

  let spill: string
  // MCP: a short preview, with every returned row queryable as a scratch table instead of a file to read.
  const mcp = options.mcpClient === true
  const previewLimit = mcp && !fullText ? MCP_SPILL_PREVIEW_ROWS : SQL_MAX_PREVIEW_ROWS
  try {
    const chunks: string[] = []
    serializeRows(result, (chunk) => chunks.push(chunk))
    metadata.result_path = await options.write(chunks.join(""))
    const table = mcp && result.rows.length ? await options.store?.().catch(() => undefined) : undefined
    metadata.scratch_table = table
    const reader = mcp
      ? "Open this path with any file reader to recover clipped text."
      : "Use read with char_offset/max_chars to recover any clipped text."
    spill = table
      ? `All ${result.rows.length} returned rows are in scratch table ${table}: query it with sql_execute(warehouse: "scratch", query: "SELECT ... FROM ${table}") instead of reading the file. File copy: ${metadata.result_path}.`
      : `All ${result.rows.length} returned rows saved to ${metadata.result_path}. JSONL text: columns/values per row; $bigint, $date (ISO), $bytes (base64) tags; strings unchanged. ${reader}`
  } catch {
    spill = `Spill failed (write/serialization error or ${SQL_MAX_SPILL_BYTES / 1024 / 1024} MiB size limit); returned rows were not saved.`
  }
  const envelope = (shown: number, clipped: boolean) =>
    mcp
      ? `Preview: ${shown} of ${result.rows.length} returned rows. ` +
        (excess
          ? `The connector returned more rows than the limit (${limit}). `
          : result.truncated
            ? "Row limit reached; more rows may exist. "
            : "") +
        `${spill}\n`
      : `Preview: ${shown} of ${result.rows.length} returned rows shown. ` +
        (excess
          ? `Note: connector returned ${result.rows.length} rows; showing at most ${limit} (requested row limit). `
          : result.truncated
            ? "Result may be row-limited (connector reported a limit; total unknown). More rows may exist. "
            : "Row-limited: no. ") +
        `Output truncated: ${clipped ? "yes" : "no"}. ${spill}` +
        (clipped && !fullText ? " Prioritize specific cells with full_text_columns; omit limit to use the default." : "") +
        "\n"

  // Notes share the output budget, including missing names and tool annotations.
  // Keep room for the result contract even when a note is much larger than the cap.
  const shownNote =
    clipText(note, Math.floor(maxBytes / 4), Math.max(1, Math.floor(maxLines / 4)), "…[note clipped]") ?? ""
  const notesClipped = shownNote !== note
  const essentials = envelope(Math.min(rows.length, previewLimit), true) + footer + shownNote
  if (!fits(essentials)) {
    metadata.schema_truncated = result.columns.length > 0
    metadata.output_truncated = metadata.truncated = true
    return { output: bounded(envelope(0, true) + footer + shownNote), metadata }
  }
  const schema = rows.length
    ? previewSchema(
        result.columns,
        maxBytes - Buffer.byteLength(essentials),
        maxLines - lineCount(essentials) + 1,
        fullText ? fullTextColumns : undefined,
      )
    : { text: "", indices: [], columns: 0, clipped: false }
  const reserved = envelope(Math.min(rows.length, previewLimit), true) + schema.text + footer + shownNote
  const preview = rowsFor(
    Math.max(0, maxBytes - Buffer.byteLength(reserved)),
    Math.max(0, maxLines - lineCount(reserved) + 1),
    schema.indices,
    previewLimit,
    mcp ? MCP_SPILL_CELL_BYTES : undefined,
  )
  metadata.preview_rows = preview.rows
  metadata.preview_columns = schema.columns
  metadata.schema_truncated = schema.clipped
  // Clipped aliases use schema_truncated; omitted columns also hide cell values.
  metadata.output_truncated =
    preview.clipped || (rows.length > 0 && schema.columns < result.columns.length) || notesClipped || excess
  metadata.truncated = metadata.row_limited || metadata.output_truncated
  return {
    output: bounded(
      withHint(envelope(preview.rows, metadata.output_truncated) + schema.text + preview.body + footer + shownNote),
    ),
    metadata,
  }
}
