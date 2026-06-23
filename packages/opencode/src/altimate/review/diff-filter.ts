/**
 * dbt-aware diff filtering.
 *
 * Cloudflare strips lock files / vendored / minified / generated assets but
 * deliberately keeps migrations. The dbt analogue: strip build artifacts and
 * vendored packages, but NEVER skip the things that change data semantics —
 * snapshots, macros, schema.yml contract blocks, seeds.
 */

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

/** Classify a changed file by its role in a dbt project. */
export function classifyDbtFile(path: string): DbtFileKind {
  const p = path.replace(/\\/g, "/").toLowerCase()
  const isYaml = p.endsWith(".yml") || p.endsWith(".yaml")
  if (/(^|\/)(dbt_project|profiles|packages|dependencies)\.ya?ml$/.test(p)) return "project_config"
  if (/(^|\/)macros\//.test(p)) return "macro"
  if (/(^|\/)snapshots\//.test(p)) return "snapshot"
  if (/(^|\/)seeds\//.test(p) && p.endsWith(".csv")) return "seed"
  if (/(^|\/)tests\//.test(p) && p.endsWith(".sql")) return "test"
  if (/(^|\/)analyses\//.test(p)) return "analysis"
  if (/(^|\/)models\//.test(p) && p.endsWith(".py")) return "python_model"
  if (/(^|\/)models\//.test(p) && p.endsWith(".sql")) return "model_sql"
  if (isYaml && /(^|\/)(models|snapshots|seeds|tests)\//.test(p)) return "schema_yml"
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

/** Filter changed files down to the reviewable set, with their dbt kind. */
export function filterChangedFiles(
  files: ChangedFile[],
  extraExcludeGlobs: string[] = [],
): Array<ChangedFile & { kind: DbtFileKind }> {
  const excluders = extraExcludeGlobs.map(globToRegExp)
  // Normalize to forward slashes so `/`-based glob semantics hold on Windows paths.
  const norm = (p: string) => p.replace(/\\/g, "/")
  return files
    .filter((f) => shouldReview(f.path))
    .filter((f) => !excluders.some((re) => re.test(norm(f.path))))
    .map((f) => ({ ...f, kind: classifyDbtFile(f.path) }))
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
