// Synchronous git utilities for upstream merge tooling.
// Uses execSync for simplicity — these are CLI scripts, not servers.

import { execSync } from "child_process"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/** Resolve the repository root (three levels up from utils/). */
function repoRoot(): string {
  return path.resolve(__dirname, "..", "..", "..")
}

/**
 * Execute a git command synchronously and return trimmed stdout.
 * Throws on non-zero exit code.
 */
export function git(cmd: string): string {
  return execSync(`git ${cmd}`, {
    cwd: repoRoot(),
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
  }).trim()
}

/**
 * Execute a git command synchronously, returning trimmed stdout on success
 * or null on failure (non-zero exit).
 */
export function gitSafe(cmd: string): string | null {
  try {
    return git(cmd)
  } catch {
    return null
  }
}

/** Check whether a tag exists locally. */
export function tagExists(tag: string): boolean {
  return gitSafe(`rev-parse --verify "refs/tags/${tag}"`) !== null
}

/** Check whether a branch exists locally or as a remote tracking ref. */
export function branchExists(branch: string): boolean {
  return gitSafe(`rev-parse --verify "${branch}"`) !== null
}

/** Get the name of the currently checked-out branch. */
export function currentBranch(): string {
  return git("rev-parse --abbrev-ref HEAD")
}

/** Return true if the working tree has uncommitted changes to tracked files. */
export function hasUncommittedChanges(): boolean {
  const status = git("status --porcelain -uno")
  return status.length > 0
}

/** List files with merge conflicts (unmerged paths). */
export function conflictedFiles(): string[] {
  const output = gitSafe("diff --name-only --diff-filter=U")
  if (!output) return []
  return output.split("\n").filter((f) => f.length > 0)
}

// ---------------------------------------------------------------------------
// Async convenience wrappers (used by merge.ts via `import * as git`)
// ---------------------------------------------------------------------------

/** Get the name of the currently checked-out branch (async). */
export async function getCurrentBranch(): Promise<string> {
  return currentBranch()
}

/** Return true if the working directory has no uncommitted changes (async). */
export async function isClean(): Promise<boolean> {
  return !hasUncommittedChanges()
}

/** List all tracked files in the repository. */
export async function getTrackedFiles(): Promise<string[]> {
  return git("ls-files").split("\n").filter((f) => f.length > 0)
}

/** List files modified between the given base ref and HEAD. */
export async function getModifiedFiles(base: string): Promise<string[]> {
  return git(`diff --name-only ${base}...HEAD`).split("\n").filter((f) => f.length > 0)
}

/** Stage all changes to tracked files (avoids picking up untracked experiment dirs). */
export async function stageAll(): Promise<void> {
  git("add -u")
}

/** Stage specific files. */
export async function stageFiles(files: string[]): Promise<void> {
  if (files.length === 0) return
  // Stage in batches to avoid arg-list-too-long
  const batchSize = 100
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize)
    git(`add -- ${batch.map((f) => JSON.stringify(f)).join(" ")}`)
  }
}

/** Create a commit with the given message. */
export async function commit(message: string): Promise<void> {
  execSync(`git commit -m ${JSON.stringify(message)}`, {
    cwd: repoRoot(),
    encoding: "utf-8",
  })
}

/** Fetch all refs from a remote. Uses --force for tags to handle local/upstream tag conflicts. */
export async function fetchRemote(remote: string): Promise<void> {
  git(`fetch ${remote} --tags --force`)
}

/** List all tags from a remote, returned as an array of tag names. */
export async function getTags(remote: string): Promise<string[]> {
  const result = git(`ls-remote --tags ${remote}`)
  return result
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const ref = line.split("\t")[1] ?? ""
      return ref.replace("refs/tags/", "").replace("^{}", "")
    })
    .filter((tag) => tag.length > 0)
    .filter((tag, i, arr) => arr.indexOf(tag) === i)
}

/** Check whether a named remote already exists. */
export async function hasRemote(name: string): Promise<boolean> {
  const result = gitSafe("remote")
  if (!result) return false
  return result.split("\n").some((r) => r.trim() === name)
}

/** Add a new remote with the given name and URL. */
export async function addRemote(name: string, url: string): Promise<void> {
  git(`remote add ${name} ${url}`)
}

/**
 * Create a new branch. Optionally specify a starting point.
 */
export async function createBranch(name: string, from?: string): Promise<void> {
  if (from) {
    git(`checkout -b ${name} ${from}`)
  } else {
    git(`checkout -b ${name}`)
  }
}

/** Switch to an existing branch. */
export async function checkout(branch: string): Promise<void> {
  git(`checkout ${branch}`)
}

/**
 * Merge a ref into the current branch.
 * Returns success status and a list of conflicting files (if any).
 */
export async function merge(
  ref: string,
): Promise<{ success: boolean; conflicts: string[] }> {
  const result = gitSafe(`merge ${ref} --no-edit`)
  if (result !== null) {
    return { success: true, conflicts: [] }
  }
  return { success: false, conflicts: conflictedFiles() }
}
