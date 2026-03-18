/**
 * Direct dbt CLI fallbacks for when the library's output parsing fails.
 *
 * Newer dbt versions (1.11+) may produce JSON log output that the
 * @altimateai/dbt-integration library cannot parse. These functions run dbt
 * commands directly and parse the output with more resilient logic.
 *
 * VERSION RESILIENCE STRATEGY
 * --------------------------
 * dbt's JSON log format has changed across versions (1.5 → 1.7 → 1.9 → 1.11).
 * Rather than hard-coding any single format, each function uses a 3-tier approach:
 *
 *  1. **Known fields** — try every field path we've seen across versions
 *  2. **Heuristic scan** — deep-walk the JSON tree looking for SQL-shaped values
 *  3. **Plain text fallback** — re-run without --output json and parse raw output
 *
 * This means a future dbt version that renames fields will still work as long as
 * the value itself looks like SQL (or a JSON array of row objects).
 */

import { execFile } from "child_process"

function run(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile("dbt", args, { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(err)
      else resolve({ stdout, stderr })
    })
  })
}

/**
 * Parse structured JSON log lines from dbt CLI output.
 * dbt emits one JSON object per line when --log-format json is used.
 */
function parseJsonLines(stdout: string): any[] {
  return stdout
    .trim()
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line.trim())
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

// ---------------------------------------------------------------------------
// Heuristic helpers — find SQL or row data anywhere in a JSON tree
// ---------------------------------------------------------------------------

/** Walk an object tree and return the first value matching a predicate. */
function deepFind(obj: any, predicate: (val: unknown, key: string) => boolean, maxDepth = 5): any {
  if (maxDepth <= 0 || obj == null || typeof obj !== "object") return undefined
  for (const [key, val] of Object.entries(obj)) {
    if (predicate(val, key)) return val
    const nested = deepFind(val, predicate, maxDepth - 1)
    if (nested !== undefined) return nested
  }
  return undefined
}

/** Heuristic: does this string look like compiled SQL? */
function looksLikeSql(val: unknown): boolean {
  if (typeof val !== "string" || val.length < 10) return false
  const upper = val.trim().toUpperCase()
  return (
    upper.startsWith("SELECT") ||
    upper.startsWith("WITH") ||
    upper.startsWith("INSERT") ||
    upper.startsWith("CREATE") ||
    upper.startsWith("MERGE")
  )
}

/** Heuristic: does this value look like row preview data (JSON array of objects)? */
function looksLikeRowData(val: unknown): val is Record<string, unknown>[] {
  if (Array.isArray(val) && val.length > 0 && typeof val[0] === "object" && val[0] !== null) return true
  if (typeof val !== "string") return false
  try {
    const parsed = JSON.parse(val)
    return Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === "object"
  } catch {
    return false
  }
}

/**
 * Parse a dbt ASCII table (the default non-JSON output from `dbt show`).
 *
 * Format:
 *   | col1 | col2 |
 *   | ---- | ---- |
 *   | val1 | val2 |
 */
function parseAsciiTable(text: string): { columnNames: string[]; data: Record<string, unknown>[] } | null {
  const lines = text.split("\n").filter((l) => l.trim().startsWith("|"))
  if (lines.length < 2) return null

  const parseLine = (line: string) =>
    line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim())

  const header = parseLine(lines[0]!)
  // Skip separator line (dashes)
  const dataLines = lines.slice(1).filter((l) => !l.includes("---"))
  const data = dataLines.map((line) => {
    const vals = parseLine(line)
    const row: Record<string, unknown> = {}
    header.forEach((col, i) => {
      row[col] = vals[i] ?? null
    })
    return row
  })

  return { columnNames: header, data }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute SQL via `dbt show` and return results in QueryExecutionResult shape.
 */
export async function execDbtShow(sql: string, limit?: number) {
  const args = ["show", "--inline", sql, "--output", "json", "--log-format", "json"]
  if (limit !== undefined) args.push("--limit", String(limit))

  let lines: any[]
  try {
    const { stdout } = await run(args)
    lines = parseJsonLines(stdout)
  } catch {
    lines = []
  }

  // --- Tier 1: known field paths ---
  const previewLine =
    lines.find((l) => l.data?.preview) ??
    lines.find((l) => l.data?.rows) ??
    lines.find((l) => l.result?.preview) ??
    lines.find((l) => l.result?.rows)

  const sqlLine =
    lines.find((l) => l.data?.sql) ??
    lines.find((l) => l.data?.compiled_sql) ??
    lines.find((l) => l.result?.sql)

  if (previewLine) {
    const preview =
      previewLine.data?.preview ??
      previewLine.data?.rows ??
      previewLine.result?.preview ??
      previewLine.result?.rows
    const rows: Record<string, unknown>[] = typeof preview === "string" ? JSON.parse(preview) : preview
    const columnNames = rows.length > 0 && rows[0] ? Object.keys(rows[0]) : []
    const compiledSql = sqlLine?.data?.sql ?? sqlLine?.data?.compiled_sql ?? sqlLine?.result?.sql ?? sql

    return { columnNames, columnTypes: columnNames.map(() => "string"), data: rows, rawSql: sql, compiledSql }
  }

  // --- Tier 2: heuristic deep scan ---
  for (const line of lines) {
    const found = deepFind(line, (val) => looksLikeRowData(val))
    if (found) {
      const rows: Record<string, unknown>[] = typeof found === "string" ? JSON.parse(found) : found
      const columnNames = rows.length > 0 && rows[0] ? Object.keys(rows[0]) : []
      const compiledSql = deepFind(line, (val) => looksLikeSql(val)) ?? sql
      return { columnNames, columnTypes: columnNames.map(() => "string"), data: rows, rawSql: sql, compiledSql }
    }
  }

  // --- Tier 3: plain text fallback (ASCII table) ---
  const plainArgs = ["show", "--inline", sql]
  if (limit !== undefined) plainArgs.push("--limit", String(limit))
  const { stdout: plainOut } = await run(plainArgs)
  const table = parseAsciiTable(plainOut)
  if (table) {
    return {
      columnNames: table.columnNames,
      columnTypes: table.columnNames.map(() => "string"),
      data: table.data,
      rawSql: sql,
      compiledSql: sql,
    }
  }

  throw new Error(
    "Could not parse dbt show output in any format (JSON, heuristic, or plain text). " +
      `Got ${lines.length} JSON lines. Plain text length: ${plainOut.length}.`,
  )
}

/**
 * Compile a model via `dbt compile --select <model>` and return compiled SQL.
 */
export async function execDbtCompile(model: string): Promise<{ sql: string }> {
  const args = ["compile", "--select", model, "--output", "json", "--log-format", "json"]

  let lines: any[]
  try {
    const { stdout } = await run(args)
    lines = parseJsonLines(stdout)
  } catch {
    lines = []
  }

  // --- Tier 1: known field paths ---
  const sql = findCompiledSql(lines)
  if (sql) return { sql }

  // --- Tier 2: heuristic deep scan ---
  for (const line of lines) {
    const found = deepFind(line, (val) => looksLikeSql(val))
    if (found) return { sql: found }
  }

  // --- Tier 3: plain text fallback ---
  const { stdout: plainOut } = await run(["compile", "--select", model])
  return { sql: plainOut.trim() }
}

/**
 * Compile an inline query via `dbt compile --inline <sql>`.
 */
export async function execDbtCompileInline(
  sql: string,
  _model?: string | null,
): Promise<{ sql: string }> {
  const args = ["compile", "--inline", sql, "--output", "json", "--log-format", "json"]

  let lines: any[]
  try {
    const { stdout } = await run(args)
    lines = parseJsonLines(stdout)
  } catch {
    lines = []
  }

  // --- Tier 1: known field paths ---
  const compiled = findCompiledSql(lines)
  if (compiled) return { sql: compiled }

  // --- Tier 2: heuristic deep scan ---
  for (const line of lines) {
    const found = deepFind(line, (val) => looksLikeSql(val))
    if (found) return { sql: found }
  }

  // --- Tier 3: plain text fallback ---
  const { stdout: plainOut } = await run(["compile", "--inline", sql])
  return { sql: plainOut.trim() }
}

/** Shared: extract compiled SQL from known dbt JSON output formats. */
function findCompiledSql(lines: any[]): string | null {
  const compiledLine =
    lines.find((l) => l.data?.compiled) ??
    lines.find((l) => l.data?.compiled_code) ??
    lines.find((l) => l.result?.node?.compiled_code) ??
    lines.find((l) => l.result?.compiled_code) ??
    lines.find((l) => l.data?.compiled_sql)

  if (!compiledLine) return null

  return (
    compiledLine.data?.compiled ??
    compiledLine.data?.compiled_code ??
    compiledLine.result?.node?.compiled_code ??
    compiledLine.result?.compiled_code ??
    compiledLine.data?.compiled_sql ??
    null
  )
}

/**
 * List children or parents of a model via `dbt ls`.
 *
 * `dbt ls` output is stable across versions: one resource per line.
 * With --output json, each line is a JSON object with at minimum a `name` or
 * `unique_id`. Without --output json, each line is a plain unique_id string.
 * We handle both.
 */
export async function execDbtLs(
  model: string,
  direction: "children" | "parents",
): Promise<{ table: string; label: string }[]> {
  const selector = direction === "children" ? `${model}+` : `+${model}`

  // Try JSON first
  try {
    const { stdout } = await run(["ls", "--select", selector, "--resource-types", "model", "--output", "json"])
    const lines = parseJsonLines(stdout)

    if (lines.length > 0) {
      return lines
        .filter((l) => {
          const name = l.name ?? l.unique_id?.split(".").pop()
          return name && name !== model
        })
        .map((l) => ({
          table: l.name ?? l.unique_id?.split(".").pop() ?? "unknown",
          label: l.name ?? l.unique_id?.split(".").pop() ?? "unknown",
        }))
    }
  } catch {
    // --output json may not be supported in older dbt for ls
  }

  // Fallback: plain text (one unique_id per line, e.g. "model.jaffle.customers")
  const { stdout: plainOut } = await run(["ls", "--select", selector, "--resource-types", "model"])
  return plainOut
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((uid) => uid.split(".").pop() ?? uid)
    .filter((name) => name !== model)
    .map((name) => ({ table: name, label: name }))
}
