import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { promises as fs } from "node:fs"
import path from "node:path"
import type { ChangedFile } from "./diff-filter"

/**
 * Git helpers for the review pipeline. Produces the ChangedFile[] for a PR
 * (base..head) and a content resolver for old/new file versions, used by both
 * the dbt_pr_review tool and the `altimate review` CLI command.
 */

const exec = promisify(execFile)

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

function parseStatus(code: string): ChangedFile["status"] {
  if (code.startsWith("A")) return "added"
  if (code.startsWith("D")) return "deleted"
  if (code.startsWith("R")) return "renamed"
  return "modified"
}

/** Rename similarity from a `--name-status` code such as `R087`; undefined otherwise. */
function parseSimilarity(code: string): number | undefined {
  const m = /^R(\d{1,3})$/.exec(code)
  return m ? Number(m[1]) : undefined
}

export interface CollectOptions {
  base: string
  /** Omit to diff against the working tree. */
  head?: string
  cwd: string
}

/** Collect changed files between base and head (or working tree).
 *
 *  `base` should be the merge-base SHA (see `resolveReviewBase`), so the
 *  two-dot working-tree diff and the three-dot `base...head` diff mean the same
 *  thing: only what the PR changed, never commits the target branch gained
 *  after the PR branched. */
export async function collectChangedFiles(opts: CollectOptions): Promise<ChangedFile[]> {
  const range = opts.head ? [`${opts.base}...${opts.head}`] : [opts.base]
  const nameStatus = await git(["diff", "--name-status", "-M", ...range], opts.cwd)

  // Parse the name-status lines first, then fetch per-file hunk diffs
  // concurrently — a large PR must not spawn N serial git processes.
  const entries: Array<{ status: ChangedFile["status"]; newPath: string; oldPath?: string; similarity?: number }> = []
  for (const line of nameStatus.split("\n")) {
    if (!line.trim()) continue
    const parts = line.split("\t")
    const status = parseStatus(parts[0])
    const oldPath = status === "renamed" ? parts[1] : undefined
    const newPath = status === "renamed" ? parts[2] : parts[1]
    if (!newPath) continue
    entries.push({ status, newPath, oldPath, similarity: status === "renamed" ? parseSimilarity(parts[0]) : undefined })
  }

  return Promise.all(
    entries.map(async ({ status, newPath, oldPath, similarity }) => {
      // A rename's hunk diff must name BOTH paths: limiting the pathspec to the
      // new path hides the old one from git, so it cannot pair the rename and
      // reports every line as added.
      const pathspec = oldPath ? [oldPath, newPath] : [newPath]
      let diff = ""
      try {
        diff = await git(["diff", "-M", ...range, "--", ...pathspec], opts.cwd)
      } catch {
        diff = ""
      }
      return { path: newPath, status, diff, oldPath, similarity } satisfies ChangedFile
    }),
  )
}

/** Read the given file only when its realpath sits inside the resolved root.
 *  Blocks the "tracked symlink escapes the root" class of attack — e.g. a
 *  `models/evil.sql → /etc/passwd` symlink that would otherwise leak external
 *  files into the review pipeline (coderabbit + cubic security review).
 *  Returns undefined when the target escapes, is missing, or realpath fails.
 *
 *  Exported for the compiled-SQL resolver in compiled.ts so both content
 *  paths go through the same containment check — cubic + kilo suggested
 *  extracting the shared helper so a future security tweak (Windows
 *  case-sensitivity, trailing separator) can't leave one call site
 *  behind. */
export async function safeReadInside(root: string, rel: string): Promise<string | undefined> {
  try {
    // Realpath both sides so a symlink IN the repo, or a repo checked out
    // under a symlinked path (`/var` → `/private/var` on macOS), still
    // compares apples to apples. Missing realpath calls on the target fail
    // fast into the catch (no read attempted).
    const rootReal = await fs.realpath(root)
    const targetReal = await fs.realpath(path.join(root, rel))
    // Ensure `targetReal` is inside `rootReal` using a separator-aware
    // startsWith check so `/repo-backup` doesn't count as inside `/repo`.
    const sep = path.sep
    if (targetReal !== rootReal && !targetReal.startsWith(rootReal + sep)) return undefined
    return await fs.readFile(targetReal, "utf8")
  } catch {
    return undefined
  }
}

/** Build a getContent(path, side) resolver over git refs / the working tree.
 *  `renames` maps a new path → its old path so the "old" side of a renamed file
 *  resolves from where it actually lived at `base` (not the post-rename path).
 *  `gitRoot` is the repository top-level (from `git rev-parse --show-toplevel`).
 *  When omitted, working-tree reads fall back to `opts.cwd`, which is only
 *  correct when the CLI is invoked from the repo root. */
export function makeContentResolver(opts: CollectOptions & { renames?: Map<string, string>; gitRoot?: string }) {
  return async (file: string, side: "old" | "new"): Promise<string | undefined> => {
    try {
      if (side === "old") {
        const oldFile = opts.renames?.get(file) ?? file
        return await git(["show", `${opts.base}:${oldFile}`], opts.cwd)
      }
      if (opts.head) {
        return await git(["show", `${opts.head}:${file}`], opts.cwd)
      }
      // File paths from `git diff --name-status` are repo-root relative,
      // NOT `opts.cwd` relative. When the CLI is invoked from a subdirectory
      // the naive `path.join(opts.cwd, file)` double-joins and fails ENOENT,
      // returning undefined and silently demoting downstream detectors to
      // the diff-only fallback. Root at the resolved git top-level when
      // supplied by the caller; fall back to `opts.cwd` when we couldn't
      // resolve it (non-git or bare-repo contexts). Reads are containment-
      // checked (symlink-safe) — see safeReadInside.
      const root = opts.gitRoot ?? opts.cwd
      return await safeReadInside(root, file)
    } catch {
      return undefined
    }
  }
}

/** Resolve the repository top-level (`git rev-parse --show-toplevel`).
 *  Used to root working-tree FS reads and existence checks at the repo root
 *  regardless of the caller's cwd. Returns undefined outside a git repo.
 *  Strips only the git-emitted terminator (`\r\n` or `\n`) rather than
 *  `trim()` — a path with legitimate leading/trailing whitespace stays
 *  intact (cubic-review P3). */
export async function gitRepoRoot(cwd: string): Promise<string | undefined> {
  try {
    const out = await git(["rev-parse", "--show-toplevel"], cwd)
    const root = out.replace(/[\r\n]+$/, "")
    return root || undefined
  } catch {
    return undefined
  }
}

/** Where the review's base came from, recorded on the verdict envelope. */
export type BaseSource =
  | "flag" // --base
  | "github_event" // pull_request.base.ref in GITHUB_EVENT_PATH
  | "github_env" // GITHUB_BASE_REF
  | "gitlab_env" // CI_MERGE_REQUEST_TARGET_BRANCH_NAME
  | "remote_default" // refs/remotes/origin/HEAD
  | "default_branch" // origin/main, origin/master, main, master
  | "parent" // <head>~1, nothing else resolved

export interface ResolvedBase {
  /** The ref the base was resolved from (e.g. `origin/deployment`). */
  ref: string
  /** Merge-base of `ref` and the head: the commit the diff and the old side use. */
  sha: string
  source: BaseSource
}

export interface ResolveBaseOptions {
  cwd: string
  /** Explicit `--base`. */
  base?: string
  /** Head ref; omit for the working tree (merge-base uses HEAD). */
  head?: string
  /** Defaults to process.env; injected by tests. */
  env?: NodeJS.ProcessEnv
}

async function mergeBase(a: string, b: string, cwd: string): Promise<string | undefined> {
  try {
    const out = (await git(["merge-base", a, b], cwd)).trim()
    return out || undefined
  } catch {
    return undefined
  }
}

/** The PR's target branch from the CI provider, when the run is for a PR/MR. */
async function ciTargetBranch(env: NodeJS.ProcessEnv): Promise<{ branch: string; source: BaseSource } | undefined> {
  if (env.GITHUB_EVENT_PATH) {
    try {
      const event = JSON.parse(await fs.readFile(env.GITHUB_EVENT_PATH, "utf8"))
      const ref = event?.pull_request?.base?.ref
      if (typeof ref === "string" && ref) return { branch: ref, source: "github_event" }
    } catch {
      // Unreadable event file: fall through to the plain env vars.
    }
  }
  if (env.GITHUB_BASE_REF) return { branch: env.GITHUB_BASE_REF, source: "github_env" }
  if (env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME)
    return { branch: env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME, source: "gitlab_env" }
  return undefined
}

/**
 * Resolve the review base: the PR's real target branch, reduced to the
 * merge-base with the head so the diff contains only the PR's own changes.
 *
 * Order: explicit `--base`; the CI provider's PR/MR target branch; the
 * remote's default branch; main/master; the head's parent. When CI names a
 * target branch that cannot be resolved locally (usually a shallow checkout),
 * this throws instead of silently diffing against another branch — that guess
 * is what made PRs into a non-default branch review hundreds of unrelated files.
 */
export async function resolveReviewBase(opts: ResolveBaseOptions): Promise<ResolvedBase> {
  const head = opts.head ?? "HEAD"
  const env = opts.env ?? process.env

  if (opts.base) {
    const sha = await mergeBase(opts.base, head, opts.cwd)
    if (!sha) throw new Error(`--base ${opts.base}: no merge-base with ${head}. Fetch the base branch (fetch-depth: 0).`)
    return { ref: opts.base, sha, source: "flag" }
  }

  const target = await ciTargetBranch(env)
  if (target) {
    for (const ref of [`origin/${target.branch}`, target.branch]) {
      const sha = await mergeBase(ref, head, opts.cwd)
      if (sha) return { ref, sha, source: target.source }
    }
    throw new Error(
      `PR target branch '${target.branch}' (${target.source}) is not available locally. ` +
        `Fetch it (actions/checkout with fetch-depth: 0, or git fetch origin ${target.branch}) or pass --base.`,
    )
  }

  try {
    const remoteHead = (await git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], opts.cwd)).trim()
    const ref = remoteHead.replace(/^refs\/remotes\//, "")
    const sha = ref ? await mergeBase(ref, head, opts.cwd) : undefined
    if (sha) return { ref, sha, source: "remote_default" }
  } catch {
    // origin/HEAD not set (common in CI clones): try the conventional names.
  }

  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    const sha = await mergeBase(ref, head, opts.cwd)
    if (sha) return { ref, sha, source: "default_branch" }
  }

  // The head's parent, so a custom --head is never compared against an
  // unrelated checkout commit.
  const parent = `${head}~1`
  const sha = (await git(["rev-parse", parent], opts.cwd).catch(() => parent)).trim()
  return { ref: parent, sha, source: "parent" }
}

/** File content at a commit (`git show <ref>:<path>`), or undefined when the
 *  path does not exist there. `rel` is repository-relative, POSIX. */
export async function showAtRef(cwd: string, ref: string, rel: string): Promise<string | undefined> {
  try {
    return await git(["show", `${ref}:${rel}`], cwd)
  } catch {
    return undefined
  }
}

/** Resolve a default base SHA. Kept for callers that only need the commit. */
export async function defaultBaseRef(cwd: string, head?: string): Promise<string> {
  return (await resolveReviewBase({ cwd, head })).sha
}

/** Compute a short hash of the manifest file for the verdict envelope. */
export async function manifestHash(manifestPath: string, cwd: string): Promise<string | undefined> {
  try {
    const { createHash } = await import("node:crypto")
    const buf = await fs.readFile(path.isAbsolute(manifestPath) ? manifestPath : path.join(cwd, manifestPath))
    return createHash("sha256").update(buf).digest("hex").slice(0, 16)
  } catch {
    return undefined
  }
}
