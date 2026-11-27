// altimate_change - new file: operator-supplied files that must not come from the PR checkout
import { existsSync, realpathSync } from "node:fs"
import path from "node:path"

/** Every git work tree containing `dir`: each ancestor (realpath) with a `.git` entry, nearest
 *  first, so a nested checkout does not hide the one around it. No git call, so `safe.directory`
 *  or a missing git cannot hide one. Empty outside any work tree. */
export function workTreesOf(dir: string): string[] {
  let d: string
  try {
    d = realpathSync(dir)
  } catch {
    return []
  }
  const out: string[] = []
  for (;;) {
    if (existsSync(path.join(d, ".git"))) out.push(d)
    const up = path.dirname(d)
    if (up === d) return out
    d = up
  }
}

/** True when `p` is `dir` or below it (both absolute, resolved). */
export function isInsideDir(p: string, dir: string): boolean {
  const rel = path.relative(dir, p)
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel))
}

/**
 * The realpath of a file named by the env variable `name`, checked to be outside every work tree
 * the review touches: those enclosing the review's repository (`reviewDirs`) and the process's
 * current directory (the PR checkout in CI). The path must be absolute. Both the realpath and the
 * named path are checked: a symlink inside a work tree is refused whichever way it points (each
 * directory on the named path is resolved, so a linked directory counts where the link is).
 * Callers read the returned realpath. Fails closed: when none of those directories resolves to a
 * work tree, the file is refused, since it cannot be shown to be outside the checkout.
 */
export function trustedFilePath(name: string, file: string, reviewDirs: Array<string | undefined> = []): string {
  if (!path.isAbsolute(file)) throw new Error(`${name} must be an absolute path outside the repository`)
  let real: string
  try {
    real = realpathSync(file)
  } catch (e) {
    // Keeps the errno `code`, so callers can still tell a missing file apart.
    const code = (e as NodeJS.ErrnoException)?.code
    throw Object.assign(new Error(`${name}: the file does not exist or cannot be resolved (${code ?? "error"})`), { code })
  }
  const trees = [...new Set([...reviewDirs, process.cwd()].flatMap((d) => (d ? workTreesOf(d) : [])))]
  if (!trees.length) throw new Error(`${name}: cannot tell whether the file is outside the repository checkout (no git work tree found); refusing it`)
  // The realpath, plus the realpath of every directory on the named path.
  const spots = [real]
  for (let d = path.dirname(path.resolve(file)); ; d = path.dirname(d)) {
    try {
      spots.push(realpathSync(d))
    } catch {}
    if (path.dirname(d) === d) break
  }
  if (trees.some((t) => spots.some((p) => isInsideDir(p, t))))
    throw new Error(`${name} is inside the git work tree; place it outside the checkout`)
  return real
}
