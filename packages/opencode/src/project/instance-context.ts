import { LocalContext } from "@/util/local-context"
// altimate_change start — upstream_fix: symlink-aware boundary (see containsPath)
import { Filesystem } from "@/util/filesystem"
// altimate_change end
import type * as Project from "./project"

export interface InstanceContext {
  directory: string
  worktree: string
  project: Project.Info
}

export const context = LocalContext.create<InstanceContext>("instance")

/**
 * Check if a path is within the project boundary.
 * Returns true if path is inside ctx.directory OR ctx.worktree.
 * Paths within the worktree but outside the working directory should not trigger external_directory permission.
 */
export function containsPath(filepath: string, ctx: InstanceContext): boolean {
  // altimate_change start — upstream_fix: SYMLINK-AWARE boundary check. The v1.17.9 merge introduced
  // this lexical copy of containsPath and rewired external-directory.ts (grep/glob/ls + the
  // external_directory permission) to it, reverting #209's symlink-escape protection that
  // Instance.containsPath still carries. A purely lexical FSUtil.contains() is bypassable: an
  // in-project symlink to an external dir (e.g. `project/x -> /Users/victim/.ssh`) passes the check,
  // so grep/glob would search outside the project WITHOUT the external_directory prompt
  // (CVE-class GHSA-w5fx-fh39-j5rw / CVE-2025-54794). Filesystem.containsReal resolves real paths
  // (and walks to the nearest existing ancestor for write targets), matching Instance.containsPath.
  if (Filesystem.containsReal(ctx.directory, filepath)) return true
  // Non-git projects set worktree to "/" which would match ANY absolute path.
  // Skip worktree check in this case to preserve external_directory permissions.
  if (ctx.worktree === "/") return false
  return Filesystem.containsReal(ctx.worktree, filepath)
  // altimate_change end
}
