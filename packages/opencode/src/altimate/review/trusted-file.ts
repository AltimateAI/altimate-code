// altimate_change - new file: operator-supplied files that must not come from the PR checkout
import { existsSync, realpathSync } from "node:fs"
import path from "node:path"

/** The git work tree containing `dir`: the nearest ancestor (realpath) with a `.git` entry. No git
 *  call, so `safe.directory` or a missing git cannot hide it. Undefined outside a work tree. */
export function workTreeOf(dir: string): string | undefined {
  let d: string
  try {
    d = realpathSync(dir)
  } catch {
    return undefined
  }
  for (;;) {
    if (existsSync(path.join(d, ".git"))) return d
    const up = path.dirname(d)
    if (up === d) return undefined
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
 * the review touches: the review's repository (`reviewDirs`) and the process's current directory
 * (the PR checkout in CI). The path must be absolute; symlinks are followed before the check, and
 * callers read the returned realpath. Fails closed: when none of those directories resolves to a
 * work tree, the file is refused, since it cannot be shown to be outside the checkout.
 */
export function trustedFilePath(name: string, file: string, reviewDirs: Array<string | undefined> = []): string {
  if (!path.isAbsolute(file)) throw new Error(`${name} must be an absolute path outside the repository`)
  const real = realpathSync(file)
  const trees = [...new Set([...reviewDirs, process.cwd()].flatMap((d) => (d ? [workTreeOf(d)] : [])).filter((t): t is string => !!t))]
  if (!trees.length) throw new Error(`${name}: cannot tell whether the file is outside the repository checkout (no git work tree found); refusing it`)
  if (trees.some((t) => isInsideDir(real, t)))
    throw new Error(`${name} is inside the git work tree; place it outside the checkout`)
  return real
}
