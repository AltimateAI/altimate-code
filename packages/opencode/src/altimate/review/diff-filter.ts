/**
 * dbt-aware diff filtering.
 *
 * Cloudflare strips lock files / vendored / minified / generated assets but
 * deliberately keeps migrations. The dbt analogue: strip build artifacts and
 * vendored packages, but NEVER skip the things that change data semantics —
 * snapshots, macros, schema.yml contract blocks, seeds.
 */

import { posix } from "node:path"

/** Paths that are build output / vendored and carry no review signal. */
const SKIP_DIR_PATTERNS = [
  /(^|\/)target\//,
  /(^|\/)dbt_packages\//,
  /(^|\/)dbt_modules\//,
  /(^|\/)compiled\//,
  /(^|\/)run\//,
  /(^|\/)logs\//,
  /(^|\/)\.venv\//,
  /(^|\/)node_modules\//,
  /(^|\/)\.git\//,
]

/** Specific generated files to skip. */
const SKIP_FILE_PATTERNS = [
  /(^|\/)catalog\.json$/,
  /(^|\/)manifest\.json$/,
  /(^|\/)run_results\.json$/,
  /(^|\/)graph\.gpickle$/,
  /(^|\/)partial_parse\.msgpack$/,
  /(^|\/)index\.html$/,
  /\.lock$/,
]

/** Extensions worth reviewing for a dbt project. */
const REVIEWABLE_EXT = [".sql", ".yml", ".yaml", ".csv", ".py"]

/** True when a changed path should be reviewed (not a build artifact). */
export function shouldReview(path: string): boolean {
  const p = path.replace(/\\/g, "/")
  if (SKIP_DIR_PATTERNS.some((re) => re.test(p))) return false
  if (SKIP_FILE_PATTERNS.some((re) => re.test(p))) return false
  return REVIEWABLE_EXT.some((ext) => p.toLowerCase().endsWith(ext))
}

export type DbtFileKind =
  | "model_sql" // models/**.sql
  | "schema_yml" // models/**/*.yml (contracts, tests, descriptions)
  | "source_yml" // a yml declaring sources:
  | "macro" // macros/**
  | "snapshot" // snapshots/**
  | "seed" // seeds/**.csv
  | "test" // tests/**.sql or data tests
  | "analysis" // analyses/**
  | "python_model" // models/**.py
  | "project_config" // dbt_project.yml / profiles.yml / packages.yml
  | "other"

type DbtRole = "model" | "snapshot" | "seed" | "macro" | "test" | "analysis"

/**
 * Where a dbt project keeps each kind of file, from `dbt_project.yml`
 * (`model-paths`, `snapshot-paths`, …). `root` is the project directory
 * relative to the repository root ("" when the project is at the root).
 */
export interface DbtProjectLayout {
  root: string
  dirs: Record<DbtRole, string[]>
}

export const DEFAULT_DBT_DIRS: Record<DbtRole, string[]> = {
  model: ["models"],
  snapshot: ["snapshots"],
  seed: ["seeds"],
  macro: ["macros"],
  test: ["tests"],
  analysis: ["analyses"],
}

const norm = (p: string) => p.replace(/\\/g, "/")

/** `p` relative to `root`, or undefined when it lies outside. Both POSIX, repo-relative. */
export function relativeToRoot(p: string, root: string): string | undefined {
  const r = norm(root).replace(/^\.\/?/, "").replace(/\/+$/, "")
  const f = norm(p)
  if (!r) return f
  return f.startsWith(r + "/") ? f.slice(r.length + 1) : undefined
}

/**
 * The layout's directories as repo-relative paths. Each `*-paths` entry is
 * relative to the project root and may climb out of it (`../../dbt_macros`
 * in a monorepo of sub-projects sharing one macro dir); entries that resolve
 * outside the repository are dropped.
 */
export function resolvedLayoutDirs(layout: DbtProjectLayout): Array<{ role: DbtRole; dir: string }> {
  const root = norm(layout.root).replace(/^\.\/?/, "").replace(/\/+$/, "")
  const out: Array<{ role: DbtRole; dir: string }> = []
  for (const [role, list] of Object.entries(layout.dirs) as Array<[DbtRole, string[]]>) {
    for (const d of list) {
      const dir = posix.normalize(posix.join(root || ".", norm(d))).replace(/\/+$/, "")
      // The project root itself (`model-paths: ["."]` with the project at the repo root).
      if (dir === ".") {
        out.push({ role, dir: "" })
        continue
      }
      if (!dir || dir === ".." || dir.startsWith("../") || dir.startsWith("/")) continue
      out.push({ role, dir })
    }
  }
  return out
}

/** The role of a repo-relative path from the configured directories; the
 *  longest matching directory wins so `models/tests/x.sql` is a model when
 *  `models` is a model path. */
function roleFromLayout(path: string, layout: DbtProjectLayout): DbtRole | undefined {
  const p = norm(path).toLowerCase()
  let best: { role: DbtRole; len: number } | undefined
  for (const { role, dir } of resolvedLayoutDirs(layout)) {
    const d = dir.toLowerCase()
    // "" (`model-paths: ["."]` at the repo root) matches every path at length 0,
    // so a more specific directory still wins.
    if ((d === "" || p.startsWith(d + "/")) && (!best || d.length > best.len)) best = { role, len: d.length }
  }
  return best?.role
}

/** Without a layout, the OUTERMOST conventional directory decides the role,
 *  so `models/tests/x.sql` is a model and `tests/models/x.sql` a test. */
function roleFromConvention(p: string): DbtRole | undefined {
  const segments = p.toLowerCase().split("/").slice(0, -1)
  for (const seg of segments) {
    for (const [role, list] of Object.entries(DEFAULT_DBT_DIRS) as Array<[DbtRole, string[]]>) {
      if (list.includes(seg)) return role
    }
  }
  return undefined
}

/** Classify a changed file by its role in a dbt project. With a layout, the
 *  project's own `*-paths` decide (custom `model-paths` are honoured);
 *  without one, conventional directory names do. */
export function classifyDbtFile(path: string, layout?: DbtProjectLayout): DbtFileKind {
  const p = norm(path).toLowerCase()
  const isYaml = p.endsWith(".yml") || p.endsWith(".yaml")
  if (/(^|\/)(dbt_project|profiles|packages|dependencies)\.ya?ml$/.test(p)) return "project_config"
  // A layout dir decides wherever it points, including outside the project
  // root; other files outside the root fall back to conventional names.
  const role = layout
    ? (roleFromLayout(path, layout) ??
      (relativeToRoot(norm(path), layout.root) === undefined ? roleFromConvention(p) : undefined))
    : roleFromConvention(p)
  if (role === "macro") return "macro"
  // Snapshots split by extension: `.sql` files are snapshot definitions
  // (tier-forcing, catalog-scoped), YAML property files under `snapshots/`
  // are schema files (declared tests + column metadata) and should route to
  // `schema_yml` so the test-removal detector runs on them.
  if (role === "snapshot" && p.endsWith(".sql")) return "snapshot"
  if (role === "seed" && p.endsWith(".csv")) return "seed"
  if (role === "test" && p.endsWith(".sql")) return "test"
  if (role === "analysis") return "analysis"
  if (role === "model" && p.endsWith(".py")) return "python_model"
  if (role === "model" && p.endsWith(".sql")) return "model_sql"
  if (isYaml && (role === "model" || role === "snapshot" || role === "seed" || role === "test")) return "schema_yml"
  if (isYaml && /(^|\/)(_?schema|_?models|_?sources|sources|properties)\.ya?ml$/.test(p)) return "schema_yml"
  return "other"
}

/** A changed file as reported by the VCS. */
export interface ChangedFile {
  path: string
  status: "added" | "modified" | "deleted" | "renamed"
  /** Unified diff hunk text, when available. */
  diff?: string
  /** Previous path for renames. */
  oldPath?: string
  /** Rename similarity (0–100) from git; 100 means the content is unchanged. */
  similarity?: number
  /** dbt role, set by filterChangedFiles from the project layout. */
  kind?: DbtFileKind
}

/** The file's dbt role: the layout-aware kind when filterChangedFiles set it. */
export function fileKind(file: ChangedFile): DbtFileKind {
  return file.kind ?? classifyDbtFile(file.path)
}

/** True when a file has a previous version to compare against: a modification,
 *  or a rename (whose old side lives at `oldPath`). */
export function hasOldSide(file: ChangedFile): boolean {
  return file.status === "modified" || (file.status === "renamed" && !!file.oldPath)
}

// Compile a glob (`**`, `*`, `?`) to an anchored RegExp with path semantics:
// `*`/`?` never cross `/`; a double-star directory prefix matches zero or more
// whole directory segments (preserving the slash boundary); a trailing or
// standalone double-star matches the rest of the path.
function globToRegExp(glob: string): RegExp {
  let re = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++
        if (glob[i + 1] === "/") {
          i++
          re += "(?:[^/]*/)*" // **/ — zero or more whole directory segments
        } else {
          re += ".*" // ** — the rest of the path, across segments
        }
      } else {
        re += "[^/]*" // * — within a single path segment
      }
    } else if (c === "?") {
      re += "[^/]"
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    }
  }
  return new RegExp(`^${re}$`)
}

/** A changed file the review did not look at, and why. */
export interface NotReviewed {
  path: string
  reason: string
}

/** Split changed files into the reviewable set (with their dbt kind) and the
 *  files dropped before review, each with the reason it was dropped. */
export function partitionChangedFiles(
  files: ChangedFile[],
  extraExcludeGlobs: string[] = [],
  layout?: DbtProjectLayout,
): { reviewable: Array<ChangedFile & { kind: DbtFileKind }>; dropped: NotReviewed[] } {
  // Normalize to forward slashes so `/`-based glob semantics hold on Windows paths.
  const excluders = extraExcludeGlobs.map((g) => ({ glob: g, re: globToRegExp(g) }))
  const reviewable: Array<ChangedFile & { kind: DbtFileKind }> = []
  const dropped: NotReviewed[] = []
  for (const f of files) {
    if (!shouldReview(f.path)) {
      dropped.push({ path: f.path, reason: "not a dbt file (extension or generated path)" })
      continue
    }
    const hit = excluders.find(({ re }) => re.test(norm(f.path)))
    if (hit) {
      dropped.push({ path: f.path, reason: `excluded by glob ${hit.glob}` })
      continue
    }
    reviewable.push({ ...f, kind: classifyDbtFile(f.path, layout) })
  }
  return { reviewable, dropped }
}

/** Filter changed files down to the reviewable set, with their dbt kind. */
export function filterChangedFiles(
  files: ChangedFile[],
  extraExcludeGlobs: string[] = [],
  layout?: DbtProjectLayout,
): Array<ChangedFile & { kind: DbtFileKind }> {
  return partitionChangedFiles(files, extraExcludeGlobs, layout).reviewable
}

/** The first folder under the file's role directory (`staging` for
 *  `models/staging/x.sql`), or "" for a file directly in it. Folder-level
 *  config in dbt_project.yml and layer conventions key off this folder. */
function layerOf(path: string, root: string | undefined, layout?: DbtProjectLayout): string {
  const rel = (relativeToRoot(path, root ?? "") ?? norm(path)).toLowerCase()
  const dirs = Object.values(layout?.dirs ?? DEFAULT_DBT_DIRS)
    .flat()
    .map((d) => norm(d).toLowerCase().replace(/^\.\/?/, "").replace(/\/+$/, ""))
    .filter((d) => d && rel.startsWith(d + "/"))
    .sort((a, b) => b.length - a.length)
  const rest = dirs.length ? rel.slice(dirs[0].length + 1) : rel
  const segments = rest.split("/")
  return segments.length > 1 ? segments[0] : ""
}

export interface ScopeResult {
  /** Files inside the dbt project, with unchanged moves removed. */
  inScope: ChangedFile[]
  /** Changed files outside the dbt project root (counted, not reviewed). */
  outOfScope: number
  /** Non-model renames with identical content that keep the name, role and layer (a pure move). */
  movedUnchanged: number
  /** Paths behind `outOfScope`. */
  outOfScopePaths: string[]
  /** Paths behind `movedUnchanged`. */
  movedUnchangedPaths: string[]
}

const isModel = (p: string, layout?: DbtProjectLayout) => {
  const kind = classifyDbtFile(p, layout)
  return kind === "model_sql" || kind === "python_model"
}

/**
 * Restrict the PR's changed files to the dbt project being reviewed.
 *
 * - Files outside `root` belong to another project or to non-dbt code: they
 *   are counted, never reviewed (a monorepo with several dbt projects must not
 *   review its siblings). The exception is a layout dir that points outside
 *   the root (`macro-paths: ["../../dbt_macros"]`): files there are part of
 *   the project and stay in scope.
 * - Every model move stays in scope, even a same-name 100% rename: a model's
 *   folder can carry config in `dbt_project.yml` (materialization, schema,
 *   tags) and match risk paths, so moving it can change how it builds.
 * - A non-model rename at 100% similarity that keeps the file name, its dbt
 *   role, and its layer (the first folder under the role directory) is a pure
 *   move and is dropped: re-reviewing it would only repeat pre-existing
 *   findings. A move across roles or layers stays in scope.
 * - A rename across the project boundary is a deletion from one project and an
 *   addition to the other: only the side inside `root` is kept, rewritten as
 *   `deleted` (old path) or `added` (new path).
 */
export function scopeToProject(
  files: ChangedFile[],
  root: string | undefined,
  layout?: DbtProjectLayout,
): ScopeResult {
  const outOfScopePaths: string[] = []
  const movedUnchangedPaths: string[] = []
  const inScope: ChangedFile[] = []
  const basename = (p: string) => norm(p).split("/").pop()
  const layoutDirs = layout ? resolvedLayoutDirs(layout).map((d) => d.dir) : []
  const isInside = (p: string) =>
    root === undefined || relativeToRoot(p, root) !== undefined || layoutDirs.some((d) => relativeToRoot(p, d) !== undefined)
  for (const f of files) {
    const inside = isInside(f.path)
    // A rename moving a file into or out of the project still concerns it.
    const oldInside = !!f.oldPath && isInside(f.oldPath)
    if (!inside && !oldInside) {
      outOfScopePaths.push(f.path)
      continue
    }
    if (f.oldPath && inside !== oldInside) {
      const { oldPath, similarity: _similarity, ...rest } = f
      inScope.push(inside ? { ...rest, status: "added" } : { ...rest, path: oldPath, status: "deleted" })
      continue
    }
    if (
      f.status === "renamed" &&
      f.similarity === 100 &&
      f.oldPath &&
      !isModel(f.path, layout) &&
      basename(f.oldPath) === basename(f.path) &&
      classifyDbtFile(f.oldPath, layout) === classifyDbtFile(f.path, layout) &&
      layerOf(f.oldPath, root, layout) === layerOf(f.path, root, layout)
    ) {
      movedUnchangedPaths.push(f.path)
      continue
    }
    inScope.push(f)
  }
  return {
    inScope,
    outOfScope: outOfScopePaths.length,
    movedUnchanged: movedUnchangedPaths.length,
    outOfScopePaths,
    movedUnchangedPaths,
  }
}

/** Heuristic: does a yml diff declare dbt `sources:`? Tolerates unified-diff
 *  line prefixes (`+`/`-`/space) so it matches an added `+sources:` hunk. */
export function looksLikeSourceYml(diff: string | undefined): boolean {
  return !!diff && /^[+\-\s]*sources:\s*$/m.test(diff)
}

/** Heuristic: does a yml diff touch a `contract:` / `enforced:` block? */
export function touchesContract(diff: string | undefined): boolean {
  return !!diff && /\bcontract:|\benforced:\s*true/.test(diff)
}

/** Count added/removed SQL lines in a unified diff hunk. */
export function countChangedLines(diff: string | undefined): number {
  if (!diff) return 0
  let n = 0
  for (const line of diff.split("\n")) {
    if ((line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---"))) n++
  }
  return n
}
