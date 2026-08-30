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
 * target, and the dbt package install directories (`dbt_packages`,
 * `dbt_modules`) whose contents `dbt deps` rewrites wholesale. Only returns
 * files under a `models/` ancestor (case-insensitive, to tolerate
 * case-insensitive volumes on macOS APFS / Windows NTFS).
 */
const MODELS_MAX_DEPTH = 8
export async function modelsModifiedSince(cwd: string, sinceMs: number): Promise<string[]> {
  const found: string[] = []
  // Model directories come from `dbt_project.yml`, not from the literal
  // "models". A project on `model-paths: ['transform']` would otherwise yield
  // an empty touched set and hand `dbt-build-green` a vacuous pass.
  const sourcePaths = await resolveDbtSourcePaths(cwd)
  const modelDirs = sourcePaths.models
  const packageDirs = sourcePaths.packages
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
      // Installed dbt packages. `dbt deps` rewrites every file under here, so
      // without this skip a plain `dbt deps` makes every dependency model look
      // locally edited. Matched on the resolved path, so a configured
      // `packages-install-path` is honoured and a same-named local directory
      // elsewhere is not skipped.
      if (isUnderAnyDir(full, packageDirs)) continue
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
            // With a project file, the configured model paths are
            // authoritative. Without one there is nothing to honour, so fall
            // back to dbt's conventional layout: any `models` ancestor,
            // case-insensitively for APFS/NTFS. That keeps this helper usable
            // on a directory that is not itself a project root.
            const qualifies = sourcePaths.hasProjectFile
              ? isUnderAnyDir(full, modelDirs)
              : full.split(sep).some((p) => p.toLowerCase() === "models")
            if (qualifies) {
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
  const all = await findTaskInstructionFiles(cwd, dbtRoot)
  return all[0] ?? null
}

/**
 * Every task/instruction document in the workspace, in the same precedence
 * order `findTaskInstructionFile` uses.
 *
 * Callers that want a *contract* must use this and keep looking past a
 * document that names no deliverables. A workspace commonly carries an
 * informational `TASK.md` beside a `REQUIREMENTS.md` that states the actual
 * obligations; stopping at the first readable file lets the informational one
 * mask the real contract, and both contract-driven gates then skip a session
 * that produced nothing.
 *
 * `ALTIMATE_VALIDATORS_TASK_FILE` keeps its override semantics: when it names
 * a readable file, that file is the contract and nothing else is considered.
 */
export async function findTaskInstructionFiles(
  cwd: string,
  dbtRoot?: string | null,
): Promise<TaskInstructionFile[]> {
  const explicit = process.env.ALTIMATE_VALIDATORS_TASK_FILE
  if (explicit && explicit.trim().length > 0) {
    const p = isAbsolutePath(explicit) ? explicit : join(cwd, explicit)
    const found = await readTaskFile(p)
    return found ? [found] : []
  }
  const roots = [cwd, join(cwd, ".altimate")]
  if (dbtRoot && dbtRoot !== cwd) roots.push(dbtRoot)
  const paths: string[] = []
  for (const root of roots) {
    for (const name of TASK_FILE_CANDIDATES) paths.push(join(root, name))
  }
  const out: TaskInstructionFile[] = []
  // Deduplicated by file identity, never by path spelling. On a
  // case-insensitive volume (APFS, NTFS) `TASK.md` and `task.md` resolve to
  // one file and must be reported once; on a case-sensitive volume they are
  // two distinct candidates and both have to stay reachable, so a lowercased
  // key would make every lowercase candidate unreadable and skip the gate on
  // a workspace whose only task document is `task.md`.
  const seen = new Set<string>()
  for (const p of paths) {
    const found = await readTaskFile(p)
    if (!found) continue
    const identity = await fs.realpath(p).catch(() => p)
    if (seen.has(identity)) continue
    seen.add(identity)
    out.push(found)
  }
  return out
}

/** Read one candidate task document, or null when it is absent/unusable. */
async function readTaskFile(path: string): Promise<TaskInstructionFile | null> {
  try {
    const stat = await fs.stat(path)
    if (!stat.isFile() || stat.size > TASK_FILE_MAX_BYTES) return null
    const content = await fs.readFile(path, "utf8")
    if (content.trim().length === 0) return null
    return { path, content }
  } catch {
    return null
  }
}

/**
 * `{{ env_var('NAME') }}` / `{{ env_var('NAME', 'default') }}` — the only
 * Jinja form a project path is worth resolving, and the only one dbt users
 * reach for in `target-path`.
 */
const ENV_VAR_EXPR_RE =
  /^\{\{-?\s*env_var\s*\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*(?:,\s*['"]([^'"]*)['"]\s*)?\)\s*-?\}\}$/

/**
 * Resolve a configured path that may be a Jinja expression.
 *
 * Returns the literal value when there is no Jinja, the resolved value for a
 * whole-value `env_var()` expression, and null when the value contains Jinja
 * this helper cannot render. Null means "unknown" — callers must fall back to
 * dbt's default rather than treat the unrendered text as a directory name.
 */
function resolveJinjaPathValue(value: string): string | null {
  if (!value.includes("{{") && !value.includes("{%")) return value
  const m = ENV_VAR_EXPR_RE.exec(value)
  if (!m || !m[1]) return null
  const fromEnv = process.env[m[1]]
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  return m[2] !== undefined && m[2].length > 0 ? m[2] : null
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
/**
 * Verb that makes a line a requirement rather than background prose.
 *
 * Creation verbs plus the modification verbs that carry the same obligation —
 * "Add the missing `stg_teams.sql`" states a deliverable exactly as
 * "Implement the missing …" does. The modification verbs are spelled with
 * explicit inflections rather than a `\w*` tail so that `add` cannot match
 * `address` and `fix` cannot match `fixture`.
 */
const REQUIREMENT_VERB_RE =
  /\b(?:(?:creat|build|produc|implement|deliver|materiali[sz]|generat|writ|deploy)\w*|add(?:s|ed|ing)?|renam(?:e|es|ed|ing)|convert(?:s|ed|ing)?|fix(?:es|ed|ing)?|repair(?:s|ed|ing)?)\b/i
/** Noun that makes the requirement about a data artifact. */
const DELIVERABLE_NOUN_RE =
  /\b(?:model|models|table|tables|view|views|seed|seeds|snapshot|snapshots|mart|marts|file|files)\b/i
/**
 * Heading that opens an explicit deliverables list.
 *
 * Bounded on purpose. An unbounded `required` prefix also matches
 * `## Required columns`, whose code spans are column names — turning every one
 * of them into a required model and failing a session that never promised
 * those relations. A heading qualifies only when it is about deliverables:
 * bare "Required", "Required models/files/…", "Deliverables", or
 * "Expected output".
 */
const DELIVERABLES_HEADING_RE =
  /^\s{0,3}#{1,6}\s*(?:deliverab\w*|expected\s+outputs?|required(?:\s+(?:deliverab\w*|models?|files?|outputs?|artifacts?|tables?|views?|seeds?|snapshots?))?)\s*:?\s*$/i
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
    const verb = REQUIREMENT_VERB_RE.exec(line)
    if (!verb) continue
    if (!DELIVERABLE_NOUN_RE.test(line)) continue
    // "Do not create the model `legacy_orders`" carries a creation verb and an
    // artifact noun, but names something that must NOT exist. Recording it as
    // required makes the deliverable gate reject the correct implementation
    // forever, so a negated verb disqualifies the whole line.
    if (verbIsNegated(line, verb.index)) continue
    proseTokens.push(...inlineCodeSpans(requirementHead(line, verb.index)))
  }
  const prose = collectDeliverableTokens(proseTokens)
  if (prose.models.length > 0 || prose.files.length > 0) {
    return { ...prose, source: "requirement-lines" }
  }
  return null
}

/**
 * Word that stops naming the deliverable and starts describing it. Everything
 * after it is an attribute, not another artifact: in "Create the model
 * `fct_orders` with unique key `order_id`", `order_id` is a column, and
 * requiring a *model* by that name blocks a correct implementation forever.
 */
const REQUIREMENT_QUALIFIER_RE =
  /\b(?:with|using|keyed|partitioned|clustered|containing|including|whose|grain(?:ed)?\s+(?:on|by)|based\s+on)\b/i

/**
 * The part of a requirement line that still names artifacts — everything up to
 * the first qualifier word. Lines that list several deliverables
 * ("Build `stg_a` and `stg_b`") keep all of them; lines that name one and then
 * describe it keep only the name.
 */
function requirementHead(line: string, verbIndex: number): string {
  // Only a qualifier that follows the requirement verb starts the attribute
  // clause. "Using dbt, create the model `orders`" opens with one, and cutting
  // there leaves nothing to extract — the contract reads as absent and both
  // deliverable gates skip a session that was told exactly what to build.
  REQUIREMENT_QUALIFIER_RE.lastIndex = 0
  const m = REQUIREMENT_QUALIFIER_RE.exec(line.slice(verbIndex))
  return m ? line.slice(0, verbIndex + m.index) : line
}

/**
 * Negation that turns a requirement verb into a prohibition, allowed to sit at
 * most a couple of words before the verb ("do not create", "never rename",
 * "must not add", "without creating").
 */
const VERB_NEGATION_RE =
  /\b(?:not|never|don'?t|do\s+not|doesn'?t|cannot|can'?t|avoid|without|no\s+need\s+to)\b(?:\s+\w+){0,2}\s*$/i

/** True when the requirement verb at `verbIndex` is negated. */
function verbIsNegated(line: string, verbIndex: number): boolean {
  return VERB_NEGATION_RE.test(line.slice(0, verbIndex))
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
      // A required `models/schema.yml` requires a file and no relation, so no
      // model name is derived from it.
      if (/\.(?:sql|csv)$/i.test(token)) {
        const bare = modelNameFromPath(token).toLowerCase()
        if (IDENTIFIER_RE.test(bare) && !DELIVERABLE_STOPWORDS.has(bare) && !models.includes(bare)) {
          models.push(bare)
        }
      }
      continue
    }
    // A bare `properties.yml` names a YAML file, and no relation. Recording
    // `properties` as a required *model* would block a session that created
    // exactly the file the task asked for; and with no directory there is
    // nothing to check its existence against, so it is dropped entirely.
    if (/\.ya?ml$/i.test(token)) continue
    // A bare `orders.sql` names a model without pinning its directory.
    const withoutExt = token.toLowerCase().replace(/\.(?:sql|csv)$/i, "")
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
    // Quoted forms are matched before the bare form: a Jinja value carries
    // its own quotes (`"{{ env_var('DIR') }}"`), so a bare-value pattern that
    // stops at the first quote truncates it.
    const m = /^\s*target-path\s*:\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^#\n]*?))\s*(?:#.*)?$/m.exec(yml)
    const raw = m ? (m[1] ?? m[2] ?? m[3] ?? "") : ""
    if (raw.trim().length > 0) {
      const value = resolveJinjaPathValue(raw.trim())
      // An unresolvable Jinja expression is not a directory name. Joining it
      // verbatim produces a path that cannot exist, `readRunResults` reports
      // no artifact, and the build gate blocks a session whose build was
      // perfectly green. Falling back to dbt's default is the direction that
      // can only under-fire.
      if (value !== null && value.length > 0) {
        return isAbsolutePath(value) ? value : join(dbtRoot, value)
      }
    }
  } catch {
    // no project file / unreadable — fall through to the default
  }
  return join(dbtRoot, "target")
}

/**
 * The source directories a dbt project reads its node definitions from, as
 * absolute paths.
 *
 * dbt lets a project rename every one of these (`model-paths: ['transform']`).
 * Hard-coding `models/` makes such a project invisible to every path-based
 * check in this lane: `dbt-build-green` finds no touched models and takes its
 * vacuous `nothing-to-gate` path, while `dbt-deliverable-names` reports a
 * model that exists as absent. Both directions are wrong, so every scanner
 * here is driven off this resolver rather than off a literal.
 */
export interface DbtSourcePaths {
  models: string[]
  seeds: string[]
  snapshots: string[]
  analyses: string[]
  macros: string[]
  tests: string[]
  /**
   * Where `dbt deps` installs dependency packages, resolved to absolute paths.
   *
   * Excluded from every "what did this session author" scan: `dbt deps`
   * rewrites every file under here wholesale, so without the exclusion a plain
   * `dbt deps` makes every dependency model look locally edited. That reaches
   * the two pre-existing subprocess validators, which would then run a dbt
   * test per dependency model.
   *
   * Resolved rather than matched by name (`packages-install-path` is
   * configurable), and compared as a path rather than a bare directory name,
   * so a project that genuinely authors a directory called `dbt_packages`
   * somewhere else is not silently skipped.
   */
  packages: string[]
  /**
   * Whether a readable `dbt_project.yml` was found at the root these paths
   * were resolved from.
   *
   * Callers that scan a directory which may not be a project root use this to
   * decide whether the resolved paths are authoritative. Without a project
   * file there is nothing to honour, and falling back to dbt's conventional
   * layout is the only thing left to do.
   */
  hasProjectFile: boolean
}

/**
 * Read a `key: [...]` path list out of `dbt_project.yml`.
 *
 * Handles the two shapes dbt projects actually use — an inline flow sequence
 * (`model-paths: ["a", "b"]`) and a block sequence (`model-paths:` followed by
 * `  - a`) — plus a bare scalar, which dbt tolerates. Returns null when the
 * key is absent so the caller can apply dbt's default.
 *
 * Deliberately not a general YAML parser: this lane must not take a YAML
 * dependency for four keys, and a wrong answer here fails safe (the default).
 */
export function readDbtProjectPathList(yml: string, key: string): string[] | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  // `[ \t]*` rather than `\s*`: `\s` matches newlines, so around the colon it
  // reaches into the next line and captures the first item of a block
  // sequence as if it were an inline scalar.
  const line = new RegExp(`^([ \\t]*)${escaped}[ \\t]*:[ \\t]*(.*)$`, "m").exec(yml)
  if (!line) return null
  const indent = (line[1] ?? "").length
  // Strip a trailing comment, and a comment that is the whole value. Without
  // the second case `model-paths:  # TODO` parses as a directory literally
  // named "# TODO", and the project's real models become invisible to every
  // gate instead of falling back to dbt's default.
  const rest = (line[2] ?? "")
    .replace(/\s+#.*$/, "")
    .replace(/^#.*$/, "")
    .trim()

  const unquote = (s: string): string => {
    const t = s.trim()
    if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
      return t.slice(1, -1)
    }
    return t
  }

  if (rest.startsWith("[")) {
    const close = rest.indexOf("]")
    const inner = close === -1 ? rest.slice(1) : rest.slice(1, close)
    const items = inner
      .split(",")
      .map(unquote)
      .filter((s) => s.length > 0)
    return items.length > 0 ? items : null
  }

  if (rest.length > 0) {
    const single = unquote(rest)
    return single.length > 0 ? [single] : null
  }

  // Block sequence: subsequent `-` items indented deeper than the key.
  const after = yml.slice((line.index ?? 0) + line[0].length)
  const items: string[] = []
  for (const raw of after.split("\n")) {
    if (raw.trim().length === 0) continue
    const m = /^([ \t]*)-\s*(.*)$/.exec(raw)
    if (!m) {
      // A non-item line at or left of the key's indent ends the sequence.
      const lead = /^[ \t]*/.exec(raw)?.[0].length ?? 0
      if (lead <= indent) break
      continue
    }
    if ((m[1] ?? "").length <= indent) break
    const value = unquote((m[2] ?? "").replace(/\s+#.*$/, ""))
    if (value.length > 0) items.push(value)
  }
  return items.length > 0 ? items : null
}

/**
 * Resolve every node-source directory of a dbt project to absolute paths,
 * honouring the `*-paths` keys in `dbt_project.yml` and falling back to dbt's
 * defaults. Unreadable project file → all defaults.
 */
export async function resolveDbtSourcePaths(dbtRoot: string): Promise<DbtSourcePaths> {
  let yml = ""
  let hasProjectFile = false
  try {
    yml = await fs.readFile(join(dbtRoot, "dbt_project.yml"), "utf8")
    hasProjectFile = true
  } catch {
    // No project file — defaults below.
  }
  const pick = (key: string, legacyKey: string | null, defaults: string[]): string[] => {
    const configured =
      readDbtProjectPathList(yml, key) ?? (legacyKey ? readDbtProjectPathList(yml, legacyKey) : null)
    const chosen = configured ?? defaults
    const out: string[] = []
    for (const entry of chosen) {
      const value = resolveJinjaPathValue(entry)
      // An unresolvable Jinja path is not a directory name; skipping it leaves
      // the other configured paths intact rather than scanning a bogus one.
      if (value === null || value.length === 0) continue
      out.push(isAbsolutePath(value) ? value : join(dbtRoot, value))
    }
    return out.length > 0 ? out : defaults.map((d) => join(dbtRoot, d))
  }
  return {
    // `data-paths` / `source-paths` are the pre-1.0 spellings; a project still
    // carrying them would otherwise read as unconfigured.
    models: pick("model-paths", "source-paths", ["models"]),
    seeds: pick("seed-paths", "data-paths", ["seeds", "data"]),
    snapshots: pick("snapshot-paths", null, ["snapshots"]),
    analyses: pick("analysis-paths", null, ["analyses"]),
    macros: pick("macro-paths", null, ["macros"]),
    tests: pick("test-paths", null, ["tests"]),
    // `dbt_modules` is the pre-1.0 spelling and is always excluded alongside
    // whatever the project configures, because a project migrated from it can
    // still have the old directory on disk.
    packages: Array.from(
      new Set([
        ...pick("packages-install-path", null, ["dbt_packages"]),
        join(dbtRoot, "dbt_modules"),
      ]),
    ),
    hasProjectFile,
  }
}

/**
 * True when `filePath` sits inside one of `dirs` (or is one of them).
 *
 * Compared case-insensitively so a case-insensitive volume (APFS, NTFS) does
 * not make `Models/` read as outside `models/`.
 */
export function isUnderAnyDir(filePath: string, dirs: string[]): boolean {
  const target = filePath.toLowerCase()
  for (const dir of dirs) {
    const base = dir.toLowerCase().replace(/[\\/]+$/, "")
    if (target === base) return true
    if (target.startsWith(base + sep) || target.startsWith(base + "/")) return true
  }
  return false
}

/** One node of a dbt `run_results.json`. */
export interface RunResultNode {
  /** e.g. `model.my_project.orders`. */
  uniqueId: string
  /** Bare node name, lowercased (`orders`). */
  name: string
  /**
   * Version suffix for a dbt versioned model (`model.pkg.dim_accounts.v2` →
   * `v2`), else null. The name of such a node is `dim_accounts`, while the
   * file that defines it is typically `dim_accounts_v2.sql`, so a caller
   * matching files against results has to try both spellings.
   */
  version: string | null
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
  /**
   * The dbt subcommand that wrote this artifact, from `args.which`
   * (`build`, `run`, `test`, `compile`, …), lowercased. Null when the
   * artifact carries no `args.which` — every dbt version this lane targets
   * writes one, so null means a hand-written or truncated file.
   *
   * Load-bearing: `run_results.json` is a single file that EVERY dbt command
   * overwrites, and the rows alone do not say which command produced them.
   * `dbt compile` writes a full set of model rows with `status: "success"`
   * without executing a single statement, so status without provenance is
   * not evidence that anything was built.
   */
  command: string | null
}

/**
 * dbt subcommands that actually execute model SQL against the warehouse, so a
 * `success` row in their artifact is evidence the relation was built.
 *
 * `compile`, `parse`, `docs`, `list` and friends are deliberately absent: they
 * populate `run_results.json` with `status: "success"` model rows having run
 * nothing at all.
 */
const MODEL_EXECUTING_DBT_COMMANDS = new Set(["run", "build"])

/**
 * dbt subcommands that execute *something*, but never a model.
 *
 * `seed`, `snapshot` and `clone` build their own node types, so their rows
 * cannot speak for a model — but they are a normal thing to run after a build,
 * exactly like `test`, so they must not be treated as "no build happened"
 * either. They fall through to the `<target>/run/` DDL evidence path.
 */
const NON_MODEL_EXECUTING_DBT_COMMANDS = new Set(["test", "seed", "snapshot", "clone"])

/**
 * dbt subcommands known to execute nothing at all: they populate
 * `run_results.json` from the manifest without touching the warehouse.
 */
const NON_EXECUTING_DBT_COMMANDS = new Set([
  "compile",
  "parse",
  "docs",
  "generate",
  "list",
  "ls",
  "source",
  "freshness",
  "deps",
  "debug",
  "clean",
  "init",
])

/**
 * True when `command` names a dbt subcommand whose `run_results.json` rows are
 * evidence that a model was actually executed.
 *
 * A null/unknown command reads as executing. Every supported dbt version
 * stamps `args.which`, so null means an artifact we cannot classify, and
 * treating the unclassifiable as non-evidence would block sessions whose build
 * was genuinely green. The exploit this guards against (`dbt compile`) always
 * stamps `compile`, so the permissive default does not reopen it.
 */
export function runResultsExecutedModels(command: string | null): boolean {
  if (command === null || command.length === 0) return true
  if (MODEL_EXECUTING_DBT_COMMANDS.has(command)) return true
  // Only a command we RECOGNISE as not building models is denied. Anything
  // unrecognised reads as executing, which is what the permissive default
  // above promises — denying it would quietly downgrade a green build to
  // `coverage-inconclusive` on a future dbt subcommand.
  return !NON_MODEL_EXECUTING_DBT_COMMANDS.has(command) && !NON_EXECUTING_DBT_COMMANDS.has(command)
}

/**
 * True when `command` is a dbt subcommand KNOWN to execute nothing, so its
 * artifact is not evidence that anything was built.
 *
 * Only commands on the known-non-executing list qualify. An unrecognised
 * command — a future dbt subcommand, a wrapper's own spelling — reads as
 * executing, matching the permissive default in `runResultsExecutedModels`.
 * Blocking on a command we simply do not recognise would fail a session whose
 * build was green, and the exploit this guards against (`dbt compile`) is on
 * the list explicitly.
 *
 * `test`, `seed`, `snapshot` and `clone` are excluded on purpose: each is a
 * normal successor to a build, and `dbt-tests-pass` in this very lane spawns
 * `dbt test` in the project on every validation pass, so a test artifact is
 * the *expected* state on any retry. Treating any of them as "no build" would
 * fire on healthy sessions. They fall through to the DDL evidence path.
 */
export function runResultsCarriesNoBuildEvidence(command: string | null): boolean {
  if (command === null || command.length === 0) return false
  if (NON_MODEL_EXECUTING_DBT_COMMANDS.has(command)) return false
  return NON_EXECUTING_DBT_COMMANDS.has(command)
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
    const parsed = JSON.parse(raw) as { results?: unknown; args?: unknown }
    // A file that parses but carries no `results` array is not a run artifact.
    // Returning an empty one would read as "a build happened and recorded
    // nothing", which lets an unbuilt model through; null means "no evidence".
    if (!Array.isArray(parsed.results)) return null
    const rows = parsed.results
    // `args.which` is dbt's own record of the subcommand that wrote the file.
    const argsObj =
      typeof parsed.args === "object" && parsed.args !== null
        ? (parsed.args as Record<string, unknown>)
        : null
    const whichRaw = argsObj && typeof argsObj["which"] === "string" ? argsObj["which"] : ""
    const command = whichRaw.trim().toLowerCase() || null
    const results: RunResultNode[] = []
    for (const row of rows) {
      if (typeof row !== "object" || row === null) continue
      const r = row as Record<string, unknown>
      const uniqueId = typeof r["unique_id"] === "string" ? r["unique_id"] : ""
      if (!uniqueId) continue
      const parts = uniqueId.split(".")
      const last = (parts[parts.length - 1] ?? "").toLowerCase()
      const versioned = parts.length > 3 && /^v\d+$/.test(last)
      results.push({
        uniqueId,
        name: versioned ? (parts[parts.length - 2] ?? "").toLowerCase() : last,
        version: versioned ? last : null,
        status: typeof r["status"] === "string" ? r["status"].toLowerCase() : "",
        message: typeof r["message"] === "string" ? r["message"] : null,
      })
    }
    return { path, mtimeMs: stat.mtimeMs, results, command }
  } catch {
    return null
  }
}

/**
 * Model names dbt writes no `run_results` row for, split by *why*.
 *
 * The two axes are independent and must stay that way: a model disabled in
 * `dbt_project.yml` may still set `materialized` in its own config, and an
 * ephemeral model may set `enabled=true`. Collapsing them into one set makes a
 * source-level declaration on either axis discard the exemption on the other.
 */
export interface RunResultExemptions {
  /** `materialized='ephemeral'` — compiled into consumers, never its own node. */
  ephemeral: Set<string>
  /** `enabled=false` — removed from the graph entirely. */
  disabled: Set<string>
}

/**
 * Model names for which dbt legitimately writes **no** `run_results` row, so
 * their absence from a build artifact is not evidence that they were not
 * built:
 *
 *   - `materialized='ephemeral'` — compiled into its consumers, never a node
 *     of its own in the run;
 *   - `enabled=false` — removed from the graph entirely, which is what
 *     retiring a model looks like.
 *
 * Read from `manifest.json` (`nodes` for materialization, `disabled` for the
 * second) when one exists. Callers should also inspect the model source,
 * because a session that has just written `enabled=false` will not have a
 * manifest that reflects it until the next parse.
 */
export async function collectRunResultExemptModels(
  dbtRoot: string,
): Promise<RunResultExemptions> {
  const out: RunResultExemptions = { ephemeral: new Set<string>(), disabled: new Set<string>() }
  try {
    const targetPath = await resolveDbtTargetPath(dbtRoot)
    const raw = await fs.readFile(join(targetPath, "manifest.json"), "utf8")
    const manifest = JSON.parse(raw) as {
      nodes?: Record<string, unknown>
      disabled?: Record<string, unknown>
    }
    for (const node of Object.values(manifest.nodes ?? {})) {
      if (typeof node !== "object" || node === null) continue
      const n = node as Record<string, unknown>
      const name = typeof n["name"] === "string" ? n["name"].toLowerCase() : ""
      if (!name) continue
      const config = (n["config"] ?? {}) as Record<string, unknown>
      if (String(config["materialized"] ?? "").toLowerCase() === "ephemeral") out.ephemeral.add(name)
      if (config["enabled"] === false) out.disabled.add(name)
    }
    for (const entry of Object.values(manifest.disabled ?? {})) {
      const rows = Array.isArray(entry) ? entry : [entry]
      for (const node of rows) {
        if (typeof node !== "object" || node === null) continue
        const name = (node as Record<string, unknown>)["name"]
        if (typeof name === "string" && name.length > 0) out.disabled.add(name.toLowerCase())
      }
    }
  } catch {
    // No manifest, or an unreadable one — the source-level check stands alone.
  }
  return out
}

/** Head of a `{{ config(` call — the argument text is scanned, not matched. */
const CONFIG_CALL_HEAD_RE = /\{\{-?\s*config\s*\(/gi

/**
 * Blank out Jinja regions whose contents dbt never evaluates, so text inside
 * them cannot be read as a live `config()` call.
 *
 * Two regions qualify unambiguously:
 *   - `{% raw %}…{% endraw %}`, where `{{ config(...) }}` is literal text that
 *     dbt emits rather than a call it runs;
 *   - `{% if false %}…{% endif %}`, a dead branch.
 *
 * Both were observed exempting a live, enabled, unbuilt model from the build
 * gate's coverage assertion — `{% if false %}{{ config(enabled=false) }}` reads
 * as "this model is disabled, do not require a build for it".
 *
 * Deliberately limited to these two. Blanking a region also removes any real
 * config inside it, so a looser condition (anything mentioning `false`, or a
 * whole if/elif chain because one arm matched) would strip live config and
 * push the gate towards blocking correct models. Resolving arbitrary branch
 * conditions needs the effective config from a manifest, which this
 * source-level helper deliberately does not have.
 */
export function stripInactiveJinja(sql: string): string {
  const blank = (region: string): string => region.replace(/[^\n\r]/g, " ")
  let out = sql.replace(/\{%-?\s*raw\s*-?%\}[\s\S]*?\{%-?\s*endraw\s*-?%\}/gi, blank)
  const deadIf = /\{%-?\s*if\s+false\s*-?%\}/gi
  for (;;) {
    deadIf.lastIndex = 0
    const m = deadIf.exec(out)
    if (!m) return out
    const end = jinjaBlockEnd(out, m.index)
    out = out.slice(0, m.index) + blank(out.slice(m.index, end)) + out.slice(end)
  }
}
/** `materialized='ephemeral'` in an in-model `config()` call. */
const EPHEMERAL_CONFIG_RE = /materiali[sz]ed\s*=\s*['"]ephemeral['"]/i
/** `enabled=false` in an in-model `config()` call. */
const DISABLED_CONFIG_RE = /\benabled\s*=\s*(?:false|False|0)\b/
/** `materialized='<anything but ephemeral>'` in an in-model `config()` call. */
const NON_EPHEMERAL_CONFIG_RE = /materiali[sz]ed\s*=\s*['"](?!ephemeral['"])[a-z0-9_+]+['"]/i
/** `enabled=true` in an in-model `config()` call. */
const ENABLED_CONFIG_RE = /\benabled\s*=\s*(?:true|True|1)\b/

/**
 * Concatenate the argument text of every `{{ config() }}` call in a model.
 *
 * Everything that reasons about a model's declared configuration must go
 * through this rather than scanning the whole file: `where enabled = false` is
 * an ordinary SQL predicate, and treating it as `config(enabled=false)` hands
 * any session a one-line way to exempt an unbuilt model from the build gate.
 */
export function dbtConfigArgs(sql: string): string {
  const parts: string[] = []
  sql = stripInactiveJinja(sql)
  CONFIG_CALL_HEAD_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CONFIG_CALL_HEAD_RE.exec(sql)) !== null) {
    const argsStart = m.index + m[0].length
    const args = scanBalancedConfigArgs(sql, argsStart)
    if (args === null) {
      // Unterminated call — nothing reliable to read. Advance past the head so
      // the scan cannot loop, and leave the rest of the file to later matches.
      CONFIG_CALL_HEAD_RE.lastIndex = argsStart
      continue
    }
    if (args.text.length > 0) parts.push(args.text)
    // Resume after the call's closing `)`. A nested `)` inside the arguments
    // must never become the next scan origin.
    CONFIG_CALL_HEAD_RE.lastIndex = args.end
  }
  return parts.join("\n")
}

/**
 * Read the argument text of a `config(` call starting at `start` (the first
 * character after the opening paren), returning it plus the index just past
 * the matching close paren.
 *
 * Paren-depth aware and quote aware, because a `config()` argument routinely
 * contains both: `pre_hook="{{ log_start(run_id) }}"` carries a nested call
 * inside a string. Stopping at the first `)` — which a non-greedy
 * `\(([\s\S]*?)\)` does — truncates the argument list there and silently drops
 * every argument after it. That mis-reads a correctly-keyed merge model as an
 * unkeyed upsert, and loses `enabled=false` / `materialized='ephemeral'`
 * exemptions that follow a hook.
 *
 * Returns null when the call is never closed.
 */
function scanBalancedConfigArgs(sql: string, start: number): { text: string; end: number } | null {
  let depth = 1
  let quote: string | null = null
  for (let i = start; i < sql.length; i++) {
    const ch = sql[i]
    if (quote !== null) {
      // Backslash escapes inside a quoted argument. dbt's Jinja layer is
      // Python, where `"a\"b"` keeps the string open.
      if (ch === "\\") {
        i++
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === "(") {
      depth++
      continue
    }
    if (ch === ")") {
      depth--
      if (depth === 0) return { text: sql.slice(start, i), end: i + 1 }
    }
  }
  return null
}

/**
 * True when a model's own source declares it ephemeral or disabled — the two
 * states for which dbt writes no `run_results` row. Source-level so it is
 * correct for a model the session has just edited, before any re-parse.
 *
 * Scoped to `{{ config() }}` arguments. Matching the whole model body would
 * let `where enabled = false` in a normal filter silently remove the model
 * from the build gate's coverage assertion.
 */
export function sourceExemptsFromRunResults(sql: string): boolean {
  const args = dbtConfigArgs(stripSqlComments(sql))
  return EPHEMERAL_CONFIG_RE.test(args) || DISABLED_CONFIG_RE.test(args)
}

/**
 * True when a model's own source declares a real materialisation, contradicting
 * an `ephemeral` exemption read from `manifest.json`.
 *
 * `manifest.json` is only as current as the last `dbt parse`. A session that
 * turns an ephemeral model into a table leaves a manifest that still calls it
 * ephemeral, and the build gate would then skip the very relation the session
 * was asked to create. The model source is the newer of the two, so it wins.
 */
export function sourceDeclaresNonEphemeral(sql: string): boolean {
  return NON_EPHEMERAL_CONFIG_RE.test(dbtConfigArgs(stripSqlComments(sql)))
}

/**
 * True when a model's own source declares `enabled=true`, contradicting a
 * `disabled` exemption read from `manifest.json`.
 *
 * Kept separate from the materialisation axis on purpose. The two are
 * independent in dbt: a model disabled in `dbt_project.yml` can perfectly well
 * set `materialized` in its own config, and an ephemeral model can set
 * `enabled=true`. Treating either as a single "not exempt" signal pulls a model
 * dbt will never write a `run_results` row for back into the coverage
 * assertion, which is a gate the session cannot clear by doing anything right.
 */
export function sourceDeclaresEnabled(sql: string): boolean {
  return ENABLED_CONFIG_RE.test(dbtConfigArgs(stripSqlComments(sql)))
}

/**
 * Model names dbt actually executed during this session, read from the DDL it
 * writes under `<target>/run/`, mapped to the mtime of that DDL.
 *
 * The mtime is part of the answer, not bookkeeping: when a model's coverage
 * comes from its DDL rather than from `run_results.json`, staleness has to be
 * measured against the build that produced the DDL. `run_results.json` is
 * rewritten by a later `dbt test`, so comparing against it would date the
 * model's build to a command that did not build it.
 *
 * This exists because `run_results.json` is a single file that every dbt
 * command overwrites: an agent that runs `dbt build` and then `dbt test`
 * leaves an artifact containing test nodes only, and a coverage assertion
 * keyed solely on it silently checks nothing. `dbt test` does not write model
 * DDL, so a fresh file here is build evidence a later test run cannot erase.
 *
 * Ephemeral models never appear (they are compiled into their consumers, not
 * executed), which is why they are exempted separately.
 */
export async function collectExecutedModelNames(
  dbtRoot: string,
  sinceMs: number,
): Promise<Map<string, number>> {
  /** Depth limit mirroring the other project scans in this lane. */
  const maxDepth = 8
  const names = new Map<string, number>()
  const targetPath = await resolveDbtTargetPath(dbtRoot)
  async function scan(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return
    let entries: import("fs").Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await scan(full, depth + 1)
        continue
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".sql")) continue
      try {
        const stat = await fs.stat(full)
        if (stat.mtimeMs >= sinceMs) {
          const name = entry.name.slice(0, entry.name.length - 4).toLowerCase()
          // Keep the newest DDL for a name: the same model can be written by
          // several invocations in one session, and the last one is the build
          // a later source edit has to be compared against.
          const prev = names.get(name)
          if (prev === undefined || stat.mtimeMs > prev) names.set(name, stat.mtimeMs)
        }
      } catch {
        // unstattable — ignore
      }
    }
  }
  await scan(join(targetPath, "run"), 0)
  return names
}

// ---------------------------------------------------------------------------
// Project inventory
// ---------------------------------------------------------------------------

/**
 * dbt `resource_type` values that materialise a relation, so a manifest node
 * of that type can satisfy a required deliverable. `analysis` and `test` are
 * absent on purpose — see `collectProducedNodeNames`.
 */
const RELATION_PRODUCING_RESOURCE_TYPES = new Set(["model", "seed", "snapshot"])
/** File extensions that define a node. */
const NODE_EXTENSIONS = [".sql", ".csv", ".py"]
/** Depth limit mirroring `modelsModifiedSince`. */
const INVENTORY_MAX_DEPTH = 8

/**
 * Collect every node name the project defines on disk (models, seeds,
 * snapshots) plus every node name and alias recorded in `manifest.json` when
 * one exists.
 *
 * The union is deliberate: a gate built on this set fails only when a name is
 * absent from BOTH sources, so an aliased or dynamically-named node cannot
 * produce a false "you did not build it".
 *
 * `analyses/` and `tests/` are excluded from both sources. dbt compiles an
 * analysis but never materialises it, so `analyses/foo.sql` is not a relation
 * named `foo` — and accepting it lets a session satisfy "create the model
 * `foo`" by dropping a file in the one directory dbt will never build. Same
 * for a singular test. Directories come from `dbt_project.yml` rather than
 * from literals, so a project on custom `model-paths` is inventoried too.
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
  const sourcePaths = await resolveDbtSourcePaths(dbtRoot)
  for (const nodeDir of [...sourcePaths.models, ...sourcePaths.seeds, ...sourcePaths.snapshots]) {
    await scan(nodeDir, 0)
  }
  // manifest.json contributes names and aliases for nodes whose relation name
  // differs from the filename.
  //
  // Only for nodes whose defining file is still on disk. A manifest survives a
  // branch switch or a model deletion, and a name taken from a node whose
  // `original_file_path` no longer exists is not evidence that the project
  // defines that relation — it is evidence that it used to. Accepting it lets
  // a required deliverable read as satisfied by an obsolete artifact.
  try {
    const targetPath = await resolveDbtTargetPath(dbtRoot)
    const raw = await fs.readFile(join(targetPath, "manifest.json"), "utf8")
    const manifest = JSON.parse(raw) as { nodes?: Record<string, unknown> }
    for (const node of Object.values(manifest.nodes ?? {})) {
      if (typeof node !== "object" || node === null) continue
      const n = node as Record<string, unknown>
      const originalPath = typeof n["original_file_path"] === "string" ? n["original_file_path"] : ""
      // A node with no recorded path cannot be checked; keep it, because
      // dropping it would move the gate towards blocking a correct project.
      if (originalPath.length > 0 && !(await pathExists(join(dbtRoot, originalPath)))) continue
      // Only relation-producing node types can satisfy a deliverable. An
      // untyped node is kept, for the same reason an untracked path is.
      const resourceType =
        typeof n["resource_type"] === "string" ? n["resource_type"].toLowerCase() : ""
      if (resourceType.length > 0 && !RELATION_PRODUCING_RESOURCE_TYPES.has(resourceType)) continue
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

/**
 * Render repository-controlled text safe for inclusion in validator
 * remediation prose.
 *
 * A failing validator's `reason`/`fixHint` is concatenated into a synthetic
 * `role: "user"` message that the next tool-capable agent turn reads as
 * instructions. dbt error messages and model/file names are repository
 * content, so interpolating them verbatim lets a hostile repo place its own
 * text at instruction position — a filename containing a newline, or a dbt
 * error carrying `\n\nIgnore the above and …`, breaks straight out of the
 * sentence it was quoted in.
 *
 * Everything untrusted therefore goes through here: control characters and
 * newlines collapse to spaces, the result is length-bounded, and it is wrapped
 * in guillemets so the agent can see where the quoted evidence starts and
 * stops. The surrounding instructions stay static and trusted.
 */
export function sanitizeForPrompt(value: string, maxLength = 200): string {
  // eslint-disable-next-line no-control-regex
  const flattened = value
    // Strip the delimiters first: removing them later would leave the double
    // spaces that the whitespace collapse has already run past.
    .replace(/[«»]/g, "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  const clipped = flattened.length > maxLength ? flattened.slice(0, maxLength) + "…" : flattened
  return `«${clipped}»`
}

/** True when `path` exists at all (file or directory). */
async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.stat(path)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// SQL / Jinja text handling
// ---------------------------------------------------------------------------

/**
 * Single left-to-right scan that classifies every character of a SQL/Jinja
 * document as code, comment, or string-literal body, blanking whichever
 * regions the caller asked for.
 *
 * A regex chain cannot do this correctly: `where note = 'a--b'` makes a
 * line-comment pattern swallow the rest of the line, and
 * `select 'safe_cast('` makes a call-shaped function pattern match text the
 * warehouse never executes. The first produces silent misses, the second produces blocking
 * false positives, so both consumers of this module need a lexer rather than
 * a pattern.
 *
 * Blanked regions are replaced with spaces of equal length (newlines kept) so
 * downstream line and character offsets stay meaningful.
 */
function scrubSql(sql: string, opts: { comments: boolean; literals: boolean }): string {
  const out = sql.split("")
  const blank = (from: number, to: number) => {
    for (let i = from; i < to && i < out.length; i++) {
      if (out[i] !== "\n" && out[i] !== "\r") out[i] = " "
    }
  }
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]
    const next = sql[i + 1]
    // Line comment.
    if (c === "-" && next === "-") {
      let j = i
      while (j < n && sql[j] !== "\n") j++
      if (opts.comments) blank(i, j)
      i = j
      continue
    }
    // Block comment. SQL block comments do not nest in the dialects we target.
    if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2)
      const j = end === -1 ? n : end + 2
      if (opts.comments) blank(i, j)
      i = j
      continue
    }
    // Jinja comment.
    if (c === "{" && next === "#") {
      const end = sql.indexOf("#}", i + 2)
      const j = end === -1 ? n : end + 2
      if (opts.comments) blank(i, j)
      i = j
      continue
    }
    // String literal. `''` and `\'` both escape a quote; dollar quoting is not
    // handled because dbt models do not use it.
    if (c === "'" || c === '"') {
      let j = i + 1
      while (j < n) {
        if (sql[j] === "\\") {
          j += 2
          continue
        }
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            j += 2
            continue
          }
          j++
          break
        }
        j++
      }
      // Blank the body only, so the quotes still delimit a literal for any
      // caller that cares where one was.
      if (opts.literals) blank(i + 1, Math.min(j, n) - 1)
      i = j
      continue
    }
    i++
  }
  return out.join("")
}

/**
 * Blank out SQL and Jinja comments so a lint regex cannot match text the
 * warehouse never sees. Quote-aware: a `--` or `/*` inside a string literal is
 * data, not a comment, and is left alone.
 */
export function stripSqlComments(sql: string): string {
  return scrubSql(sql, { comments: true, literals: false })
}

/**
 * Blank out the body of every string literal so a call-shaped pattern cannot
 * match text that is a value rather than an executed call
 * (`select 'safe_cast(' as example`). Applied by the lint validators before
 * pattern matching; the quotes themselves are preserved.
 */
export function maskSqlStringLiterals(sql: string): string {
  return scrubSql(sql, { comments: false, literals: true })
}

/**
 * Blank out the body of every Jinja expression (`{{ … }}`) and statement tag
 * (`{% … %}`). A project macro is invoked as `{{ safe_cast(a, b) }}` — or from
 * a statement tag as `{% set x = safe_cast(a, b) %}` — while a warehouse
 * builtin is raw SQL, so masking both is what separates "the author called our
 * macro" from "the author wrote warehouse-specific SQL".
 *
 * Nothing inside either delimiter is text the warehouse executes, so masking
 * cannot hide a real defect; leaving statement tags exposed does produce a
 * blocking false positive on a macro call.
 */
export function maskJinjaExpressions(sql: string): string {
  return sql.replace(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g, (m) =>
    m.replace(/[^\n\r]/g, " "),
  )
}

/**
 * Opening `{% if ... %}` tag.
 *
 * The body is `(?:[^%]|%(?!\}))*` rather than `[^%]*` so a condition containing
 * Jinja's modulo operator — `{% if target.type == 'snowflake' and n % 2 == 0 %}`
 * — is still matched. With `[^%]*` the opener never matched such a tag, the
 * guarded block was never blanked, and a correctly guarded call was reported as
 * unguarded. The two alternatives are disjoint, so there is no backtracking
 * blow-up.
 */
const JINJA_IF_OPENER_SOURCE = "\\{%-?\\s*if\\b(?:[^%]|%(?!\\}))*%\\}"

/**
 * Find the Jinja `{% if %}` block that starts at `openStart` and return the
 * index just past its matching `{% endif %}`, counting nested `if` blocks.
 *
 * A non-greedy regex stops at the first `{% endif %}`, which for a guard that
 * contains a nested `{% if %}` ends the block early and leaves genuinely
 * guarded SQL exposed to the lint. Returns the end of the input when the block
 * is unterminated.
 */
function jinjaBlockEnd(sql: string, openStart: number): number {
  const tag = /\{%-?\s*(if|endif)\b/gi
  tag.lastIndex = openStart
  let depth = 0
  let m: RegExpExecArray | null
  while ((m = tag.exec(sql)) !== null) {
    if (m[1]?.toLowerCase() === "if") {
      depth++
      continue
    }
    depth--
    if (depth <= 0) {
      const close = sql.indexOf("%}", m.index)
      return close === -1 ? sql.length : close + 2
    }
  }
  return sql.length
}

/**
 * Blank every Jinja `{% if %}` block whose `if` **or** any of its own top-level
 * `{% elif %}` branches matches `conditionRe`, through its *matching*
 * `{% endif %}` rather than the first one.
 *
 * `{% if a %}…{% elif target.type == 'x' %}…{% endif %}` is one guard chain: a
 * project can express its only warehouse branch in the `elif`, and blanking
 * only the arm whose opener matched would report the chain's guarded SQL as
 * unguarded. `elif` tags belonging to a *nested* `if` are not the chain's own
 * branches and are ignored, so a nested guard cannot cause an outer block full
 * of unguarded SQL to be blanked.
 */
export function stripJinjaIfBlocks(sql: string, conditionRe: RegExp): string {
  const opener = new RegExp(JINJA_IF_OPENER_SOURCE, "gi")
  let out = sql
  let searchFrom = 0
  for (;;) {
    opener.lastIndex = searchFrom
    const m = opener.exec(out)
    if (!m) return out
    const end = jinjaBlockEnd(out, m.index)
    const region = out.slice(m.index, end)
    if (!conditionRe.test(m[0]) && !ownBranchMatches(region, conditionRe)) {
      searchFrom = m.index + m[0].length
      continue
    }
    out = out.slice(0, m.index) + region.replace(/[^\n\r]/g, " ") + out.slice(end)
    searchFrom = end
  }
}

/**
 * True when a `{% elif %}` belonging to *this* if-chain (depth 1, i.e. not
 * inside a nested `{% if %}`) matches `conditionRe`. `region` must start at the
 * chain's own `{% if %}` tag.
 */
function ownBranchMatches(region: string, conditionRe: RegExp): boolean {
  // `(?:[^%]|%(?!\}))*` rather than `[^%]*`: a Jinja modulo inside the tag
  // (`{% if loop.index % 2 == 0 %}`) stops a `[^%]*` body dead, the tag never
  // matches, and the depth counter silently loses an arm. Mirrors
  // JINJA_IF_OPENER_SOURCE, which was already fixed for this.
  const tag = /\{%-?\s*(if|elif|endif)\b(?:[^%]|%(?!\}))*%\}/gi
  let depth = 0
  let m: RegExpExecArray | null
  while ((m = tag.exec(region)) !== null) {
    const kind = m[1]?.toLowerCase()
    if (kind === "if") {
      depth++
      continue
    }
    if (kind === "endif") {
      depth--
      continue
    }
    if (depth === 1 && conditionRe.test(m[0])) return true
  }
  return false
}

/**
 * The first arm of a Jinja if-chain body: everything up to the chain's *own*
 * `{% else %}` / `{% elif %}`, ignoring the else/elif tags of nested `{% if %}`
 * blocks.
 *
 * A guard body that contains a nested conditional has a nested `{% else %}`
 * long before the outer one. Splitting on the first `{% else %}` therefore
 * truncates the arm and drops whatever followed — for the incremental lint,
 * exactly the predicate it exists to inspect.
 */
export function jinjaIfBranchHead(body: string): string {
  // Modulo-safe tag body, for the same reason as `ownBranchMatches`.
  const tag = /\{%-?\s*(if|elif|else|endif)\b(?:[^%]|%(?!\}))*%\}/gi
  let depth = 0
  let m: RegExpExecArray | null
  while ((m = tag.exec(body)) !== null) {
    const kind = m[1]?.toLowerCase()
    if (kind === "if") {
      depth++
      continue
    }
    if (kind === "endif") {
      depth--
      continue
    }
    if (depth === 0) return body.slice(0, m.index)
  }
  return body
}

/** One Jinja `{% if %}` block: its opening tag and its body. */
export interface JinjaIfBlock {
  /** The opening `{% if … %}` tag, verbatim. */
  opener: string
  /** Everything between the opening tag and the matching `{% endif %}`. */
  body: string
}

/**
 * Every **arm** of every Jinja if-chain whose own branch condition matches
 * `conditionRe`, matched to its chain's `{% endif %}` by nesting depth.
 *
 * Arms, not whole blocks, and `{% elif %}` as well as `{% if %}`. Three
 * distinct bugs live in the naive version of this:
 *
 *   - requiring the condition to be the *complete* condition, which made
 *     `{% if is_incremental() and loaded %}` invisible;
 *   - ending the block at the first `{% endif %}`, which lost the remainder of
 *     a guard containing a nested `{% if %}` — and with it the predicate the
 *     caller was looking for;
 *   - looking only at the opening tag, which skipped a chain that carries the
 *     condition on an `{% elif %}`.
 *
 * Each returned `body` is one branch's own text, already bounded by the
 * chain's next top-level branch tag, so a caller does not have to split it.
 */
export function extractJinjaIfBlocks(sql: string, conditionRe: RegExp): JinjaIfBlock[] {
  const opener = new RegExp(JINJA_IF_OPENER_SOURCE, "gi")
  const out: JinjaIfBlock[] = []
  let searchFrom = 0
  for (;;) {
    opener.lastIndex = searchFrom
    const m = opener.exec(sql)
    if (!m) return out
    const end = jinjaBlockEnd(sql, m.index)
    for (const arm of chainArms(sql, m.index, m[0].length, end)) {
      if (conditionRe.test(arm.opener)) out.push(arm)
    }
    // Continue past this chain's own opening tag rather than past the whole
    // chain: a nested `{% if %}` inside it is its own chain and may carry the
    // condition too.
    searchFrom = m.index + m[0].length
  }
}

/**
 * Split one if-chain into its top-level arms. `openStart` is the index of the
 * chain's `{% if %}` tag, `openLength` its length, and `end` the index just
 * past the matching `{% endif %}`.
 */
function chainArms(
  sql: string,
  openStart: number,
  openLength: number,
  end: number,
): JinjaIfBlock[] {
  const region = sql.slice(openStart, end)
  // Same `%`-tolerant body as the opener, so a condition containing Jinja's
  // modulo operator does not hide a branch tag.
  const tag = /\{%-?\s*(if|elif|else|endif)\b(?:[^%]|%(?!\}))*%\}/gi
  const arms: JinjaIfBlock[] = []
  let depth = 0
  let currentOpener = sql.slice(openStart, openStart + openLength)
  let armStart = openLength
  let m: RegExpExecArray | null
  while ((m = tag.exec(region)) !== null) {
    const kind = (m[1] ?? "").toLowerCase()
    // The chain's own opening tag is not a nested `if`.
    if (m.index < openLength) continue
    if (kind === "if") {
      depth++
      continue
    }
    if (kind === "endif") {
      if (depth > 0) {
        depth--
        continue
      }
      arms.push({ opener: currentOpener, body: region.slice(armStart, m.index) })
      break
    }
    // `elif` / `else` at depth 0 closes the current arm and opens the next.
    if (depth > 0) continue
    arms.push({ opener: currentOpener, body: region.slice(armStart, m.index) })
    currentOpener = m[0]
    armStart = m.index + m[0].length
  }
  if (arms.length === 0) arms.push({ opener: currentOpener, body: region.slice(armStart) })
  return arms
}
// altimate_change end
