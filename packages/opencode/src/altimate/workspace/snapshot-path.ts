// altimate_change - new file
//
// Whether a path lies inside a workspace skill snapshot (`.altimate-code/skill/_workspace`), judged
// by path segments rather than against one project directory: discovery walks config directories up
// to the worktree, so a session started in `repo/sub` also reads `repo/.altimate-code/...`.
// Dependency-free on purpose — skill discovery imports it, and the workspace modules are heavy.
import path from "path"

const SNAPSHOT_SEGMENTS = [".altimate-code", "skill", "_workspace"]

/** The project a path belongs to, if the path lies inside that project's managed snapshot; `null`
 * otherwise.
 *
 * A project opened AT the filesystem root puts the snapshot's first segment at index 0, which is a
 * project of `/` and not "no project" — the difference decides whether discovery gates the file or
 * serves it, so it is spelled out rather than left to a truthiness test. (review) */
export function snapshotProjectOf(location: string, p: path.PlatformPath = path): string | null {
  const resolved = p.resolve(location)
  const parts = resolved.split(p.sep)
  for (let i = 0; i + SNAPSHOT_SEGMENTS.length <= parts.length; i++) {
    if (SNAPSHOT_SEGMENTS.every((segment, j) => parts[i + j] === segment)) {
      const project = parts.slice(0, i).join(p.sep)
      // A project at the filesystem root: "" is the POSIX root (`/`); `project + sep === root`
      // is a drive root (`C:` + `\`), a UNC share root, or a `\\?\C:\` long-path root. Return
      // the root as the platform writes it, not the bare drive `C:`, which `resolve` reads as
      // the drive's current directory.
      const root = p.parse(resolved).root
      return project === "" || project + p.sep === root ? root : project
    }
  }
  return null
}

export function isInWorkspaceSnapshot(location: string): boolean {
  return snapshotProjectOf(location) !== null
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
