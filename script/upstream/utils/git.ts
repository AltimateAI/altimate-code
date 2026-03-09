import { execSync } from "child_process"
import { repoRoot } from "./config"

export function git(cmd: string, opts?: { cwd?: string; stdio?: "pipe" | "inherit" }): string {
  const cwd = opts?.cwd ?? repoRoot()
  return execSync(`git ${cmd}`, {
    cwd,
    encoding: "utf-8",
    stdio: opts?.stdio === "inherit" ? "inherit" : "pipe",
    maxBuffer: 50 * 1024 * 1024,
  }).trim()
}

export function gitSafe(cmd: string): string | null {
  try {
    return git(cmd)
  } catch {
    return null
  }
}

export function tagExists(tag: string): boolean {
  return gitSafe(`rev-parse --verify refs/tags/${tag}`) !== null
}

export function branchExists(branch: string): boolean {
  return gitSafe(`rev-parse --verify ${branch}`) !== null
}

export function currentBranch(): string {
  return git("rev-parse --abbrev-ref HEAD")
}

export function hasUncommittedChanges(): boolean {
  // Only check tracked files — untracked files shouldn't block merges
  return git("status --porcelain -uno").length > 0
}

export function conflictedFiles(): string[] {
  const output = gitSafe("diff --name-only --diff-filter=U")
  if (!output) return []
  return output.split("\n").filter(Boolean)
}
