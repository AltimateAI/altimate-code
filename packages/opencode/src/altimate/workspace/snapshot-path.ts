// altimate_change - new file
//
// Whether a path lies inside a workspace skill snapshot (`.altimate-code/skill/_workspace`), judged
// by path segments rather than against one project directory: discovery walks config directories up
// to the worktree, so a session started in `repo/sub` also reads `repo/.altimate-code/...`.
// Dependency-free on purpose — skill discovery imports it, and the workspace modules are heavy.
import path from "path"

const SNAPSHOT_SEGMENTS = [".altimate-code", "skill", "_workspace"]

export function isInWorkspaceSnapshot(location: string): boolean {
  const parts = path.resolve(location).split(path.sep)
  for (let i = 0; i + SNAPSHOT_SEGMENTS.length <= parts.length; i++) {
    if (SNAPSHOT_SEGMENTS.every((segment, j) => parts[i + j] === segment)) return true
  }
  return false
}

/** Whether `location` lies inside `root`, by path segments. */
export function isWithin(root: string, location: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(location))
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel))
}

/** Whether a skill found in the workspace snapshot must yield to a same-name skill already
 * registered at `existingLocation`: only when that one is the user's own, inside the project.
 * Built-in (`builtin:` / `<built-in>`), personal and snapshot entries are overridden as before. */
export function snapshotCopyYields(match: string, existingLocation: unknown, projectRoot: string | undefined): boolean {
  return (
    !!projectRoot &&
    typeof existingLocation === "string" &&
    isInWorkspaceSnapshot(match) &&
    path.isAbsolute(existingLocation) &&
    !isInWorkspaceSnapshot(existingLocation) &&
    isWithin(projectRoot, existingLocation)
  )
}
