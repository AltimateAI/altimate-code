import type { SqlExecuteResult } from "../native/types"

export const SQL_MAX_PREVIEW_ROWS = 50
export const SQL_MAX_PREVIEW_COLUMNS = 60
export const SQL_MAX_PREVIEW_BYTES = 16 * 1024
export const SQL_MAX_SPILL_BYTES = 32 * 1024 * 1024

interface FormatOptions {
  limit: number
  maxBytes?: number
  maxLines?: number
  /** The executed statement; enables the empty-result hint. */
  sql?: string
  write: (text: string) => Promise<string>
}

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

function previewSchema(columns: string[], maxBytes: number, maxLines: number) {
  for (let count = Math.min(columns.length, SQL_MAX_PREVIEW_COLUMNS); count > 0; count--) {
    const omitted = count < columns.length ? `(+${columns.length - count} more columns, see spill)\n` : ""
    // Both the aliases and their separator consume space, along with delimiters/newlines.
    const available = maxBytes - Buffer.byteLength(omitted, "utf8") - 2 - (count - 1) * 6
    const aliasBytes = Math.min(128, Math.floor(available / (2 * count)))
    if (aliasBytes < 4) continue
    const aliases = columns.slice(0, count).map((name) => clipText(name, aliasBytes, 1, "…[alias clipped]"))
    if (aliases.some((name) => name === undefined)) continue
    const names = aliases as string[]
    const text =
      names.join(" | ") + "\n" + names.map((name) => "-".repeat(Math.max(name.length, 4))).join("-+-") + "\n" + omitted
    if (Buffer.byteLength(text, "utf8") > maxBytes || lineCount(text) > maxLines) continue
    return { text, columns: count, clipped: count < columns.length || names.some((name, i) => name !== columns[i]) }
  }
  return { text: "", columns: 0, clipped: columns.length > 0 }
}

function displayCell(value: unknown, ancestors = new Set<unknown>()): { text: string; clipped: boolean } {
  // Avoid allocating a full comma-separated array or decoded BLOB just to clip it.
  if (value instanceof Uint8Array && value.byteLength > SQL_MAX_PREVIEW_BYTES) {
    const prefix = Buffer.isBuffer(value)
      ? new TextDecoder().decode(value.subarray(0, SQL_MAX_PREVIEW_BYTES), { stream: true })
      : String(value.subarray(0, SQL_MAX_PREVIEW_BYTES / 4))
    return { text: prefix + `…[cell clipped, ${value.byteLength} bytes]`, clipped: true }
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return { text: "", clipped: false } // Array.toString omits cycles.
    if (ancestors.size >= 100) return { text: "…[nested cell clipped]", clipped: true }
    ancestors.add(value)
    let text = ""
    let bytes = 0
    for (let i = 0; i < value.length; i++) {
      const item = value[i] == null ? { text: "", clipped: false } : displayCell(value[i], ancestors)
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
  return { text: value === null ? "NULL" : String(value), clipped: false }
}

function previewRows(rows: unknown[][], maxBytes: number, maxLines: number, columns: number) {
  if (!columns) return { body: "", rows: 0, clipped: rows.length > 0 }
  const shown: string[] = []
  let bytes = 0
  let lines = 0
  let clipped = false
  for (const row of rows.slice(0, SQL_MAX_PREVIEW_ROWS)) {
    const values = row.slice(0, columns).map((v) => {
      const cell = displayCell(v)
      clipped ||= cell.clipped
      return cell.text
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

function spillValue(value: unknown): unknown {
  if (typeof value === "bigint") return { $bigint: value.toString() }
  if (value instanceof Date) return { $date: value.toISOString() }
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString("base64") }
  if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))) {
    return { $sql_type: "number", value: Object.is(value, -0) ? "-0" : String(value) }
  }
  if (value === undefined) return { $sql_type: "undefined" }
  if (Array.isArray(value)) return value.map(spillValue)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, spillValue(item)]))
  }
  return value
}

/**
 * Lossy JSONL text artifact, not a typed round-trip format: ordered columns/values
 * preserve duplicate aliases, and special values use readable tags. Literal objects
 * may resemble those tags; plain strings remain strings. No decoder is implied.
 */
function serializeRows(result: SqlExecuteResult): string {
  const lines: string[] = []
  let bytes = 0
  for (const values of result.rows) {
    // The service accepts one string. Bound the accumulated artifact and each row before
    // encoding/JSON.stringify can allocate an arbitrarily large value. Its worst-case
    // escaping expansion is six times this bounded raw size, never the entire result.
    const row = { columns: result.columns, values }
    checkSpillSize(row, { left: SQL_MAX_SPILL_BYTES - bytes })
    let rawSize = 0
    const line = JSON.stringify(spillValue(row), (key, value) => {
      rawSize += key.length + (typeof value === "string" ? value.length : 8)
      if (rawSize > SQL_MAX_SPILL_BYTES - bytes) throw new Error("result exceeds the SQL spill size limit")
      return value
    })
    bytes += Buffer.byteLength(line, "utf8") + 1
    if (bytes > SQL_MAX_SPILL_BYTES) throw new Error("result exceeds the SQL spill size limit")
    lines.push(line + "\n")
  }
  return lines.join("")
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
  const maxBytes = Math.max(0, Math.min(SQL_MAX_PREVIEW_BYTES, options.maxBytes ?? SQL_MAX_PREVIEW_BYTES))
  const maxLines = Math.max(0, options.maxLines ?? 2000)
  const fits = (text: string) => Buffer.byteLength(text, "utf8") <= maxBytes && lineCount(text) <= maxLines
  const bounded = (text: string) => clipText(text, maxBytes, maxLines, "…[output clipped]") ?? ""
  const footer = `\n\n(${result.row_count} rows)`
  const metadata = {
    rowCount: result.row_count,
    rows_returned: result.rows.length,
    preview_rows: 0,
    preview_columns: 0,
    schema_truncated: false,
    row_limited: result.truncated,
    output_truncated: false,
    result_path: undefined as string | undefined,
    // This tool owns clipping; the generic truncator must not clip away the envelope.
    truncated: false,
  }
  const hint = emptyResultHint(result, options.sql)
  const withHint = (text: string) => (hint && fits(text + "\n\n" + hint) ? text + "\n\n" + hint : text)
  if (result.rows.length === 0 && !result.truncated) {
    metadata.output_truncated = metadata.truncated = !fits("(0 rows)")
    return { output: bounded(withHint("(0 rows)")), metadata }
  }

  let schema = previewSchema(
    result.columns,
    maxBytes - Buffer.byteLength(footer, "utf8"),
    maxLines - lineCount(footer) + 1,
  )
  let preview = previewRows(
    result.rows,
    Math.max(0, maxBytes - Buffer.byteLength(schema.text + footer, "utf8")),
    Math.max(0, maxLines - lineCount(schema.text + footer) + 1),
    schema.columns,
  )
  if (!preview.clipped && !schema.clipped && !result.truncated) {
    metadata.preview_rows = preview.rows
    metadata.preview_columns = schema.columns
    return { output: bounded(withHint(schema.text + preview.body + footer)), metadata }
  }

  let spill: string
  try {
    metadata.result_path = await options.write(serializeRows(result))
    spill = `All ${result.rows.length} returned rows saved to ${metadata.result_path}. Lossy JSONL text: columns/values per row; $bigint, $date (ISO), $bytes (base64) tags; strings unchanged.`
  } catch {
    spill = `Spill failed (write/serialization error or ${SQL_MAX_SPILL_BYTES / 1024 / 1024} MiB size limit); returned rows were not saved.`
  }
  const envelope = (rows: number, clipped: boolean) =>
    `Preview: ${rows} of ${result.rows.length} returned rows shown. ` +
    (result.truncated
      ? `Result may be row-limited (requested row limit ${options.limit}; total unknown). More rows may exist. `
      : "Row-limited: no. ") +
    `Output truncated: ${clipped ? "yes" : "no"}. ${spill}\n`

  // The entire output, including schema, envelope and path, shares the same cap.
  const essentials = envelope(SQL_MAX_PREVIEW_ROWS, true) + footer
  if (!fits(essentials)) {
    metadata.schema_truncated = result.columns.length > 0
    metadata.output_truncated = metadata.truncated = true
    return { output: bounded(envelope(0, true)), metadata }
  }
  schema = previewSchema(
    result.columns,
    maxBytes - Buffer.byteLength(essentials, "utf8"),
    maxLines - lineCount(essentials) + 1,
  )
  const reserved = envelope(SQL_MAX_PREVIEW_ROWS, true) + schema.text + footer
  preview = previewRows(
    result.rows,
    Math.max(0, maxBytes - Buffer.byteLength(reserved, "utf8")),
    Math.max(0, maxLines - lineCount(reserved) + 1),
    schema.columns,
  )
  metadata.preview_rows = preview.rows
  metadata.preview_columns = schema.columns
  metadata.schema_truncated = schema.clipped
  metadata.output_truncated = preview.clipped || schema.clipped
  metadata.truncated = result.truncated || metadata.output_truncated
  return {
    output: bounded(envelope(preview.rows, metadata.output_truncated) + schema.text + preview.body + footer),
    metadata,
  }
}
