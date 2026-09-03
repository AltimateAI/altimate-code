import path from "node:path"
import { readFile, readdir, realpath, stat, access } from "node:fs/promises"
import { Installation } from "../../installation"
import { loadReviewConfig, resolveRubric } from "./config"
import type { Severity } from "./finding"
import { collectChangedFiles, makeContentResolver, defaultBaseRef, gitRepoRoot, manifestHash } from "./git"
import { makeCompiledResolver, dbtProjectName } from "./compiled"
import { buildCatalogSchemaContext } from "./schema-context"
import { createDispatcherRunner } from "./runner"
import { runReview } from "./orchestrate"
import { runAiReview } from "./ai-review"
import type { ReviewMode, VerdictEnvelope } from "./verdict"
import { filterChangedFiles, type ChangedFile } from "./diff-filter"

/**
 * End-to-end review entry point: load `.altimate/review.yml`, collect the diff,
 * run the deterministic recipe against the Rust core, and return a signed
 * verdict envelope. Used by both the `dbt_pr_review` tool and the
 * `altimate review` CLI command so they can never diverge.
 */

export interface ReviewPullRequestOptions {
  cwd: string
  /** Base ref; defaults to merge-base with origin/main. */
  base?: string
  /** Head ref; omit to diff against the working tree. */
  head?: string
  /** Override the manifest path from config. */
  manifestPath?: string
  /** Override the review mode from config. */
  mode?: ReviewMode
  /** Override the minimum severity to surface. */
  severityThreshold?: Severity
  /** Pre-collected changed files (skips git; used by CI providers). */
  changedFiles?: ChangedFile[]
  /** Resolver for file contents (used when changedFiles is pre-supplied). */
  getContent?: (file: string, side: "old" | "new") => Promise<string | undefined>
  /** Model identifier recorded in the envelope. */
  modelVersion?: string
  coreVersion?: string
  /** altimate-code CLI release recorded in engine.cliVersion for audit reconstruction. */
  cliVersion?: string
  /** Disable the LLM reviewer lane (default: enabled; self-degrades if no model). */
  noAi?: boolean
  /** PR metadata for the AI reviewer's intent check. */
  prTitle?: string
  prBody?: string
  /** G1 — surface the tier classifier's reasons on the verdict envelope. */
  explainTier?: boolean
  /** G2 — [EXPERIMENTAL] bypass the tier classifier with the supplied tier.
   *  Envelope carries `tierForced: true` when used. Debug / bench only. */
  forceTier?: "trivial" | "lite" | "full"
}

/** dbt adapter_type → core SQL dialect. Mostly identity; a few aliases. */
const ADAPTER_DIALECT: Record<string, string> = {
  bigquery: "bigquery",
  snowflake: "snowflake",
  redshift: "redshift",
  postgres: "postgres",
  databricks: "databricks",
  spark: "databricks",
  duckdb: "duckdb",
  trino: "trino",
  athena: "athena",
  mysql: "mysql",
  oracle: "oracle",
  sqlserver: "tsql",
  synapse: "tsql",
  fabric: "fabric",
}

/** Read the dbt manifest's `metadata.adapter_type` and map it to a dialect. */
async function detectDialect(manifestAbs: string): Promise<string | undefined> {
  try {
    const raw = await readFile(manifestAbs, "utf8")
    const adapter = String(JSON.parse(raw)?.metadata?.adapter_type ?? "").toLowerCase()
    return ADAPTER_DIALECT[adapter] ?? (adapter || undefined)
  } catch {
    return undefined
  }
}

/**
 * G3 (Round 18) — walk upward from `cwd` looking for the nearest
 * `dbt_project.yml`; if found, return the adjacent `target/manifest.json`
 * (when it exists). Anchored on `dbt_project.yml` so we never pick up a
 * `target/` from an unrelated tool (e.g. an Airflow project) that happens
 * to live above us on the filesystem.
 *
 * We DO NOT re-run `dbt compile` here — that could touch a real warehouse or
 * consume credentials. The customer is still responsible for compiling; we
 * just find the existing artifact when they didn't pass `--manifest`.
 *
 * Returns undefined when no dbt project is found upward, or when the found
 * project has no compiled manifest.
 */
async function autoDiscoverManifest(cwd: string): Promise<{ path: string; projectRoot: string } | undefined> {
  // Walk up looking for dbt_project.yml so the manifest we auto-discover is
  // demonstrably tied to a dbt project (never `target/manifest.json` from an
  // unrelated cwd, e.g. Airflow's `target/`). `path.dirname(root) === root`
  // on every platform, so once we reach the filesystem root the next step
  // is a fixed point — exit at that point (NIT #6 tidy from consensus review).
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    for (const fn of ["dbt_project.yml", "dbt_project.yaml"]) {
      try {
        await access(path.join(dir, fn))
        const candidate = path.join(dir, "target", "manifest.json")
        try {
          await access(candidate)
          return { path: candidate, projectRoot: dir }
        } catch {
          // dbt project found at this dir but no compiled artifact. Do
          // NOT walk further — a grandparent's `target/manifest.json`
          // belongs to that grandparent's project, not to this one, and
          // reviewing against it would compile the wrong DAG. Deliberate:
          // "found a project, it just hasn't been compiled" — silent
          // fallback to a sibling project would surprise the caller
          // (altimate-harness-bot review, PR #1027 run.ts:114).
          return undefined
        }
      } catch {
        /* keep walking */
      }
    }
    if (path.dirname(dir) === dir) return undefined
  }
}

interface CompiledArtifactDirs {
  headDir: string
  baseDir: string
}

async function compiledArtifactDirs(manifestAbs: string, dbtRoot: string): Promise<CompiledArtifactDirs> {
  const manifestDir = path.dirname(manifestAbs)
  const headDir = path.join(manifestDir, "compiled")
  const siblingBaseDir = path.join(`${manifestDir}-base`, "compiled")
  let baseDir = path.join(dbtRoot, "target-base", "compiled")
  try {
    await access(siblingBaseDir)
    baseDir = siblingBaseDir
  } catch {
    /* keep the conventional target-base/compiled fallback */
  }
  return { headDir, baseDir }
}

function artifactDirLabel(dir: string, dbtRoot: string): string {
  return path.relative(dbtRoot, dir).split(path.sep).join("/") || path.basename(dir)
}

async function resolveBaseProjectName(baseDir: string, projectName: string, dbtRoot: string): Promise<string> {
  const baseRoot = path.isAbsolute(baseDir) ? baseDir : path.join(dbtRoot, baseDir)
  try {
    if ((await stat(path.join(baseRoot, projectName))).isDirectory()) return projectName
  } catch {
    /* look for a renamed base project below */
  }

  try {
    const directories = (await readdir(baseRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory())
    if (directories.length === 1) return directories[0]!.name
  } catch {
    /* keep the head project name when the base compiled directory is absent */
  }
  return projectName
}

/** Report missing dbt artifacts only when the manifest itself exists. */
export async function detectArtifactHints(
  manifestAbs: string,
  dbtRoot: string,
  changedModels: Array<Pick<ChangedFile, "path" | "status" | "oldPath">> = [],
  projectName?: string,
  pathPrefix?: string,
  artifactDirs?: CompiledArtifactDirs,
  baseProjectName?: string,
): Promise<string[]> {
  if (changedModels.length === 0) return []

  try {
    await access(manifestAbs)
  } catch {
    return []
  }

  const hints: string[] = []
  try {
    const catalog = JSON.parse(await readFile(path.join(path.dirname(manifestAbs), "catalog.json"), "utf8"))
    const nonEmptyObject = (value: unknown) =>
      value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0
    if (!nonEmptyObject(catalog?.nodes) && !nonEmptyObject(catalog?.sources)) {
      hints.push("catalog.json unreadable or empty (regenerate with `dbt docs generate`)")
    }
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      hints.push("catalog.json (run `dbt docs generate`)")
    } else {
      hints.push("catalog.json unreadable or empty (regenerate with `dbt docs generate`)")
    }
  }

  if (projectName === undefined) {
    hints.push(
      "dbt project name not resolved — no readable dbt_project.yml next to the manifest, so compiled SQL cannot be located",
    )
    return hints
  }

  const { headDir, baseDir } = artifactDirs ?? (await compiledArtifactDirs(manifestAbs, dbtRoot))
  const resolvedBaseProjectName =
    baseProjectName ?? (await resolveBaseProjectName(baseDir, projectName, dbtRoot))
  const getCompiled = makeCompiledResolver({
    cwd: dbtRoot,
    projectName,
    baseProjectName: resolvedBaseProjectName,
    pathPrefix,
    headDir,
    baseDir,
  })
  const baseModels = changedModels.filter((file) => file.status !== "added" && file.status !== "deleted")
  const headModels = changedModels.filter((file) => file.status !== "deleted")
  const [missingBase, missingHead] = await Promise.all([
    Promise.all(baseModels.map((file) => getCompiled(file.oldPath ?? file.path, "old"))).then(
      (contents) => contents.filter((content) => content === undefined).length,
    ),
    Promise.all(headModels.map((file) => getCompiled(file.path, "new"))).then(
      (contents) => contents.filter((content) => content === undefined).length,
    ),
  ])
  if (missingBase > 0) {
    hints.push(`${artifactDirLabel(baseDir, dbtRoot)} missing for ${missingBase} changed model(s) (compile the base ref)`)
  }
  if (missingHead > 0) {
    hints.push(`${artifactDirLabel(headDir, dbtRoot)} missing for ${missingHead} changed model(s) (run \`dbt compile\` for the head)`)
  }
  return hints
}

/** Whether a repo-relative path is one whose modification could invalidate
 *  the compiled manifest — dbt source (SQL, YAML, Python models, seed CSV,
 *  docs markdown blocks) or top-level dbt config. `README.md` at repo root,
 *  `.github/`, `package.json`, etc. are excluded so their mtimes don't
 *  trigger a stale warning. Exported for tests — see review-run-stale.test.ts.
 *  Referenced by `detectStaleManifest`. */
export function isManifestAffecting(rel: string): boolean {
  // Code / schema / seed CSV live under any dbt source directory.
  if (/(^|\/)(models|seeds|snapshots|macros|tests|analyses)\/.*\.(sql|py|yml|yaml|csv)$/i.test(rel)) return true
  // dbt docs blocks (`.md`) are only manifest-affecting under `models/` and
  // `analyses/` — where `{% docs %}` blocks are canonically parsed. A
  // `macros/README.md` / `tests/README.md` / `seeds/README.md` is package
  // documentation, not manifest input (altimate-harness-bot review,
  // PR #1027 run.ts:133).
  if (/(^|\/)(models|analyses)\/.*\.md$/i.test(rel)) return true
  // Top-level dbt project config files.
  if (/(^|\/)(dbt_project|packages|profiles|dependencies)\.ya?ml$/i.test(rel)) return true
  return false
}

/** Detect a stale manifest and warn to stderr. Returns `true` when a
 *  change-affecting file was modified after the manifest — signalling the
 *  verdict may have been computed against out-of-date metadata. Non-fatal;
 *  the review proceeds against the (possibly stale) manifest and the
 *  caller mirrors the flag onto the signed envelope so a downstream
 *  auditor can distinguish stale-manifest verdicts from clean ones
 *  (stderr alone is easy for CI to swallow).
 *
 *  A deleted or renamed manifest-affecting file is treated as unconditionally
 *  stale: the file's mtime cannot be checked (the path is gone) but the
 *  manifest still references it, so the metadata is by definition out of date
 *  (cubic-review PR #1041 — the prior path-only signature silently reported
 *  clean for deletions and could false-certify verdicts against ghost models). */
async function detectStaleManifest(manifestAbs: string, changed: ChangedFile[], fsRoot: string): Promise<boolean> {
  try {
    const manifestMtime = (await stat(manifestAbs)).mtimeMs
    for (const f of changed) {
      // For renamed files, the OLD path is what the manifest still knows about;
      // check both sides so both a rename-away and a rename-to a
      // manifest-affecting shape trigger the signal.
      const paths: string[] = [f.path]
      if (f.status === "renamed" && f.oldPath) paths.push(f.oldPath)
      if (!paths.some(isManifestAffecting)) continue

      // Deleted / renamed files no longer exist at their old path on disk, so
      // stat would fail. The manifest still references them though, so the
      // metadata is stale by definition — fire immediately.
      if (f.status === "deleted" || f.status === "renamed") {
        process.stderr.write(
          `⚠️  manifest ${manifestAbs} appears stale — ${f.status} \`${f.path}\` is a manifest-affecting path. ` +
            `Re-run \`dbt compile\` (or \`dbt build\`) to refresh before reviewing.\n`,
        )
        return true
      }

      // `changed` paths are repo-root relative (from `git diff --name-status`),
      // so root at the git top-level rather than the caller's cwd. When the
      // CLI is invoked from a subdir the naive path.join(cwd, rel) points at
      // a non-existent path and the stale check silently no-ops.
      const abs = path.isAbsolute(f.path) ? f.path : path.join(fsRoot, f.path)
      try {
        const changedMtime = (await stat(abs)).mtimeMs
        if (changedMtime > manifestMtime) {
          process.stderr.write(
            `⚠️  manifest ${manifestAbs} appears stale — ${f.path} was modified after the manifest was written. ` +
              `Re-run \`dbt compile\` (or \`dbt build\`) to refresh before reviewing.\n`,
          )
          return true
        }
      } catch {
        /* file not on disk for an added/modified entry — skip (rare race) */
      }
    }
  } catch {
    /* manifest unreadable → detectDialect will have already returned undefined */
  }
  return false
}

export async function reviewPullRequest(opts: ReviewPullRequestOptions): Promise<VerdictEnvelope> {
  const config = await loadReviewConfig(opts.cwd)
  if (opts.manifestPath) config.manifestPath = opts.manifestPath
  if (opts.mode) config.mode = opts.mode
  if (opts.severityThreshold) config.severityThreshold = opts.severityThreshold
  const rubric = resolveRubric(config)

  // Only resolve a base ref if we actually need git (to collect changed files
  // or to read old/new content). A caller that supplies BOTH `changedFiles` and
  // `getContent` (e.g. a non-git CI integration) must not be forced through a
  // git lookup that can fail when there's no usable history.
  const needGit = !opts.changedFiles || !opts.getContent
  const base = opts.base ?? (needGit ? await defaultBaseRef(opts.cwd, opts.head ?? "HEAD") : "")
  const changedFiles = opts.changedFiles ?? (await collectChangedFiles({ base, head: opts.head, cwd: opts.cwd }))
  // Resolve the repo top-level once; used to root working-tree FS reads, the
  // stale-manifest existence check, and the compiled-SQL resolver's path
  // mapping. Falls back to opts.cwd when we couldn't resolve it (non-git or
  // bare-repo contexts) — safe for the repo-root-invoked case but not helpful
  // in the subdir-invocation case that this addresses.
  const gitRoot = (await gitRepoRoot(opts.cwd)) ?? opts.cwd
  // Map renamed files → their old path so getContent resolves the "old" side
  // from where the file lived at `base`.
  const renames = new Map(
    changedFiles.filter((f) => f.status === "renamed" && f.oldPath).map((f) => [f.path, f.oldPath as string]),
  )
  const getContent =
    opts.getContent ?? makeContentResolver({ base, head: opts.head, cwd: opts.cwd, renames, gitRoot })

  // Resolve the manifest against the PROJECT being reviewed (cwd), not the
  // binary's process.cwd() — otherwise a relative path silently misses when the
  // CLI is invoked from elsewhere, degrading every review to lint-only.
  let manifestAbs = path.isAbsolute(config.manifestPath)
    ? config.manifestPath
    : path.join(opts.cwd, config.manifestPath)
  // The "effective dbt project root" for downstream lookups (dbtProjectName,
  // compiled-SQL resolver). Starts as opts.cwd — G3 auto-discovery updates it
  // when it finds a dbt_project.yml in an ancestor directory, so the compiled
  // resolver and project-name lookups target the discovered project rather
  // than the CLI's working directory (which may be a subdir).
  let dbtRoot = opts.cwd
  // G3 (Round 18) — auto-discovery when the caller didn't pass `--manifest` and
  // the config-relative resolve above doesn't point at an existing file. Walk
  // upward for the dbt project root and use its `target/manifest.json`. Explicit
  // `--manifest` always wins (see run.ts opts.manifestPath override at the top).
  if (!opts.manifestPath) {
    let manifestExists = false
    try {
      await access(manifestAbs)
      manifestExists = true
    } catch {
      /* fall through to auto-discovery */
    }
    if (!manifestExists) {
      const discovered = await autoDiscoverManifest(opts.cwd)
      if (discovered) {
        manifestAbs = discovered.path
        dbtRoot = discovered.projectRoot
        process.stderr.write(
          `ℹ️  auto-discovered dbt manifest at ${discovered.path} ` +
            `(dbt project root: ${discovered.projectRoot}). Pass --manifest to override.\n`,
        )
      }
    }
  }
  // Freshness check: detect (and warn — non-fatal) when the manifest predates
  // change-affecting files. Runs for both the pinned-head CI shape AND the
  // working-tree local shape — the local scenario "dbt compile once, edit for
  // an hour, then altimate review" is where staleness actually bites in
  // practice, so gating this behind `--head` (the prior behavior) silently
  // under-warned the most common developer workflow. mtime granularity on
  // the working tree can be noisy during a live edit session, but the check
  // is limited to files that would materially change the manifest
  // (`isManifestAffecting`), so noise is bounded. Return value is stamped
  // into the signed envelope so downstream auditors see it too.
  const staleManifest = await detectStaleManifest(manifestAbs, changedFiles, gitRoot)

  // Resolve the SQL dialect: explicit config wins; otherwise auto-detect from
  // the dbt manifest's `adapter_type` (so a BigQuery/Redshift project isn't
  // analyzed as the snowflake default — wrong-dialect portability suppression).
  if (!config.dialect) config.dialect = (await detectDialect(manifestAbs)) ?? "snowflake"

  // Prefer dbt's catalog.json (real warehouse columns from `dbt docs generate`)
  // for the schema context — complete columns are what make column-lineage
  // breakage and proven equivalence actually fire (the manifest only has
  // documented columns). Falls back to manifest-derived schema when absent.
  const catalogAbs = path.join(path.dirname(manifestAbs), "catalog.json")
  const catalogSchema = await buildCatalogSchemaContext(catalogAbs)
  const runner = createDispatcherRunner({ manifestPath: manifestAbs, schemaContext: catalogSchema })
  const mhash = await manifestHash(manifestAbs, opts.cwd)

  // Prefer dbt's COMPILED SQL (target/compiled) for the engine lanes — the clean
  // approach (Datafold/Recce/Fusion all render-then-analyze rather than parse Jinja).
  // Use `dbtRoot` (the discovered project root when G3 auto-discovery fired,
  // else opts.cwd) so a subdir invocation still finds `target/compiled/…`
  // next to the discovered manifest instead of falling back to raw Jinja.
  const projectName = await dbtProjectName(dbtRoot)
  // Repo-relative file paths need the git-root → dbt-root prefix stripped
  // so `packages/dbt/models/foo.sql` resolves to `models/foo.sql` inside the
  // dbt project. `path.relative` returns "" when dbtRoot === gitRoot (the
  // repo-root-invoked case) — makeCompiledResolver's `pathPrefix` treats
  // that as a no-op.
  //
  // Canonicalise both roots via `fs.realpath` before computing the relative
  // path. `gitRoot` from `git rev-parse --show-toplevel` is already
  // symlink-resolved; `dbtRoot` is not, so on macOS (`/var` → `/private/var`)
  // or any other symlinked-parent layout the `path.relative` result was a
  // meaningless climb path (`../../var/...`) that never matched incoming
  // repo-relative paths, and compiled SQL was silently missed
  // (cubic-review P2 + kilo suggestion). Falls back gracefully when the
  // realpath call fails (e.g. path deleted mid-run).
  let gitRootReal = gitRoot
  let dbtRootReal = dbtRoot
  try {
    gitRootReal = await realpath(gitRoot)
    dbtRootReal = await realpath(dbtRoot)
  } catch {
    /* keep original values on realpath failure */
  }
  const pathPrefix = path.relative(gitRootReal, dbtRootReal)
  const changedModels = filterChangedFiles(changedFiles, rubric.exclusions.excludeGlobs).filter(
    (file) => file.kind === "model_sql" || file.kind === "python_model",
  )
  const manifestReal = await realpath(manifestAbs).catch(() => manifestAbs)
  const artifactDirs = await compiledArtifactDirs(manifestReal, dbtRootReal)
  const baseProjectName = projectName
    ? await resolveBaseProjectName(artifactDirs.baseDir, projectName, dbtRootReal)
    : undefined
  const artifactHints = await detectArtifactHints(
    manifestAbs,
    dbtRootReal,
    changedModels,
    projectName,
    pathPrefix,
    artifactDirs,
    baseProjectName,
  )
  const getCompiled = opts.getContent
    ? undefined
    : makeCompiledResolver({ cwd: dbtRootReal, projectName, baseProjectName, pathPrefix, ...artifactDirs })

  return runReview({
    changedFiles,
    config,
    rubric,
    mode: config.mode,
    runner,
    getContent,
    getCompiled,
    generatedAt: new Date().toISOString(),
    manifestHash: mhash,
    modelVersion: opts.modelVersion,
    coreVersion: opts.coreVersion,
    // Default cliVersion so agent-invoked callers (dbt_pr_review tool) that
    // don't thread the version get the audit-trail field populated too.
    // Only the CLI command explicitly forwards Installation.VERSION today,
    // so a missing default silently regresses envelope provenance for tool-
    // path verdicts (cubic-review PR #1041).
    cliVersion: opts.cliVersion ?? Installation.VERSION,
    aiReview:
      opts.noAi || config.ai === false
        ? async () => ({ findings: [], status: "skipped" as const, reason: "disabled by configuration" })
        : runAiReview,
    prTitle: opts.prTitle,
    prBody: opts.prBody,
    explainTier: opts.explainTier,
    forceTier: opts.forceTier,
    staleManifest,
    artifactHints,
  })
}
