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
import { join } from "path"
import { readFileSync } from "fs"
import { resolveDbt, buildDbtEnv, type ResolvedDbt } from "./dbt-resolve"

/** Options for running dbt CLI commands in the correct environment. */
export interface DbtCliOptions {
  /** Path to the Python binary (used to find the venv's dbt). */
  pythonPath?: string
  /** dbt project root directory (used as cwd). */
  projectRoot?: string
}

/** Module-level options, set once via `configure()`. */
let globalOptions: DbtCliOptions = {}

/** Cached resolved dbt binary (resolved once on first use). */
let resolvedDbt: ResolvedDbt | undefined

/** Configure the Python/project environment for all dbt CLI calls. */
export function configure(opts: DbtCliOptions): void {
  globalOptions = opts
  resolvedDbt = undefined // Reset cache on reconfigure
}

/** Get or resolve the dbt binary path. */
function getDbt(): ResolvedDbt {
  if (!resolvedDbt) {
    resolvedDbt = resolveDbt(globalOptions.pythonPath, globalOptions.projectRoot)
  }
  return resolvedDbt
}

function run(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const dbt = getDbt()
  const env = buildDbtEnv(dbt)
  const cwd = globalOptions.projectRoot ?? process.cwd()

  return new Promise((resolve, reject) => {
    execFile(dbt.path, args, { timeout: 120_000, maxBuffer: 10 * 1024 * 1024, env, cwd }, (err, stdout, stderr) => {
      if (err) reject(err)
      else resolve({ stdout, stderr })
    })
  })
}

/**
 * Parse structured JSON log lines from dbt CLI output.
 * dbt emits one JSON object per line when --log-format json is used.
 */
function parseJsonLines(stdout: string): Record<string, unknown>[] {
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
    .filter(Boolean) as Record<string, unknown>[]
}

// ---------------------------------------------------------------------------
// Heuristic helpers — find SQL or row data anywhere in a JSON tree
// ---------------------------------------------------------------------------

/** Walk an object tree and return the first value matching a predicate. */
function deepFind(obj: unknown, predicate: (val: unknown, key: string) => boolean, maxDepth = 5): unknown {
  if (maxDepth <= 0 || obj == null || typeof obj !== "object") return undefined
  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    if (predicate(val, key)) return val
    const nested = deepFind(val, predicate, maxDepth - 1)
    if (nested !== undefined) return nested
  }
  return undefined
}

/** Strip leading SQL comments (single-line `--` and block `/* ... * /`). */
function stripLeadingComments(s: string): string {
  let trimmed = s.trim()
  // Strip block comments
  while (trimmed.startsWith("/*")) {
    const end = trimmed.indexOf("*/")
    if (end < 0) break
    trimmed = trimmed.slice(end + 2).trim()
  }
  // Strip single-line comments
  while (trimmed.startsWith("--")) {
    const nl = trimmed.indexOf("\n")
    if (nl < 0) break
    trimmed = trimmed.slice(nl + 1).trim()
  }
  return trimmed
}

/** Heuristic: does this string look like compiled SQL? */
function looksLikeSql(val: unknown): boolean {
  if (typeof val !== "string" || val.length < 10) return false
  const upper = stripLeadingComments(val).toUpperCase()
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

/** Strip ANSI escape codes from text. */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "")
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
  const cleaned = stripAnsi(text)
  const lines = cleaned.split("\n").filter((l) => l.trim().startsWith("|"))
  if (lines.length < 3) return null // Need header + separator + at least 1 data row

  const parseLine = (line: string) =>
    line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim())

  const header = parseLine(lines[0]!)
  // Skip header (index 0) and separator (index 1) by position, not string match
  const dataLines = lines.slice(2)
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

/** Safely parse a JSON string, returning the parsed value or undefined on failure. */
function safeJsonParse(val: string): unknown {
  try {
    return JSON.parse(val)
  } catch {
    return undefined
  }
}

/**
 * Extract compiled SQL from target/manifest.json after `dbt compile`.
 * More reliable than parsing stdout which contains log lines.
 */
function readCompiledFromManifest(model: string): string | null {
  const projectRoot = globalOptions.projectRoot ?? process.cwd()
  const manifestPath = join(projectRoot, "target", "manifest.json")
  try {
    const raw = readFileSync(manifestPath, "utf-8")
    const manifest = JSON.parse(raw)
    const nodes: Record<string, { name?: string; compiled_code?: string }> = manifest.nodes ?? {}
    for (const node of Object.values(nodes)) {
      if (node.name === model && node.compiled_code) {
        return node.compiled_code
      }
    }
  } catch {
    // manifest.json may not exist or be parseable
  }
  return null
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

  let lines: Record<string, unknown>[]
  try {
    const { stdout } = await run(args)
    lines = parseJsonLines(stdout)
  } catch {
    lines = []
  }

  // --- Tier 1: known field paths ---
  const previewLine =
    lines.find((l: any) => l.data?.preview) ??
    lines.find((l: any) => l.data?.rows) ??
    lines.find((l: any) => l.result?.preview) ??
    lines.find((l: any) => l.result?.rows)

  const sqlLine =
    lines.find((l: any) => l.data?.sql) ??
    lines.find((l: any) => l.data?.compiled_sql) ??
    lines.find((l: any) => l.result?.sql)

  if (previewLine) {
    const preview =
      (previewLine as any).data?.preview ??
      (previewLine as any).data?.rows ??
      (previewLine as any).result?.preview ??
      (previewLine as any).result?.rows

    // Guard JSON.parse — fall through to Tier 2 on malformed strings
    let rows: Record<string, unknown>[]
    if (typeof preview === "string") {
      const parsed = safeJsonParse(preview)
      if (Array.isArray(parsed)) {
        rows = parsed
      } else {
        rows = [] // Malformed — will fall through below
      }
    } else {
      rows = preview
    }

    // Return the result — even if empty. An empty preview means the query returned
    // zero rows, which is a valid result. Do NOT fall through to Tier 2, which could
    // match spurious log metadata as row data.
    const columnNames = rows.length > 0 && rows[0] ? Object.keys(rows[0]) : []
    const compiledSql = (sqlLine as any)?.data?.sql ?? (sqlLine as any)?.data?.compiled_sql ?? (sqlLine as any)?.result?.sql ?? sql
    return { columnNames, columnTypes: columnNames.map(() => "string"), data: rows, rawSql: sql, compiledSql }
  }

  // --- Tier 2: heuristic deep scan ---
  for (const line of lines) {
    const found = deepFind(line, (val) => looksLikeRowData(val))
    if (found) {
      const rows: Record<string, unknown>[] = typeof found === "string" ? JSON.parse(found as string) : (found as Record<string, unknown>[])
      const columnNames = rows.length > 0 && rows[0] ? Object.keys(rows[0]) : []
      const compiledSql = (deepFind(line, (val) => looksLikeSql(val)) as string) ?? sql
      return { columnNames, columnTypes: columnNames.map(() => "string"), data: rows, rawSql: sql, compiledSql }
    }
  }

  // --- Tier 3: plain text fallback (ASCII table) ---
  try {
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
  } catch {
    // Plain text dbt show also failed — fall through to error below
  }

  throw new Error(
    "Could not parse dbt show output in any format (JSON, heuristic, or plain text). " +
      `Got ${lines.length} JSON lines.`,
  )
}

/**
 * Compile a model via `dbt compile --select <model>` and return compiled SQL.
 */
export async function execDbtCompile(model: string): Promise<{ sql: string }> {
  const args = ["compile", "--select", model, "--output", "json", "--log-format", "json"]

  let lines: Record<string, unknown>[]
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
    if (found) return { sql: found as string }
  }

  // --- Tier 3: read compiled SQL from manifest.json (more reliable than stdout) ---
  // dbt compile writes compiled_code to target/manifest.json even when stdout is logs.
  // We run compile without JSON flags so it writes to manifest, then read the artifact.
  try {
    await run(["compile", "--select", model])
  } catch {
    // Compile may fail (e.g., dbt not found, project errors) — continue to manifest check
    // since a prior successful compile may have left a usable manifest
  }
  const fromManifest = readCompiledFromManifest(model)
  if (fromManifest) return { sql: fromManifest }

  // Last resort: return stdout (may contain logs mixed with SQL)
  try {
    const { stdout: plainOut } = await run(["compile", "--select", model])
    return { sql: plainOut.trim() }
  } catch (e) {
    throw new Error(
      `Could not compile model '${model}' in any format (JSON, heuristic, or manifest). ` +
        `Last error: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}

/**
 * Compile an inline query via `dbt compile --inline <sql>`.
 */
export async function execDbtCompileInline(
  sql: string,
  _model?: string | null,
): Promise<{ sql: string }> {
  const args = ["compile", "--inline", sql, "--output", "json", "--log-format", "json"]

  let lines: Record<string, unknown>[]
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
    if (found) return { sql: found as string }
  }

  // --- Tier 3: plain text fallback ---
  try {
    const { stdout: plainOut } = await run(["compile", "--inline", sql])
    return { sql: plainOut.trim() }
  } catch (e) {
    throw new Error(
      `Could not compile inline SQL in any format (JSON, heuristic, or plain text). ` +
        `Last error: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}

/** Shared: extract compiled SQL from known dbt JSON output formats. */
function findCompiledSql(lines: Record<string, unknown>[]): string | null {
  const compiledLine =
    lines.find((l: any) => l.data?.compiled) ??
    lines.find((l: any) => l.data?.compiled_code) ??
    lines.find((l: any) => l.result?.node?.compiled_code) ??
    lines.find((l: any) => l.result?.compiled_code) ??
    lines.find((l: any) => l.data?.compiled_sql)

  if (!compiledLine) return null

  return (
    (compiledLine as any).data?.compiled ??
    (compiledLine as any).data?.compiled_code ??
    (compiledLine as any).result?.node?.compiled_code ??
    (compiledLine as any).result?.compiled_code ??
    (compiledLine as any).data?.compiled_sql ??
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
        .filter((l: any) => {
          const name = l.name ?? l.unique_id?.split(".").pop()
          return name && name !== model
        })
        .map((l: any) => ({
          table: l.name ?? l.unique_id?.split(".").pop() ?? "unknown",
          label: l.name ?? l.unique_id?.split(".").pop() ?? "unknown",
        }))
    }
  } catch {
    // --output json may not be supported in older dbt for ls
  }

  // Fallback: plain text with --quiet to suppress log lines
  const { stdout: plainOut } = await run(["ls", "--select", selector, "--resource-types", "model", "--quiet"])
  return plainOut
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    // Filter out lines that look like dbt log output (contain timestamps or "Running with")
    .filter((line) => /^[a-z_][\w.]*$/i.test(line) || line.includes("."))
    .map((uid) => uid.split(".").pop() ?? uid)
    .filter((name) => name !== model)
    .map((name) => ({ table: name, label: name }))
}
