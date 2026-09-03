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
import { createHash } from "crypto"
import { join, sep, basename, resolve } from "path"

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
    // Exclusive only while the pinned file is READABLE. A stale or misspelled
    // override would otherwise return no contract at all, and all three
    // contract-driven gates skip in silence — the exact failure this lane
    // exists to remove. An unreadable pin falls through to auto-discovery.
    if (found) return [found]
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
  /**
   * Subset of `models` the task asked to be MODIFIED (update/fix/rename/…)
   * rather than created. A completion gate that treats mere pre-session
   * existence as satisfying a required deliverable must not do so for a name
   * in this set — existence proves nothing about whether the requested change
   * happened. Only populated from prose requirement lines (tier 3), where a
   * verb is available to classify; empty for the declaration and
   * deliverables-section tiers, which carry no verb to read.
   */
  modificationModels: string[]
  /**
   * Subset of `files` the task asked to be MODIFIED, same rule as
   * `modificationModels` but for a literal file path rather than a relation
   * name — "Update the file `models/schema.yml`" names only a file, never a
   * model, so the modification signal for it has to live in its own set
   * rather than piggy-back on `modificationModels`.
   */
  modificationFiles: string[]
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
 *
 * `update`, `modify` and `change` are the ordinary way a task asks for work on
 * an existing relation ("Update the model `orders` so it …"). Without them the
 * document names its deliverable literally and yet yields no contract, so both
 * contract gates go inapplicable and a zero-write session finishes clean —
 * precisely the blind spot this lane exists to close. They are bounded the same
 * way: `chang(e|es|ed|ing)` cannot reach `changelog`, and `updat(e|es|ed|ing)`
 * cannot reach a longer word.
 */
const REQUIREMENT_VERB_RE =
  /\b(?:creat(?:e|es|ed|ing)|build(?:s|ing)?|built|produc(?:e|es|ed|ing)|implement(?:s|ed|ing)?|deliver(?:s|ed|ing)?|materiali[sz](?:e|es|ed|ing)|generat(?:e|es|ed|ing)|writ(?:e|es|ing)|wrote|written|deploy(?:s|ed|ing)?|add(?:s|ed|ing)?|renam(?:e|es|ed|ing)|convert(?:s|ed|ing)?|fix(?:es|ed|ing)?|repair(?:s|ed|ing)?|updat(?:e|es|ed|ing)|modif(?:y|ies|ied|ying)|chang(?:e|es|ed|ing))\b/i
/**
 * Modification verbs — the subset of `REQUIREMENT_VERB_RE` that asks for a
 * change to something that already exists, rather than its creation.
 *
 * A model already on disk satisfies "create the model `orders`" whenever it
 * was delivered in an earlier session — that escape hatch is deliberate (see
 * `dbt-nothing-built.ts`). It must NOT satisfy "update the model `orders`":
 * the task is asking for a change, and pre-existing presence proves nothing
 * about whether this session made it. Tagging these verbs lets the
 * nothing-built gate demand session evidence (authorship or a fresh build)
 * for a modification contract instead of accepting mere existence.
 */
const MODIFICATION_VERB_RE =
  /\b(?:updat(?:e|es|ed|ing)|modif(?:y|ies|ied|ying)|chang(?:e|es|ed|ing)|fix(?:es|ed|ing)?|repair(?:s|ed|ing)?|renam(?:e|es|ed|ing)|convert(?:s|ed|ing)?)\b/i
/**
 * Rename verb — the subset of `MODIFICATION_VERB_RE` whose requirement line
 * names two artifacts (source and destination) but only one — the
 * destination — is actually required to exist afterwards. See
 * `requirementHead`'s caller in `extractRequiredDeliverables`.
 */
const RENAME_VERB_RE = /^renam/i
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
      return { ...collected, modificationModels: [], modificationFiles: [], source: "declaration" }
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
    return { ...section, modificationModels: [], modificationFiles: [], source: "deliverables-section" }
  }

  // Tier 3 — requirement lines in prose.
  const proseTokens: string[] = []
  const modificationTokens: string[] = []
  for (const line of lines) {
    const verb = REQUIREMENT_VERB_RE.exec(line)
    if (!verb) continue
    if (!DELIVERABLE_NOUN_RE.test(line)) continue
    // "Do not create the model `legacy_orders`" carries a creation verb and an
    // artifact noun, but names something that must NOT exist. Recording it as
    // required makes the deliverable gate reject the correct implementation
    // forever, so a negated verb disqualifies the whole line.
    if (verbIsNegated(line, verb.index)) continue
    let spans = inlineCodeSpans(requirementHead(line, verb.index))
    // "Rename `old_orders` to `new_orders`" names two artifacts, but only the
    // destination is required to exist once the rename is done — the source
    // is expected to be GONE. `to` is not a qualifier `requirementHead` cuts
    // on, so both spans survive; keeping both makes the deliverable gate
    // reject a correct rename forever for "missing" the source name. Keep
    // only the last span (the destination), and only when there is more than
    // one — a rename line naming a single artifact is unaffected.
    if (RENAME_VERB_RE.test(verb[0]) && spans.length > 1) {
      spans = [spans[spans.length - 1]!]
    }
    proseTokens.push(...spans)
    if (MODIFICATION_VERB_RE.test(verb[0])) modificationTokens.push(...spans)
  }
  const prose = collectDeliverableTokens(proseTokens)
  if (prose.models.length > 0 || prose.files.length > 0) {
    const modificationTokenTotals = collectDeliverableTokens(modificationTokens)
    const modificationModelSet = new Set(modificationTokenTotals.models)
    const modificationFileSet = new Set(modificationTokenTotals.files)
    return {
      ...prose,
      modificationModels: prose.models.filter((m) => modificationModelSet.has(m)),
      modificationFiles: prose.files.filter((f) => modificationFileSet.has(f)),
      source: "requirement-lines",
    }
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

/**
 * Top-level path segments that never produce a dbt relation, even for a
 * `.sql`/`.csv` file within them. A required `macros/generate_schema_name.sql`
 * or `analyses/adhoc.sql` names a real, checkable file, but deriving a
 * "required model" from its stem makes the deliverable gate permanently
 * reject the correct macro/analysis-only implementation for lacking a model
 * that dbt was never going to build.
 *
 * A conservative, directory-name heuristic rather than a project-config-aware
 * one: this helper is pure text with no filesystem access, so it cannot
 * consult `model-paths`/`macro-paths`. It still closes the concrete failure
 * mode (a task naming a macro or analysis file) without guessing at custom
 * source-path configuration it cannot see.
 */
const NON_RELATION_TOP_SEGMENTS = new Set(["macros", "macro", "analyses", "analysis", "tests", "test", "docs"])

/** Classify raw tokens into model identifiers and literal file paths. */
function collectDeliverableTokens(tokens: string[]): { models: string[]; files: string[] } {
  const models: string[] = []
  const files: string[] = []
  for (const raw of tokens) {
    // Normalise Windows separators before classification. `FILE_PATH_RE` and
    // the identifier fallback are both `/`-only; a task written with
    // `models\marts\orders.sql` matches neither, so a Windows-authored task
    // whose only requirement is a backslash path yields NO contract at all —
    // both completion gates read the workspace as having no literal contract
    // and a zero-write session finishes clean. The normalised form is also
    // what gets returned, so downstream existence checks stay consistent
    // with what was recorded here.
    const token = raw.trim().replace(/[.,;:]+$/, "").replace(/\\/g, "/")
    if (!token) continue
    if (token.includes("/") && FILE_PATH_RE.test(token)) {
      if (!files.includes(token)) files.push(token)
      // A required `models/marts/orders.sql` also requires the model `orders`.
      // A required `models/schema.yml` requires a file and no relation, so no
      // model name is derived from it. Nor is one derived from a path whose
      // top-level directory never produces a relation (see
      // `NON_RELATION_TOP_SEGMENTS`).
      const topSegment = token.split("/")[0]?.toLowerCase() ?? ""
      if (/\.(?:sql|csv)$/i.test(token) && !NON_RELATION_TOP_SEGMENTS.has(topSegment)) {
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
    // Anchored at column 0. `target-path` is a project-level key, and a
    // leading `\s*` also selects a same-named key nested under `vars:` or
    // `models:`. The validators would then look for `run_results.json` under
    // that unrelated value, find nothing, and block a genuinely green build.
    const m = /^target-path[ \t]*:[ \t]*(?:"([^"\n]*)"|'([^'\n]*)'|([^#\n]*?))[ \t]*(?:#.*)?$/m.exec(
      yml,
    )
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
/**
 * Index of the `]` that closes the `[` at the start of `text`, or -1 when
 * none is found. Quote-aware: a `]` inside a quoted Jinja expression is not a
 * close bracket.
 */
function findUnquotedBracketClose(text: string): number {
  let depth = 0
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
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
    if (ch === "[") depth++
    else if (ch === "]") {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * Split the inside of a YAML flow sequence on top-level commas only — quote-
 * and bracket/paren/brace-aware, so a comma inside a quoted Jinja expression
 * (`"{{ env_var('MODEL_DIR', 'transform') }}"`) does not split the single
 * item in two.
 */
function splitTopLevelListItems(text: string): string[] {
  const items: string[] = []
  let depth = 0
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
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
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++
      continue
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth--
      continue
    }
    if (ch === "," && depth === 0) {
      items.push(text.slice(start, i))
      start = i + 1
    }
  }
  items.push(text.slice(start))
  return items
}

export function readDbtProjectPathList(yml: string, key: string): string[] | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  // `[ \t]*` rather than `\s*`: `\s` matches newlines, so around the colon it
  // reaches into the next line and captures the first item of a block
  // sequence as if it were an inline scalar.
  // Anchored at column 0: every key this reads (`model-paths`, `seed-paths`,
  // `macro-paths`, `packages-install-path`, …) is a project-level key. An
  // indentation-insensitive match also selects a same-named key nested under
  // `vars:` or a per-model config block, which would send every path-based
  // check in the lane at a directory the project never configured.
  const line = new RegExp(`^${escaped}[ \\t]*:[ \\t]*(.*)$`, "m").exec(yml)
  if (!line) return null
  const indent = 0
  // Strip a trailing comment, and a comment that is the whole value. Without
  // the second case `model-paths:  # TODO` parses as a directory literally
  // named "# TODO", and the project's real models become invisible to every
  // gate instead of falling back to dbt's default.
  const rest = (line[1] ?? "")
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
    // The flow sequence can (a) span multiple physical lines — valid YAML —
    // and (b) contain a Jinja expression whose own parens/quotes carry a
    // comma, e.g. `["{{ env_var('MODEL_DIR', 'transform') }}"]`. Splitting
    // naively on every comma breaks case (b) into two invalid paths (both
    // then discarded), and stopping at the first line misses case (a)
    // entirely — both silently fall back to `models/`, so touched-model
    // validators miss edits under the real, configured directory.
    let combined = rest
    let closeIdx = findUnquotedBracketClose(combined)
    if (closeIdx === -1) {
      const restLines = yml.slice((line.index ?? 0) + line[0].length).split("\n")
      for (const raw of restLines) {
        const stripped = raw.replace(/\s+#.*$/, "").replace(/^\s*#.*$/, "")
        combined += "\n" + stripped
        closeIdx = findUnquotedBracketClose(combined)
        if (closeIdx !== -1) break
      }
    }
    const inner = closeIdx === -1 ? combined.slice(1) : combined.slice(1, closeIdx)
    const items = splitTopLevelListItems(inner)
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
    // `seeds` alone is dbt's default. `data/` is only the pre-1.0 spelling's
    // *configured* value, never an additional default: adding it unconditionally
    // makes `data/orders.csv` read as a produced, authored node in a project
    // where dbt will never load it, so both contract gates can accept a
    // required `orders` deliverable with nothing built. `data-paths` is still
    // honoured through `legacyKey` when the project actually sets it.
    seeds: pick("seed-paths", "data-paths", ["seeds"]),
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
 * Platforms whose default filesystem is case-insensitive (APFS on macOS,
 * NTFS on Windows). Linux's common filesystems (ext4, xfs, …) are
 * case-sensitive by default, so folding case there makes a configured
 * `model-paths: ['Models']` also match a distinct, ignored `models/`
 * directory — files under it can then falsely satisfy the deliverable
 * inventory or read as touched models, even though dbt never loads them.
 * This is a platform-default heuristic, not a per-volume probe (an exFAT
 * mount on Linux, or a case-sensitive APFS volume, are outside what a path
 * comparison alone can detect) — but it is strictly more correct than
 * unconditional folding, which was wrong for every Linux CI run.
 */
const CASE_INSENSITIVE_PLATFORM = process.platform === "darwin" || process.platform === "win32"

/**
 * True when `filePath` sits inside one of `dirs` (or is one of them).
 *
 * Compared case-insensitively only on a platform whose filesystem defaults to
 * case-insensitive (see `CASE_INSENSITIVE_PLATFORM`); case-sensitively
 * everywhere else, so a case-sensitive filesystem's distinct same-spelled-
 * differently-cased directories are not conflated.
 */
export function isUnderAnyDir(filePath: string, dirs: string[]): boolean {
  const normalize = (p: string): string => (CASE_INSENSITIVE_PLATFORM ? p.toLowerCase() : p)
  const target = normalize(filePath)
  for (const dir of dirs) {
    const base = normalize(dir).replace(/[\\/]+$/, "")
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
 * True only when `command` is CONFIRMED to be `run` or `build` — never for a
 * null/unrecognised command, unlike `runResultsExecutedModels`.
 *
 * The two predicates answer different questions and must not be conflated.
 * `runResultsExecutedModels`'s permissive default ("an unknown command reads
 * as executing") is correct for deciding whether ROWS THAT EXIST are usable
 * evidence — denying an unclassifiable artifact would block a session whose
 * build was genuinely green. It is wrong for deciding whether the ABSENCE of
 * a row is itself evidence of anything: an artifact from an unrecognised
 * command with zero model rows might just be a command this lane cannot
 * classify, not a `build`/`run` invocation that legitimately selected
 * nothing. Only a CONFIRMED `build`/`run` command turns "no model rows" into
 * positive evidence of failed coverage rather than "no signal either way".
 */
export function isConfirmedModelExecutingCommand(command: string | null): boolean {
  return command !== null && MODEL_EXECUTING_DBT_COMMANDS.has(command)
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

/**
 * True when `command` executed something in the warehouse, so its rows are
 * evidence that the nodes they name were *produced* — of whatever type.
 *
 * Distinct from `runResultsExecutedModels` on purpose, and the two must not be
 * collapsed again. Model *coverage* can only be spoken for by a command that
 * runs model SQL (`run`, `build`), because a `dbt seed` says nothing about
 * whether an edited model compiles. But *deliverable* evidence is broader: a
 * task can require a seed or a snapshot, and `dbt seed` genuinely builds it.
 * Using the model-coverage predicate for both made a successful `dbt seed` of
 * exactly the required name read as "nothing was built", so `dbt-nothing-built`
 * blocked a session that had delivered the thing it was asked for.
 *
 * Row-level filtering still applies at the call site: a `dbt test` artifact
 * reaches here as executing, but carries only `test.` rows, which no caller
 * counts as a buildable node.
 */
export function runResultsProducedNodes(command: string | null): boolean {
  return !runResultsCarriesNoBuildEvidence(command)
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
      // A surviving manifest can carry a node whose defining file is gone —
      // deleted, or replaced during a branch switch. `collectProducedNodeNames`
      // already refuses to trust such an entry as evidence a relation exists;
      // this exemption reader must apply the same check, or a stale
      // `ephemeral`/`disabled` flag on a bare name is inherited by a brand
      // new, ordinary model that happens to share it — `dbt-build-green` then
      // drops the new model out of scope and reports success having checked
      // nothing.
      const originalPath = typeof n["original_file_path"] === "string" ? n["original_file_path"] : ""
      if (originalPath.length > 0 && !(await pathExists(join(dbtRoot, originalPath)))) continue
      const config = (n["config"] ?? {}) as Record<string, unknown>
      if (String(config["materialized"] ?? "").toLowerCase() === "ephemeral") out.ephemeral.add(name)
      if (config["enabled"] === false) out.disabled.add(name)
    }
    for (const entry of Object.values(manifest.disabled ?? {})) {
      const rows = Array.isArray(entry) ? entry : [entry]
      for (const node of rows) {
        if (typeof node !== "object" || node === null) continue
        const n = node as Record<string, unknown>
        const originalPath = typeof n["original_file_path"] === "string" ? n["original_file_path"] : ""
        if (originalPath.length > 0 && !(await pathExists(join(dbtRoot, originalPath)))) continue
        const name = n["name"]
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
  // Every literal-false spelling Jinja/Python accept as a condition: the bare
  // word (`false`/`False`), the integer `0`, and either wrapped in a single
  // level of parens. `{% if 0 %}{{ config(enabled=false) }}{% endif %}` is as
  // dead as `{% if false %}` — dbt never evaluates it — but only the bare-word
  // form was recognised, so this stripper left the call visible and
  // `sourceExemptsFromRunResults` read a live, unbuilt model as exempt.
  const deadIf = /\{%-?\s*if\s+\(?\s*(?:false|0)\s*\)?\s*-?%\}/gi
  for (;;) {
    deadIf.lastIndex = 0
    const m = deadIf.exec(out)
    if (!m) return out
    const chainEnd = jinjaBlockEnd(out, m.index)
    // Only the `{% if false %}` ARM is dead. Its `{% elif %}` / `{% else %}`
    // arms are branches dbt does evaluate, and blanking through `{% endif %}`
    // drops real `config()` written there — an ephemeral or disabled model
    // then loses its exemption and the build gate demands a `run_results` row
    // dbt is never going to write. Blank to the next same-depth arm instead,
    // falling back to the whole chain when there is no other arm.
    const armEnd = nextJinjaArmStart(out, m.index + m[0].length, chainEnd) ?? chainEnd
    out = out.slice(0, m.index) + blank(out.slice(m.index, armEnd)) + out.slice(armEnd)
  }
}

/**
 * Offset of the next `{% elif %}` / `{% else %}` that belongs to the chain
 * opened just before `from`, or null when the chain has no further arm.
 *
 * Depth-counted so an inner `{% if %}…{% else %}…{% endif %}` nested in the
 * dead arm is skipped rather than mistaken for the outer chain's else.
 */
function nextJinjaArmStart(sql: string, from: number, chainEnd: number): number | null {
  // Modulo-safe tag body, matching `ownBranchMatches` / `jinjaIfBranchHead`:
  // `[^%]*` stops dead on `{% if n % 2 == 0 %}` and loses an arm.
  const tag = /\{%-?\s*(if|elif|else|endif)\b(?:[^%]|%(?!\}))*%\}/gi
  tag.lastIndex = from
  let depth = 0
  let m: RegExpExecArray | null
  while ((m = tag.exec(sql)) !== null) {
    if (m.index >= chainEnd) return null
    const kind = m[1]?.toLowerCase()
    if (kind === "if") {
      depth++
      continue
    }
    if (kind === "endif") {
      if (depth === 0) return null
      depth--
      continue
    }
    if (depth === 0) return m.index
  }
  return null
}
/**
 * Concatenate the argument text of every `{{ config() }}` call in a model.
 *
 * Everything that reasons about a model's declared configuration must go
 * through this rather than scanning the whole file: `where enabled = false` is
 * an ordinary SQL predicate, and treating it as `config(enabled=false)` hands
 * any session a one-line way to exempt an unbuilt model from the build gate.
 */
export function dbtConfigArgs(sql: string): string {
  return dbtConfigCallArgs(sql).join("\n")
}

/**
 * The argument text of every `{{ config() }}` call in a model, as SEPARATE
 * strings — one per call — rather than concatenated.
 *
 * Top-level key parsing (`parseTopLevelConfigAssignments`) needs each call's
 * own argument text: joining every call's arguments together first and then
 * splitting on commas would merge one call's trailing argument with the
 * next call's leading one whenever a model has more than one `config()`
 * call (e.g. one per Jinja branch), corrupting both.
 */
export function dbtConfigCallArgs(sql: string): string[] {
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
  return parts
}

/**
 * Parse the TOP-LEVEL `key=value` assignments out of one `config()` call's
 * argument text, keyed by argument name with the raw (unparsed, un-unquoted)
 * value text.
 *
 * Quote- and bracket/paren/brace-aware, via the same top-level-comma splitter
 * used for YAML flow sequences: an argument value can itself contain commas
 * inside a nested call or a quoted string (`pre_hook="{{ log(a, b) }}"`), and
 * splitting on every comma would misread that nested comma as an argument
 * boundary. Only the FIRST `=` in a segment separates key from value, so a
 * value containing its own `=` (a Jinja comparison, say) is not truncated.
 *
 * This is the "read config()" primitive every exemption check must go
 * through. Scanning the whole argument blob for `enabled\s*=\s*false` — the
 * previous approach — matches that text anywhere in the blob, including
 * inside an unrelated string argument (a hook or metadata value containing
 * the literal text `enabled=false`), and wrongly exempts a live, unbuilt
 * model from the build gate.
 */
export function parseTopLevelConfigAssignments(argsText: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const segment of splitTopLevelListItems(argsText)) {
    const eqIdx = topLevelEqualsIndex(segment)
    if (eqIdx === -1) continue
    const key = segment.slice(0, eqIdx).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    out.set(key, segment.slice(eqIdx + 1).trim())
  }
  return out
}

/** Index of the first top-level (unquoted, unbracketed) `=` in `text`, or -1. */
function topLevelEqualsIndex(text: string): number {
  let depth = 0
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
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
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++
      continue
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth--
      continue
    }
    // `==` is a comparison, not an assignment; only a lone `=` counts.
    if (ch === "=" && depth === 0 && text[i + 1] !== "=" && text[i - 1] !== "=" && text[i - 1] !== "!") {
      return i
    }
  }
  return -1
}

/** Unquote a config value's raw text, when it is a plain quoted string. */
export function unquoteConfigValue(value: string): string {
  const t = value.trim()
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1)
  }
  return t
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
/** Config-key axes read from every `config()` call in a model's source. */
interface ConfigAxes {
  /** Any call set `materialized='ephemeral'`. */
  ephemeral: boolean
  /** Any call set `materialized` to a value other than `ephemeral`. */
  nonEphemeral: boolean
  /** Any call set `enabled` to a falsy literal. */
  disabled: boolean
  /** Any call set `enabled` to a truthy literal. */
  enabled: boolean
}

/**
 * Read the `materialized`/`enabled` axes from every `config()` call's
 * TOP-LEVEL keys — never from a regex over the whole argument blob, which
 * matches the same text sitting inside an unrelated string argument (a hook
 * or metadata value that happens to contain `enabled=false`).
 */
/**
 * `raw`'s content when it is EXACTLY a single- or double-quoted string
 * literal (`'table'`, `"incremental"`), or null when it is anything else —
 * in particular a dynamic Jinja expression (`var('kind', 'ephemeral')`, a
 * ternary, a macro call). A dynamic value is not a STATIC declaration of
 * anything; the model's actual materialization for such a value is whatever
 * the resolved manifest says, which this source-level helper cannot compute.
 */
function staticQuotedLiteralValue(raw: string): string | null {
  const t = raw.trim()
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1)
  }
  return null
}

function readConfigAxes(sql: string): ConfigAxes {
  const out: ConfigAxes = { ephemeral: false, nonEphemeral: false, disabled: false, enabled: false }
  for (const callArgs of dbtConfigCallArgs(sql)) {
    const kv = parseTopLevelConfigAssignments(callArgs)
    const materialized = kv.get("materialized")
    if (materialized !== undefined) {
      // Only a STATIC literal counts on either side of this axis. Treating a
      // dynamic value (`materialized=var('kind', 'ephemeral')`) as an
      // affirmative "not ephemeral" declaration made `dbt-build-green` reject
      // the manifest's correctly-resolved ephemeral exemption and demand a
      // `run_results` row dbt was never going to write for a genuinely
      // ephemeral model — blocking every correct build of it. A dynamic value
      // says nothing on this axis; the manifest's resolved config is what
      // speaks for it (see `collectRunResultExemptModels`).
      const literal = staticQuotedLiteralValue(materialized)
      if (literal !== null) {
        if (/^ephemeral$/i.test(literal)) out.ephemeral = true
        else out.nonEphemeral = true
      }
    }
    const enabled = kv.get("enabled")
    if (enabled !== undefined) {
      const t = enabled.trim()
      if (/^(?:false|False|0)$/.test(t)) out.disabled = true
      else if (/^(?:true|True|1)$/.test(t)) out.enabled = true
    }
  }
  return out
}

export function sourceExemptsFromRunResults(sql: string): boolean {
  const axes = readConfigAxes(stripSqlComments(sql))
  // Per axis, and only when the source does not also declare the opposite.
  // A model whose live config states both (`{% if target.name == 'prod' %}
  // {{ config(enabled=false) }}{% else %}{{ config(enabled=true) }}{% endif %}`)
  // is not evidence of an exemption — and honouring it drops the model out of
  // scope entirely, so even a fresh `error` row for it is filed as
  // out-of-scope and the build gate reports green having checked nothing.
  // An unresolved contradiction requires coverage instead of granting silence.
  return (axes.ephemeral && !axes.nonEphemeral) || (axes.disabled && !axes.enabled)
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
  return readConfigAxes(stripSqlComments(sql)).nonEphemeral
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
  return readConfigAxes(stripSqlComments(sql)).enabled
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
/**
 * File extensions that define a node, per source-directory kind. dbt only
 * ever loads `.sql`/`.py` under model and snapshot paths, and only `.csv`
 * under seed paths — a `.csv` dropped under `models/` is inert, and a `.sql`
 * under `seeds/` is not a seed. Scanning every extension under every
 * directory let a `.csv` written to satisfy a required model be counted as
 * the produced node, when dbt itself never loads it.
 */
const MODEL_NODE_EXTENSIONS = [".sql", ".py"]
const SEED_NODE_EXTENSIONS = [".csv"]
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
  async function scan(dir: string, depth: number, extensions: string[]): Promise<void> {
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
        await scan(full, depth + 1, extensions)
      } else if (isFile) {
        const lower = entry.name.toLowerCase()
        const ext = extensions.find((e) => lower.endsWith(e))
        if (ext) names.add(lower.slice(0, lower.length - ext.length))
      }
    }
  }
  const sourcePaths = await resolveDbtSourcePaths(dbtRoot)
  for (const nodeDir of [...sourcePaths.models, ...sourcePaths.snapshots]) {
    await scan(nodeDir, 0, MODEL_NODE_EXTENSIONS)
  }
  for (const nodeDir of sourcePaths.seeds) {
    await scan(nodeDir, 0, SEED_NODE_EXTENSIONS)
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

/**
 * Resolve `relative` against `root`, refusing to leave it.
 *
 * A required file path is repository content (parsed out of a task
 * document), and the extractor's own shape check (`FILE_PATH_RE`) allows
 * `.`/`/` freely — `../../outside/secret.yml` matches it. Joining that
 * verbatim and `stat`-ing the result can satisfy a completion gate with a
 * file entirely outside the workspace. Returns null when the resolved path
 * would escape `root`, so callers simply treat the requirement as unmet
 * rather than probing outside their allowed roots.
 */
export function resolveWithinRoot(root: string, relative: string): string | null {
  const resolvedRoot = resolve(root)
  const resolvedPath = resolve(resolvedRoot, relative)
  if (resolvedPath === resolvedRoot) return resolvedPath
  if (resolvedPath.startsWith(resolvedRoot + sep)) return resolvedPath
  return null
}

/**
 * Prefix marking a telemetry field that was redacted rather than a real
 * value, so downstream consumers can tell a hashed path from actual data.
 */
const TELEMETRY_PATH_HASH_PREFIX = "path:"
/** Absolute-path shape: POSIX root, Windows drive letter, or UNC. */
const ABSOLUTE_PATH_SHAPE_RE = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/

/**
 * `details` keys across the five dbt completion-gate validators that are
 * documented to carry a filesystem path — including a RELATIVE one, such as
 * `required_files: ["models/private_customer_rollup.sql"]` (a project-
 * relative path parsed out of a task document). The absolute-path shape
 * check alone misses these: they never start with `/` or a drive letter, so
 * they read as ordinary strings and passed through unredacted, still
 * violating the "telemetry never collects file paths" contract for a
 * relative path. Every string value under one of these keys is hashed
 * regardless of shape, at any nesting depth.
 *
 * Kept as an explicit, exhaustive list rather than a shape heuristic for
 * relative paths specifically: a shape guess broad enough to catch every
 * relative path (any string containing `/`?) would also swallow non-path
 * data that happens to contain a slash, which this lane has no way to tell
 * apart from a real path without knowing the field's meaning.
 */
const PATH_BEARING_DETAIL_KEYS = new Set([
  "dbt_root",
  "run_results_path",
  "task_file",
  "task_files",
  "required_files",
  "missing_files",
])

/** True when `value` is shaped like an absolute filesystem path. */
function looksLikeAbsolutePath(value: string): boolean {
  return ABSOLUTE_PATH_SHAPE_RE.test(value)
}

/** A short, non-reversible fingerprint of a path — stable for dedup, not the path itself. */
function hashPathValue(value: string): string {
  return TELEMETRY_PATH_HASH_PREFIX + createHash("sha256").update(value).digest("hex").slice(0, 12)
}

/**
 * `key` is the enclosing object key this value was read from (null for a
 * value with no key, e.g. the top level or an array element already inside a
 * matched key) — carried through the recursion so a nested string still
 * redacts when its ARRAY's key is in `PATH_BEARING_DETAIL_KEYS`
 * (`required_files: [...]`, not `required_files[i]`).
 */
function sanitizeTelemetryValue(key: string | null, value: unknown): unknown {
  if (typeof value === "string") {
    const forcedPathField = key !== null && PATH_BEARING_DETAIL_KEYS.has(key)
    return forcedPathField || looksLikeAbsolutePath(value) ? hashPathValue(value) : value
  }
  if (Array.isArray(value)) return value.map((v) => sanitizeTelemetryValue(key, v))
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = sanitizeTelemetryValue(k, v)
    return out
  }
  return value
}

/**
 * Redact filesystem paths out of a validator's `details` object before it is
 * handed to telemetry.
 *
 * Every validator's `details` is forwarded to `Telemetry.track` verbatim by
 * the dispatch hook, and several carry paths — absolute (`dbt_root`,
 * `run_results_path`, `task_file`) and relative (`required_files`,
 * `missing_files`, project-relative strings parsed out of a task document) —
 * for use in `reason`/`fixHint` text. That collects local directory names —
 * and, embedded in them, usernames — despite the documented telemetry
 * contract that file paths are never sent (`docs/docs/reference/
 * telemetry.md`). This walks the object and replaces every string shaped
 * like an absolute path, AND every string under a key known to carry a path
 * (`PATH_BEARING_DETAIL_KEYS`, covering the relative case), with a short
 * hash — the field is still present and stable for dedup/counting without
 * leaking its value. Non-path strings (model names, verdict enums,
 * `task_file`'s SOURCE tier, …) pass through unchanged.
 */
export function sanitizeTelemetryDetails(details: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(details)) {
    out[key] = sanitizeTelemetryValue(key, value)
  }
  return out
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
    // Dollar-quoted string literal (`$$…$$` / `$tag$…$tag$`), the
    // PostgreSQL-compatible alternative to `'…'` that needs no escaping —
    // routinely used for function bodies and is not "SQL dbt models do not
    // use": a Postgres-compatible warehouse's models genuinely contain it. A
    // literal like `$$ iff(a, b, c) $$` was previously left unmasked, so
    // dialect matching read the quoted text as an executed call.
    if (c === "$") {
      const tagMatch = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))
      if (tagMatch) {
        const delim = tagMatch[0]
        const bodyStart = i + delim.length
        const closeIdx = sql.indexOf(delim, bodyStart)
        const j = closeIdx === -1 ? n : closeIdx + delim.length
        if (opts.literals) blank(bodyStart, closeIdx === -1 ? n : closeIdx)
        i = j
        continue
      }
    }
    // String literal. `''` and `\'` both escape a quote.
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
 * One arm of a Jinja if-chain, as an absolute span in the ORIGINAL string
 * passed to `chainArmSpans` — the arm's own opening tag through to (but
 * excluding) the next arm's opening tag / the chain's `{% endif %}`.
 */
interface ArmSpan {
  /** The arm's own opening tag (`{% if … %}` / `{% elif … %}` / `{% else %}`), verbatim. */
  opener: string
  start: number
  end: number
}

/**
 * Split one if-chain into its top-level arm spans, with absolute offsets into
 * `sql` — unlike `chainArms`, which returns arm text with no positional
 * information, so a caller cannot blank a subset of arms in place.
 */
function chainArmSpans(sql: string, openStart: number, openLength: number, chainEnd: number): ArmSpan[] {
  const tag = /\{%-?\s*(if|elif|else|endif)\b(?:[^%]|%(?!\}))*%\}/gi
  tag.lastIndex = openStart + openLength
  const spans: ArmSpan[] = []
  let depth = 0
  let currentOpener = sql.slice(openStart, openStart + openLength)
  let armStart = openStart
  let m: RegExpExecArray | null
  while ((m = tag.exec(sql)) !== null) {
    if (m.index >= chainEnd) break
    const kind = (m[1] ?? "").toLowerCase()
    if (kind === "if") {
      depth++
      continue
    }
    if (kind === "endif") {
      if (depth > 0) {
        depth--
        continue
      }
      spans.push({ opener: currentOpener, start: armStart, end: m.index })
      return spans
    }
    if (depth > 0) continue
    spans.push({ opener: currentOpener, start: armStart, end: m.index })
    currentOpener = m[0]
    armStart = m.index
  }
  // Unterminated chain — one arm running to the caller's chain end.
  spans.push({ opener: currentOpener, start: armStart, end: chainEnd })
  return spans
}

/**
 * Blank every ARM of a Jinja if-chain whose *own* branch condition matches
 * `conditionRe`, matched to its chain's `{% endif %}` by nesting depth.
 *
 * Arm-scoped, not chain-scoped. `{% if execute %}…{% elif target.type == 'x'
 * %}…{% endif %}` is one guard chain, but only the `elif` arm is actually
 * warehouse-guarded — the `if` arm runs on every target whenever `execute` is
 * true. Blanking the whole chain because ANY arm matched hid a genuinely
 * unguarded dialect call in the `if` arm from the lint; blanking only the
 * matching arm(s) keeps every other arm's SQL visible to it. `elif` tags
 * belonging to a *nested* `if` are not this chain's own branches and are
 * ignored by `chainArmSpans`'s depth tracking.
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
    const arms = chainArmSpans(out, m.index, m[0].length, end)
    // Blanking replaces each character with a space of equal length, so arm
    // offsets computed above stay valid regardless of how many arms in this
    // chain are blanked or in what order.
    for (const arm of arms) {
      if (!conditionRe.test(arm.opener)) continue
      const blanked = out.slice(arm.start, arm.end).replace(/[^\n\r]/g, " ")
      out = out.slice(0, arm.start) + blanked + out.slice(arm.end)
    }
    // Resume just past THIS chain's own opening tag, not past the whole
    // chain. An arm whose own condition did NOT match stays exposed with its
    // original text — including any NESTED `{% if %}` chain it contains,
    // which needs its own, independent chance to match `conditionRe` (a
    // nested `target.type` guard inside an outer, unrelated `{% if a %}` arm
    // must still be found and blanked). Resuming at `end` skipped straight
    // past such nested chains without ever inspecting them. A matched arm's
    // nested content is blanked away with it, so re-scanning there finds
    // nothing — safe either way.
    searchFrom = m.index + m[0].length
  }
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
