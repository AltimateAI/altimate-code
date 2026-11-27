// altimate_change - new file: operator-supplied files that must not come from the PR checkout
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs"
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
 * current directory (the PR checkout in CI). The path must be absolute. Every path the resolution
 * passes through is checked, not only the realpath: a symlink inside a work tree is refused
 * whichever way it points, also when an outside link leads to it (see `resolutionChain`).
 * Callers read the returned realpath. Fails closed: when none of those directories resolves to a
 * work tree, or the resolution cannot be followed, the file is refused, since it cannot be shown
 * to be outside the checkout.
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
  let spots: string[]
  try {
    spots = [real, ...resolutionChain(file)]
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    throw new Error(`${name}: cannot follow the file's symlinks (${code ?? "error"}); refusing it`)
  }
  // Names the work tree (not the file), so a tree the operator did not expect (a home directory
  // kept in git) is visible.
  const tree = trees.find((t) => spots.some((p) => isInsideDir(p, t)))
  if (tree) throw new Error(`${name} is inside the git work tree ${tree}; place it outside the checkout`)
  return real
}

/** Symlink hops followed before giving up, like the kernel's ELOOP limit. */
const MAX_SYMLINK_HOPS = 40

/**
 * Every path visited while resolving the absolute path `file` one component at a time: each
 * component's location, and through every symlink, each component of its target. A link inside a
 * work tree is on this list even when an outside alias leads to it and its target leads back out.
 * Throws when a component is missing or the links loop.
 */
export function resolutionChain(file: string): string[] {
  const start = path.resolve(file)
  let cur = path.parse(start).root
  const pending = start.slice(cur.length).split(path.sep).filter(Boolean)
  const visited: string[] = []
  let hops = 0
  while (pending.length) {
    const part = pending.shift()!
    if (part === ".") continue
    // `cur` has no symlinks left in it, so its lexical parent is its real parent.
    if (part === "..") {
      cur = path.dirname(cur)
      continue
    }
    const next = path.join(cur, part)
    visited.push(next)
    if (!lstatSync(next).isSymbolicLink()) {
      cur = next
      continue
    }
    if (++hops > MAX_SYMLINK_HOPS) throw Object.assign(new Error("too many symlinks"), { code: "ELOOP" })
    const target = readlinkSync(next)
    if (path.isAbsolute(target)) cur = path.parse(target).root
    pending.unshift(...target.slice(path.isAbsolute(target) ? path.parse(target).root.length : 0).split(path.sep).filter(Boolean))
  }
  visited.push(cur)
  return visited
}
