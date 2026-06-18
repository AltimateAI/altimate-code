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

/** Shape of an execFile rejection — carries stdout/stderr alongside message. */
interface ExecFileError extends Error {
  stdout?: string | Buffer
  stderr?: string | Buffer
  code?: number | string
  signal?: string
}

/** Coerce an unknown rejection into something the catch blocks can read safely. */
function toExecFileError(e: unknown): ExecFileError {
  if (e instanceof Error) return e as ExecFileError
  return new Error(String(e)) as ExecFileError
}

function run(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const dbt = getDbt()
  const env = buildDbtEnv(dbt)
  const cwd = globalOptions.projectRoot ?? process.cwd()

  return new Promise((resolve, reject) => {
    execFile(dbt.path, args, { timeout: 120_000, maxBuffer: 10 * 1024 * 1024, env, cwd }, (err, stdout, stderr) => {
      if (err) {
        // Node's execFile passes stdout/stderr as separate callback arguments,
        // not as properties on the error. Attach them here so callers can
        // surface the real dbt failure text instead of Node's generic
        // "Command failed: ..." message.
        const execErr = err as ExecFileError
        execErr.stdout = stdout
        execErr.stderr = stderr
        reject(execErr)
      } else {
        resolve({ stdout, stderr })
      }
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

  // Capture the run() errors so we can bubble the real dbt failure up if all
  // parse tiers fail; the generic "Could not parse" alone misleads callers
  // into treating structural project errors as transient.
  let primaryRunError: ExecFileError | undefined
  let lines: Record<string, unknown>[] = []
  try {
    const { stdout } = await run(args)
    lines = parseJsonLines(stdout)
  } catch (e) {
    primaryRunError = toExecFileError(e)
    // Deliberately do NOT feed crashed-run stdout into `lines` for the
    // heuristic tiers below. Crash logs can contain incidental arrays that
    // `looksLikeRowData` would happily return as "rows" (silent wrong data).
    // The crashed stdout is still consulted by extractDbtError below for the
    // structured `level: "error"` event.
  }

  // Skip the success-only tiers when the primary run failed — see comment
  // above. We still try Tier 3 (a separate plain-text run) because that can
  // recover from JSON-mode-specific failures.
  if (!primaryRunError) {
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

      // The previewLine match upstream only checked for truthiness, so a
      // future dbt version emitting `data.preview = {}` or `= 42` would
      // flow into `rows` unchecked and the downstream `data: rows` field
      // would crash callers that do `.map` / `.length`. Guard explicitly
      // for the three shapes we accept (parsed JSON array, native array,
      // malformed) and emit an empty result for anything else.
      let rows: Record<string, unknown>[]
      if (typeof preview === "string") {
        const parsed = safeJsonParse(preview)
        rows = Array.isArray(parsed) ? parsed : []
      } else if (Array.isArray(preview)) {
        rows = preview
      } else {
        rows = []
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
  }

  // --- Tier 3: plain text fallback (ASCII table) ---
  // Tried unconditionally — even if JSON-mode crashed, the plain-text mode
  // sometimes succeeds and gives us a usable table.
  let plainRunError: ExecFileError | undefined
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
  } catch (e) {
    plainRunError = toExecFileError(e)
  }

  // Two distinct failure modes; don't conflate them:
  //
  // (a) JSON-mode `dbt show` actually crashed → surface the real dbt error.
  //     This is the original motivation for the PR.
  //
  // (b) JSON-mode succeeded (exit 0) but emitted output we can't decode,
  //     AND the plain-text retry then failed for some other reason. The
  //     `dbt show` command itself didn't fail; our parser did. Throwing
  //     "dbt show failed: <plain-mode error>" here would misattribute a
  //     parser regression as a dbt execution failure.
  if (primaryRunError) {
    const errorLogLines = parseJsonLines(primaryRunError.stdout?.toString() ?? "")
    const realError = extractDbtError(errorLogLines, primaryRunError, plainRunError)
    if (realError) {
      // Avoid doubling the "failed:" prefix when dbt's own category prefix
      // is already in the message (e.g. "Database Error: ...",
      // "Compilation Error: ...").
      const hasDbtCategoryPrefix = /^(Compilation|Database|Runtime|Parsing|Validation|Dependency)\s+Error\b/.test(
        realError,
      )
      throw new Error(hasDbtCategoryPrefix ? realError : `dbt show failed: ${realError}`)
    }
  }

  if (plainRunError) {
    // Both branches stay SQL-safe: extractDbtError already strips ANSI and
    // redacts via fallbackExitMessage; the fallback here uses the same helper
    // explicitly so this code path can't regress to a raw err.message even if
    // extractDbtError is refactored.
    const fallback =
      extractDbtError([], undefined, plainRunError) ??
      fallbackExitMessage(undefined, plainRunError) ??
      "unknown error"
    throw new Error(`Could not parse dbt show JSON output, and plain-text fallback failed: ${fallback}`)
  }

  throw new Error(
    "Could not parse dbt show output in any format (JSON, heuristic, or plain text). " +
      `Got ${lines.length} JSON lines.`,
  )
}

/**
 * Pick the best human-readable error from a failed `dbt show` invocation.
 *
 * Preference order:
 *   1. The LAST structured `level: "error"` event in the JSON log. dbt often
 *      emits a generic header (e.g. "Encountered an error:") before the
 *      actionable message; we want the actionable one.
 *   2. Stderr from the JSON-mode run.
 *   3. Stderr from the plain-text-mode run.
 *   4. A concise "dbt exited with status N" fallback. We deliberately do NOT
 *      surface `err.message` directly when it's an execFile rejection — Node
 *      embeds the full command line (including the inline SQL) in that
 *      message, which would leak the user's query into logs and UI.
 *
 * Returns undefined if neither run rejected — caller falls back to the generic
 * "Could not parse" message, which is correct when dbt exited 0 but emitted
 * something we can't decode.
 *
 * ANSI escape codes are stripped from the returned message so logs and UI
 * bubbles stay clean (dbt may colour-code stderr and structured events).
 */
interface DbtLogLine {
  info?: { level?: string; msg?: string }
  level?: string
  msg?: string
}

function extractDbtError(
  lines: Record<string, unknown>[],
  primary?: ExecFileError,
  plain?: ExecFileError,
): string | undefined {
  if (!primary && !plain) return undefined

  const errorMessages = lines
    .map((l) => {
      const line = l as DbtLogLine
      const isError = line.info?.level === "error" || line.level === "error"
      if (!isError) return undefined
      return line.info?.msg ?? line.msg
    })
    .filter((m): m is string => typeof m === "string" && m.trim().length > 0)
  const structuredMsg = errorMessages.at(-1)

  const primaryStderr = primary?.stderr?.toString().trim()
  const plainStderr = plain?.stderr?.toString().trim()

  const chosen =
    (structuredMsg && structuredMsg.length > 0 ? structuredMsg : undefined) ??
    (primaryStderr && primaryStderr.length > 0 ? primaryStderr : undefined) ??
    (plainStderr && plainStderr.length > 0 ? plainStderr : undefined) ??
    fallbackExitMessage(primary, plain)

  return chosen ? stripAnsi(chosen) : undefined
}

/**
 * Build a concise exit-status message that does NOT leak the dbt command line.
 *
 * Node's `execFile` rejection has `err.message` = `"Command failed: <dbt-path>
 * show --inline '<entire SQL>' ..."` whenever the spawned process actually
 * ran — exit-non-zero AND timeout/signal kills both produce this message,
 * embedding the user's full query (potentially with secrets, PII, multi-KB
 * literals) into any log/UI surface that displays the error.
 *
 * Spawn-time failures (ENOENT etc.) have a different message shape that does
 * NOT embed args, so they're safe to surface directly.
 */
function fallbackExitMessage(primary?: ExecFileError, plain?: ExecFileError): string | undefined {
  const err = primary ?? plain
  if (!err) return undefined

  const looksLikeCommandFailed = typeof err.message === "string" && err.message.startsWith("Command failed:")
  if (!looksLikeCommandFailed) return err.message

  // The process ran; redact the embedded command line.
  if (typeof err.code === "number") return `dbt exited with status ${err.code}`
  if (err.signal) return `dbt killed by signal ${err.signal}`
  if (typeof err.code === "string") return `dbt failed: ${err.code}`
  return "dbt failed (no exit code reported)"
}

/**
 * Build a user-facing error message from a failed `dbt <cmd>` invocation.
 *
 * Used by every execDbt* function so all three share the same error UX:
 *   - structured `level: "error"` event from JSON logs > primary stderr >
 *     plain-text stderr > redacted exit-status fallback
 *   - ANSI escapes stripped
 *   - inline SQL / command-line redacted from any err.message-derived path
 *   - no doubled prefix when dbt's own category prefix is already present
 */
function bubbleDbtError(label: string, primary?: ExecFileError, plain?: ExecFileError): string {
  const errorLogLines = primary?.stdout ? parseJsonLines(primary.stdout.toString()) : []
  const real = extractDbtError(errorLogLines, primary, plain)
  if (real) {
    const hasDbtCategoryPrefix = /^(Compilation|Database|Runtime|Parsing|Validation|Dependency)\s+Error\b/.test(
      real,
    )
    return hasDbtCategoryPrefix ? real : `${label}: ${real}`
  }
  return `${label}: ${fallbackExitMessage(primary, plain) ?? "unknown error"}`
}

/**
 * Compile a model via `dbt compile --select <model>` and return compiled SQL.
 */
export async function execDbtCompile(model: string): Promise<{ sql: string }> {
  const args = ["compile", "--select", model, "--output", "json", "--log-format", "json"]

  let lines: Record<string, unknown>[] = []
  let primaryRunError: ExecFileError | undefined
  try {
    const { stdout } = await run(args)
    lines = parseJsonLines(stdout)
  } catch (e) {
    primaryRunError = toExecFileError(e)
  }

  // Skip success-only tiers when the primary run failed (same anti-spurious-
  // data reasoning as execDbtShow).
  if (!primaryRunError) {
    // --- Tier 1: known field paths ---
    const sql = findCompiledSql(lines)
    if (sql) return { sql }

    // --- Tier 2: heuristic deep scan ---
    for (const line of lines) {
      const found = deepFind(line, (val) => looksLikeSql(val))
      if (found) return { sql: found as string }
    }
  }

  // --- Manifest fallback ---
  // dbt compile writes compiled_code to target/manifest.json even when stdout
  // is just logs. Re-run plain (no JSON flags) so the artifact is fresh, then
  // read it back. We tolerate a failure here (a prior successful compile may
  // have left a usable manifest) but capture the error for later bubbling.
  let manifestRunError: ExecFileError | undefined
  try {
    await run(["compile", "--select", model])
  } catch (e) {
    manifestRunError = toExecFileError(e)
  }
  const fromManifest = readCompiledFromManifest(model)
  if (fromManifest) return { sql: fromManifest }

  // --- Last resort: plain compile, return raw stdout ---
  let plainRunError: ExecFileError | undefined
  try {
    const { stdout: plainOut } = await run(["compile", "--select", model])
    return { sql: plainOut.trim() }
  } catch (e) {
    plainRunError = toExecFileError(e)
  }

  // If dbt actually failed at any tier, surface the real dbt error via the
  // shared helper so the message is SQL-safe, ANSI-stripped, and consistent
  // with execDbtShow's error UX.
  if (primaryRunError || plainRunError || manifestRunError) {
    throw new Error(bubbleDbtError("dbt compile failed", primaryRunError, plainRunError ?? manifestRunError))
  }

  throw new Error(`Could not compile model '${model}' in any format (JSON, heuristic, or manifest).`)
}

/**
 * Compile an inline query via `dbt compile --inline <sql>`.
 */
export async function execDbtCompileInline(
  sql: string,
  _model?: string | null,
): Promise<{ sql: string }> {
  const args = ["compile", "--inline", sql, "--output", "json", "--log-format", "json"]

  let lines: Record<string, unknown>[] = []
  let primaryRunError: ExecFileError | undefined
  try {
    const { stdout } = await run(args)
    lines = parseJsonLines(stdout)
  } catch (e) {
    primaryRunError = toExecFileError(e)
  }

  // Skip success-only tiers when the primary run failed.
  if (!primaryRunError) {
    // --- Tier 1: known field paths ---
    const compiled = findCompiledSql(lines)
    if (compiled) return { sql: compiled }

    // --- Tier 2: heuristic deep scan ---
    for (const line of lines) {
      const found = deepFind(line, (val) => looksLikeSql(val))
      if (found) return { sql: found as string }
    }
  }

  // --- Tier 3: plain text fallback ---
  let plainRunError: ExecFileError | undefined
  try {
    const { stdout: plainOut } = await run(["compile", "--inline", sql])
    return { sql: plainOut.trim() }
  } catch (e) {
    plainRunError = toExecFileError(e)
  }

  // bubbleDbtError redacts inline SQL from any err.message fallback — critical
  // here because we're spawning `dbt compile --inline <user SQL>` and Node's
  // rejection message embeds the full command line (with the SQL) verbatim.
  if (primaryRunError || plainRunError) {
    throw new Error(bubbleDbtError("dbt compile inline failed", primaryRunError, plainRunError))
  }

  throw new Error("Could not compile inline SQL in any format (JSON, heuristic, or plain text).")
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
