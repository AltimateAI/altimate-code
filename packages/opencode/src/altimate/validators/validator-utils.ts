// altimate_change start — shared validator utilities
/**
 * Shared utilities for altimate dbt validators.
 *
 * Centralises logic that previously existed in both dbt-tests-pass.ts and
 * dbt-schema-verify.ts to prevent behavioural divergence. Both files already
 * imported from ../../session/validators/types so the "standalone files"
 * argument for duplication was already moot; a sibling utility adds zero new
 * coupling.
 */

import { promises as fs } from "fs"
import { join, sep, basename } from "path"

// ---------------------------------------------------------------------------
// Subprocess timeout
// ---------------------------------------------------------------------------

/**
 * Maximum milliseconds to wait for an `altimate-dbt` subprocess before
 * killing it and treating the model as unverifiable. Overrideable via
 * ALTIMATE_VALIDATORS_TIMEOUT_MS for benchmark environments where dbt startup
 * time varies.
 *
 * Parses with a finite/positive guard: NaN, 0, or negative values are rejected
 * and fall back to the 60 s default, preventing immediate SIGKILL of the process.
 */
const DEFAULT_TIMEOUT_MS = 60_000
const _parsed = Number(process.env.ALTIMATE_VALIDATORS_TIMEOUT_MS)
export const VALIDATOR_TIMEOUT_MS =
  Number.isFinite(_parsed) && _parsed > 0 ? _parsed : DEFAULT_TIMEOUT_MS

// ---------------------------------------------------------------------------
// Project detection
// ---------------------------------------------------------------------------

/**
 * Find the actual dbt project root starting from `cwd`.
 *
 * Checks `cwd` itself for `dbt_project.yml`, then scans one level of
 * subdirectories (some benchmark layouts nest the project one level deep).
 *
 * Returns the directory that contains `dbt_project.yml`, or null if not
 * found. The returned path is the correct `cwd` for subprocess invocations.
 */
// Subdirectories never considered candidates for a nested dbt project.
// Mirrors `modelsModifiedSince`'s skip list so a fixture project shipped
// inside `node_modules/foo/` or a compiled artifact in `target/` doesn't get
// confused for the user's real project.
const FIND_DBT_PROJECT_SKIP_DIRS = new Set(["node_modules", "target"])

export async function findDbtProjectRoot(cwd: string): Promise<string | null> {
  try {
    const direct = join(cwd, "dbt_project.yml")
    if (await isProjectFile(direct)) return cwd
    const entries = await fs.readdir(cwd, { withFileTypes: true }).catch(
      () => [] as import("fs").Dirent[],
    )
    // Sort alphabetically so the choice is deterministic when multiple
    // subdirectories contain a dbt_project.yml. fs.readdir's order varies
    // across filesystems / Node versions. Skip dependency / build dirs.
    const sorted = entries
      .filter((e) => e.isDirectory())
      .filter((e) => !e.name.startsWith(".") && !FIND_DBT_PROJECT_SKIP_DIRS.has(e.name))
      .sort((a, b) => a.name.localeCompare(b.name))
    for (const e of sorted) {
      const nested = join(cwd, e.name, "dbt_project.yml")
      if (await isProjectFile(nested)) return join(cwd, e.name)
    }
    return null
  } catch {
    return null
  }
}

/** True only if `path` is an existing *file* (not a directory). */
async function isProjectFile(path: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path)
    return stat.isFile()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------

/**
 * Find dbt model `.sql` files under `cwd` that were modified since `sinceMs`.
 * Scans up to 8 directory levels deep (deep enough for typical dbt layouts
 * like `models/staging/sources/dl/raw/...`); skips hidden dirs, node_modules,
 * target. Only returns files under a `models/` ancestor (case-insensitive,
 * to tolerate case-insensitive volumes on macOS APFS / Windows NTFS).
 */
const MODELS_MAX_DEPTH = 8
export async function modelsModifiedSince(cwd: string, sinceMs: number): Promise<string[]> {
  const found: string[] = []
  async function scan(dir: string, depth: number): Promise<void> {
    if (depth > MODELS_MAX_DEPTH) return
    let entries: import("fs").Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (
        entry.name.startsWith(".") ||
        entry.name === "node_modules" ||
        entry.name === "target"
      )
        continue
      const full = join(dir, entry.name)
      // Follow symlinks: a symlinked SQL file should be discoverable, and a
      // symlinked directory under `models/` should be entered. Resolve the
      // target with fs.stat (follows links) instead of relying on Dirent's
      // entry.isFile()/isDirectory() which return false for symlinks.
      let isDir = entry.isDirectory()
      let isFile = entry.isFile()
      if (entry.isSymbolicLink()) {
        try {
          const target = await fs.stat(full)
          isDir = target.isDirectory()
          isFile = target.isFile()
        } catch {
          // Broken symlink — skip without crashing.
          continue
        }
      }
      if (isDir) {
        await scan(full, depth + 1)
      } else if (isFile && entry.name.toLowerCase().endsWith(".sql")) {
        try {
          const stat = await fs.stat(full)
          if (stat.mtimeMs >= sinceMs) {
            // dbt models live under a `models/` ancestor. Case-insensitive
            // comparison so `Models/` or `MODELS/` on case-insensitive volumes
            // are accepted.
            if (full.split(sep).some((p) => p.toLowerCase() === "models")) {
              found.push(full)
            }
          }
        } catch {
          // ignore unstattable files
        }
      }
    }
  }
  await scan(cwd, 0)
  return found
}

// ---------------------------------------------------------------------------
// Path utilities
// ---------------------------------------------------------------------------

/**
 * Extract the bare model name from a `.sql` file path.
 * `models/marts/foo.sql` -> `foo`
 *
 * Handles both POSIX (`/`) and Windows (`\\`) path separators so that the
 * helper works on a Windows-style path even when running on POSIX. Strips
 * any embedded NUL bytes so the returned name is safe to pass as a shell
 * argument downstream.
 */
export function modelNameFromPath(p: string): string {
  if (!p) return ""
  // Normalise Windows separators to POSIX so basename behaves identically
  // regardless of host. This is safe because dbt model paths never contain
  // a literal `\\` as part of the name.
  const normalised = p.replace(/\\/g, "/")
  const base = basename(normalised)
  // Strip the `.sql` extension and any embedded NUL bytes (so the returned
  // value is safe to pass as a shell argument downstream).
  // eslint-disable-next-line no-control-regex
  return base.replace(/\.sql$/i, "").replace(/\x00/g, "")
}

// ---------------------------------------------------------------------------
// Concurrency utilities
// ---------------------------------------------------------------------------

/**
 * Run `fn` over `items` with at most `limit` concurrent tasks at a time.
 *
 * Unbounded Promise.all over model lists can spawn too many simultaneous dbt
 * subprocesses, causing resource contention, port conflicts, or flaky results.
 * This helper caps the active workers while preserving output order.
 */
export async function runWithConcurrencyLimit<In, Out>(
  items: In[],
  fn: (item: In) => Promise<Out>,
  limit: number,
): Promise<Out[]> {
  const results: Out[] = new Array(items.length)
  if (items.length === 0) return results
  // Determine effective worker count:
  //   - Infinity → treat as "unbounded" = items.length (full parallel).
  //   - NaN, 0, negatives, fractional < 1 → fall back to 1 (serial) so we
  //     never silently drop work via Array.from({length: 0}).
  //   - Floor positive floats and cap at items.length so we never spawn
  //     more workers than there is work to do.
  let effective: number
  if (limit === Infinity) {
    effective = items.length
  } else if (Number.isFinite(limit) && limit >= 1) {
    effective = Math.min(Math.floor(limit), items.length)
  } else {
    effective = 1
  }
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i]!)
    }
  }
  const workers = Array.from({ length: effective }, worker)
  await Promise.all(workers)
  return results
}

/** Maximum simultaneous altimate-dbt subprocesses per validator run. */
export const VALIDATOR_CONCURRENCY =
  (() => {
    const v = Number(process.env.ALTIMATE_VALIDATORS_CONCURRENCY)
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 4
  })()

// ---------------------------------------------------------------------------
// JSON extraction
// ---------------------------------------------------------------------------

/**
 * Find the LAST top-level `{ ... }` block in a string and JSON-parse it.
 *
 * `altimate-dbt` may emit dbt log noise (ANSI codes, parser warnings, Python
 * tracebacks) before the verdict JSON. Strategy:
 *   1. Try JSON.parse on the full stdout (fast path for clean output).
 *   2. Scan forward for each `{`, track brace depth + string context to find
 *      the matching `}`, attempt JSON.parse on that slice, keep the last one
 *      that matches the expected envelope shape.
 *
 * Only accepts objects that look like altimate-dbt envelopes (must contain at
 * least one of: `verdict`, `error`, `model`, `stdout`, `columns_extra`,
 * `columns_missing`). This prevents stray JSON log fragments (e.g. a dbt
 * config snippet with `{"config": ...}`) from being mistaken for the verdict.
 *
 * Returns null if no valid envelope is found.
 */
export function extractLastJsonObject(stdout: string): Record<string, unknown> | null {
  if (!stdout) return null
  // Fast path: stdout is pure JSON
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>
    if (isValidEnvelope(parsed)) return parsed
  } catch {
    // fall through
  }
  let best: Record<string, unknown> | null = null
  for (let i = 0; i < stdout.length; i++) {
    if (stdout[i] !== "{") continue
    let depth = 0
    let inString: '"' | null = null
    let escaped = false
    for (let j = i; j < stdout.length; j++) {
      const ch = stdout[j]!
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === "\\") {
        escaped = true
        continue
      }
      if (inString) {
        if (ch === inString) inString = null
        continue
      }
      if (ch === '"') {
        inString = '"'
        continue
      }
      if (ch === "{") depth++
      else if (ch === "}") {
        depth--
        if (depth === 0) {
          try {
            const parsed = JSON.parse(stdout.slice(i, j + 1)) as Record<string, unknown>
            if (isValidEnvelope(parsed)) {
              best = parsed
            }
          } catch {
            // skip malformed slice
          }
          break
        }
      }
    }
  }
  return best
}

/**
 * Guard: returns true only for objects that look like altimate-dbt output
 * envelopes. Rejects stray JSON fragments that happen to be valid JSON.
 *
 * Requires at least one envelope key to have a *defined, non-null* value.
 * `{"verdict": null}` is not a real envelope — it's a stray fragment with
 * the right shape. (We do allow `error: null` because the historical
 * test contract treats a present-but-null error as "no error".)
 */
function isValidEnvelope(obj: Record<string, unknown>): boolean {
  if (typeof obj !== "object" || obj === null) return false
  const meaningful = (k: string) => k in obj && obj[k] !== undefined && obj[k] !== null
  // `error: null` is intentionally allowed (sentinel for "ran cleanly").
  return (
    meaningful("verdict") ||
    "error" in obj ||
    meaningful("model") ||
    meaningful("stdout") ||
    meaningful("columns_extra") ||
    meaningful("columns_missing")
  )
}
// altimate_change end

// altimate_change start — task-contract, build-artifact and project-inventory helpers
/**
 * Helpers shared by the completion-gate validators that reason about the
 * task's own literal contract and about build artifacts, rather than about a
 * single touched model.
 *
 * Design rule for everything in this block: be conservative. These helpers
 * feed gates that can refuse to let a session finish, so each returns
 * "unknown" (null / empty) rather than a guess when the workspace does not
 * carry unambiguous evidence.
 */

// ---------------------------------------------------------------------------
// Task / instruction file discovery
// ---------------------------------------------------------------------------

/** A discovered task/instruction document plus where it came from. */
export interface TaskInstructionFile {
  /** Absolute path of the file that was read. */
  path: string
  /** Raw file contents. */
  content: string
}

/**
 * Filenames accepted as "the task the session was given". Deliberately a
 * closed list of names that only ever exist because somebody wrote down an
 * assignment — `README.md` is excluded because it is present in almost every
 * repository and describes the project, not the task.
 *
 * Order is significant: the first match wins, so the list runs from most to
 * least explicit.
 */
export const TASK_FILE_CANDIDATES = [
  "TASK.md",
  "TASK.txt",
  "TASKS.md",
  "INSTRUCTIONS.md",
  "INSTRUCTIONS.txt",
  "REQUIREMENTS.md",
  "SPEC.md",
  "task.md",
  "task.txt",
  "instructions.md",
  "requirements.md",
  "spec.md",
] as const

/** Largest task file we will read. Guards against a stray multi-MB document. */
const TASK_FILE_MAX_BYTES = 512 * 1024

/**
 * Locate the task/instruction document for this workspace.
 *
 * Search order:
 *   1. `ALTIMATE_VALIDATORS_TASK_FILE` (absolute, or relative to `cwd`) — the
 *      explicit opt-in for harnesses that put the task somewhere unusual.
 *   2. `TASK_FILE_CANDIDATES` at `cwd`.
 *   3. `TASK_FILE_CANDIDATES` inside `cwd/.altimate/`.
 *   4. `TASK_FILE_CANDIDATES` at `dbtRoot`, when the dbt project is nested
 *      below `cwd`.
 *
 * Returns null when no such document exists. Callers must treat that as "the
 * task contract is unknown" and skip, never as "nothing was required".
 */
export async function findTaskInstructionFile(
  cwd: string,
  dbtRoot?: string | null,
): Promise<TaskInstructionFile | null> {
  const explicit = process.env.ALTIMATE_VALIDATORS_TASK_FILE
  const roots = [cwd, join(cwd, ".altimate")]
  if (dbtRoot && dbtRoot !== cwd) roots.push(dbtRoot)
  const paths: string[] = []
  if (explicit && explicit.trim().length > 0) {
    paths.push(isAbsolutePath(explicit) ? explicit : join(cwd, explicit))
  }
  for (const root of roots) {
    for (const name of TASK_FILE_CANDIDATES) paths.push(join(root, name))
  }
  for (const p of paths) {
    try {
      const stat = await fs.stat(p)
      if (!stat.isFile() || stat.size > TASK_FILE_MAX_BYTES) continue
      const content = await fs.readFile(p, "utf8")
      if (content.trim().length === 0) continue
      return { path: p, content }
    } catch {
      // not present / unreadable — keep looking
    }
  }
  return null
}

/** Absolute-path test that also accepts Windows drive-letter roots. */
function isAbsolutePath(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)
}

// ---------------------------------------------------------------------------
// Literal deliverable extraction
// ---------------------------------------------------------------------------

/** Deliverables a task document names literally. */
export interface RequiredDeliverables {
  /** Bare relation/model identifiers, lowercased, de-duplicated. */
  models: string[]
  /** Literal file paths, as written (e.g. `models/marts/orders.sql`). */
  files: string[]
  /** Which extraction tier produced the names — recorded for telemetry. */
  source: "declaration" | "deliverables-section" | "requirement-lines"
}

/**
 * Words that are never a deliverable name even inside a code span on a
 * requirement line. This list is what keeps the extractor literal: anything
 * that survives it was written by the task author as an identifier.
 */
const DELIVERABLE_STOPWORDS = new Set([
  "model", "models", "table", "tables", "view", "views", "seed", "seeds",
  "snapshot", "snapshots", "mart", "marts", "staging", "source", "sources",
  "column", "columns", "row", "rows", "schema", "database", "warehouse",
  "dbt", "sql", "yml", "yaml", "json", "csv", "select", "from", "where",
  "group", "order", "join", "ref", "config", "target", "project",
  "dbt_project", "profiles", "run", "build", "test", "tests", "compile",
  "true", "false", "null", "int", "integer", "float", "string", "varchar",
  "date", "datetime", "timestamp", "boolean", "the", "and", "not", "with",
])

/** A deliverable identifier: SQL-identifier shaped, at least three chars. */
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]{2,}$/
/** A literal file path a task can require verbatim. */
const FILE_PATH_RE = /^[A-Za-z0-9_./-]+\.(?:sql|ya?ml|csv)$/i
/** Inline code spans — the only place a name is accepted from. */
const CODE_SPAN_RE = /`([^`\n]+)`/g
/** Verb that makes a line a requirement rather than background prose. */
const REQUIREMENT_VERB_RE =
  /\b(?:creat|build|produc|implement|deliver|materiali[sz]|generat|writ|deploy)\w*\b/i
/** Noun that makes the requirement about a data artifact. */
const DELIVERABLE_NOUN_RE =
  /\b(?:model|models|table|tables|view|views|seed|seeds|snapshot|snapshots|mart|marts|file|files)\b/i
/** Heading that opens an explicit deliverables list. */
const DELIVERABLES_HEADING_RE = /^\s{0,3}#{1,6}\s*(?:required|deliverab|expected output)/i
/** Any other heading closes it. */
const ANY_HEADING_RE = /^\s{0,3}#{1,6}\s/
/** Machine-readable declaration block. */
const DECLARATION_RE =
  /(?:<!--\s*)?altimate:?[ _-]?required[ _-]models\s*[:=]\s*([^\n>]*?)(?:-->|\n|$)/i

/**
 * Extract the deliverable names a task document states **literally**.
 *
 * Three tiers, most explicit first; the first tier that yields anything wins,
 * so a workspace that declares its contract machine-readably is never second-
 * guessed by prose scanning:
 *
 *   1. `declaration` — an `altimate:required-models: a, b` marker, optionally
 *      inside an HTML comment.
 *   2. `deliverables-section` — inline-code identifiers under a heading whose
 *      text starts with "Required" / "Deliverab…" / "Expected output".
 *   3. `requirement-lines` — inline-code identifiers on a line carrying both
 *      a requirement verb and a data-artifact noun.
 *
 * No fuzzy matching and no inference: a name must sit inside a code span (or
 * the declaration block), must be identifier- or path-shaped, and must not be
 * a generic data-modelling word. Returns null when the document names
 * nothing — callers must treat that as "unknown contract".
 */
export function extractRequiredDeliverables(text: string): RequiredDeliverables | null {
  if (!text) return null

  const declaration = DECLARATION_RE.exec(text)
  if (declaration && declaration[1]) {
    const collected = collectDeliverableTokens(declaration[1].split(/[,\s]+/))
    if (collected.models.length > 0 || collected.files.length > 0) {
      return { ...collected, source: "declaration" }
    }
  }

  const lines = text.split(/\r?\n/)

  // Tier 2 — an explicit deliverables section.
  const sectionTokens: string[] = []
  let inSection = false
  for (const line of lines) {
    if (DELIVERABLES_HEADING_RE.test(line)) {
      inSection = true
      continue
    }
    if (inSection && ANY_HEADING_RE.test(line)) {
      inSection = false
      continue
    }
    if (inSection) sectionTokens.push(...inlineCodeSpans(line))
  }
  const section = collectDeliverableTokens(sectionTokens)
  if (section.models.length > 0 || section.files.length > 0) {
    return { ...section, source: "deliverables-section" }
  }

  // Tier 3 — requirement lines in prose.
  const proseTokens: string[] = []
  for (const line of lines) {
    if (!REQUIREMENT_VERB_RE.test(line)) continue
    if (!DELIVERABLE_NOUN_RE.test(line)) continue
    proseTokens.push(...inlineCodeSpans(line))
  }
  const prose = collectDeliverableTokens(proseTokens)
  if (prose.models.length > 0 || prose.files.length > 0) {
    return { ...prose, source: "requirement-lines" }
  }
  return null
}

/** Pull the contents of every inline code span on a line. */
function inlineCodeSpans(line: string): string[] {
  const out: string[] = []
  CODE_SPAN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CODE_SPAN_RE.exec(line)) !== null) {
    if (m[1]) out.push(m[1])
  }
  return out
}

/** Classify raw tokens into model identifiers and literal file paths. */
function collectDeliverableTokens(tokens: string[]): { models: string[]; files: string[] } {
  const models: string[] = []
  const files: string[] = []
  for (const raw of tokens) {
    const token = raw.trim().replace(/[.,;:]+$/, "")
    if (!token) continue
    if (token.includes("/") && FILE_PATH_RE.test(token)) {
      if (!files.includes(token)) files.push(token)
      // A required `models/marts/orders.sql` also requires the model `orders`.
      const bare = modelNameFromPath(token).toLowerCase()
      if (IDENTIFIER_RE.test(bare) && !DELIVERABLE_STOPWORDS.has(bare) && !models.includes(bare)) {
        models.push(bare)
      }
      continue
    }
    // A bare `orders.sql` names a model without pinning its directory.
    const withoutExt = token.toLowerCase().replace(/\.(?:sql|ya?ml|csv)$/i, "")
    if (!IDENTIFIER_RE.test(withoutExt)) continue
    if (DELIVERABLE_STOPWORDS.has(withoutExt)) continue
    if (!models.includes(withoutExt)) models.push(withoutExt)
  }
  return { models, files }
}

// ---------------------------------------------------------------------------
// dbt build artifacts
// ---------------------------------------------------------------------------

/**
 * Resolve the project's artifact directory. Honours `DBT_TARGET_PATH` and a
 * `target-path:` key in `dbt_project.yml`; defaults to `target`.
 */
export async function resolveDbtTargetPath(dbtRoot: string): Promise<string> {
  const fromEnv = process.env.DBT_TARGET_PATH
  if (fromEnv && fromEnv.trim().length > 0) {
    return isAbsolutePath(fromEnv) ? fromEnv : join(dbtRoot, fromEnv)
  }
  try {
    const yml = await fs.readFile(join(dbtRoot, "dbt_project.yml"), "utf8")
    const m = /^\s*target-path\s*:\s*["']?([^"'#\n]+?)["']?\s*(?:#.*)?$/m.exec(yml)
    if (m && m[1] && m[1].trim().length > 0) {
      const value = m[1].trim()
      return isAbsolutePath(value) ? value : join(dbtRoot, value)
    }
  } catch {
    // no project file / unreadable — fall through to the default
  }
  return join(dbtRoot, "target")
}

/** One node of a dbt `run_results.json`. */
export interface RunResultNode {
  /** e.g. `model.my_project.orders`. */
  uniqueId: string
  /** Bare node name, lowercased (`orders`). */
  name: string
  /** dbt status string, lowercased (`success`, `error`, `skipped`, …). */
  status: string
  /** dbt's message for the node, when present. */
  message: string | null
}

/** A parsed `run_results.json` plus its freshness. */
export interface RunResultsArtifact {
  path: string
  /** mtime of the artifact file. */
  mtimeMs: number
  results: RunResultNode[]
}

/** dbt statuses that mean the node built cleanly. `warn` is not a failure. */
const OK_RUN_STATUSES = new Set(["success", "pass", "warn"])

/** True when a run_results status means the node did NOT build cleanly. */
export function isFailedRunStatus(status: string): boolean {
  return !OK_RUN_STATUSES.has(status.toLowerCase())
}

/**
 * Read and parse `<target>/run_results.json`. Returns null when the artifact
 * is absent or unparseable — callers decide what that means for their gate.
 */
export async function readRunResults(dbtRoot: string): Promise<RunResultsArtifact | null> {
  const targetPath = await resolveDbtTargetPath(dbtRoot)
  const path = join(targetPath, "run_results.json")
  try {
    const stat = await fs.stat(path)
    if (!stat.isFile()) return null
    const raw = await fs.readFile(path, "utf8")
    const parsed = JSON.parse(raw) as { results?: unknown }
    const rows = Array.isArray(parsed.results) ? parsed.results : []
    const results: RunResultNode[] = []
    for (const row of rows) {
      if (typeof row !== "object" || row === null) continue
      const r = row as Record<string, unknown>
      const uniqueId = typeof r["unique_id"] === "string" ? r["unique_id"] : ""
      if (!uniqueId) continue
      const parts = uniqueId.split(".")
      results.push({
        uniqueId,
        name: (parts[parts.length - 1] ?? "").toLowerCase(),
        status: typeof r["status"] === "string" ? r["status"].toLowerCase() : "",
        message: typeof r["message"] === "string" ? r["message"] : null,
      })
    }
    return { path, mtimeMs: stat.mtimeMs, results }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Project inventory
// ---------------------------------------------------------------------------

/** Directories under a dbt project that hold buildable node definitions. */
const NODE_DIRS = ["models", "seeds", "snapshots", "data", "analyses"]
/** File extensions that define a node. */
const NODE_EXTENSIONS = [".sql", ".csv", ".py"]
/** Depth limit mirroring `modelsModifiedSince`. */
const INVENTORY_MAX_DEPTH = 8

/**
 * Collect every node name the project defines on disk (models, seeds,
 * snapshots, analyses) plus every node name and alias recorded in
 * `manifest.json` when one exists.
 *
 * The union is deliberate: a gate built on this set fails only when a name is
 * absent from BOTH sources, so an aliased or dynamically-named node cannot
 * produce a false "you did not build it".
 */
export async function collectProducedNodeNames(dbtRoot: string): Promise<Set<string>> {
  const names = new Set<string>()
  async function scan(dir: string, depth: number): Promise<void> {
    if (depth > INVENTORY_MAX_DEPTH) return
    let entries: import("fs").Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue
      const full = join(dir, entry.name)
      let isDir = entry.isDirectory()
      let isFile = entry.isFile()
      if (entry.isSymbolicLink()) {
        try {
          const target = await fs.stat(full)
          isDir = target.isDirectory()
          isFile = target.isFile()
        } catch {
          continue
        }
      }
      if (isDir) {
        await scan(full, depth + 1)
      } else if (isFile) {
        const lower = entry.name.toLowerCase()
        const ext = NODE_EXTENSIONS.find((e) => lower.endsWith(e))
        if (ext) names.add(lower.slice(0, lower.length - ext.length))
      }
    }
  }
  for (const nodeDir of NODE_DIRS) {
    await scan(join(dbtRoot, nodeDir), 0)
  }
  // manifest.json contributes names and aliases for nodes whose relation name
  // differs from the filename.
  try {
    const targetPath = await resolveDbtTargetPath(dbtRoot)
    const raw = await fs.readFile(join(targetPath, "manifest.json"), "utf8")
    const manifest = JSON.parse(raw) as { nodes?: Record<string, unknown> }
    for (const node of Object.values(manifest.nodes ?? {})) {
      if (typeof node !== "object" || node === null) continue
      const n = node as Record<string, unknown>
      for (const key of ["name", "alias", "identifier"]) {
        const value = n[key]
        if (typeof value === "string" && value.length > 0) names.add(value.toLowerCase())
      }
    }
  } catch {
    // no manifest — the fs inventory stands alone
  }
  return names
}

// ---------------------------------------------------------------------------
// SQL / Jinja text handling
// ---------------------------------------------------------------------------

/**
 * Blank out SQL and Jinja comments so a lint regex cannot match text the
 * warehouse never sees. Comment bodies are replaced with spaces of equal
 * length so downstream character offsets stay meaningful.
 */
export function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
    .replace(/--[^\n]*/g, (m) => " ".repeat(m.length))
    .replace(/\{#[\s\S]*?#\}/g, (m) => " ".repeat(m.length))
}
// altimate_change end
