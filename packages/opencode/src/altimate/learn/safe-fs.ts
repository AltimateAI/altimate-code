// altimate_change - new file
import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"

export class UnsafeLearnPathError extends Error {}

function within(directory: string, file: string) {
  const relative = path.relative(directory, file)
  return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)
}

/** Reject even in-project and dangling symlinks, including every ancestor below the project root. */
export async function assertSafePath(root: string, file: string, expectedDirectory = path.join(root, ".altimate-code", "learn")) {
  const base = path.resolve(root)
  const expected = path.resolve(expectedDirectory)
  const target = path.resolve(file)
  if (!within(base, expected) || !within(expected, target))
    throw new UnsafeLearnPathError(`Learn path escapes its expected directory: ${file}`)
  // The root itself may have a platform alias (e.g. /tmp on macOS). Only descendants are untrusted.
  const resolvedRoot = await fs.realpath(base)
  const resolvedExpected = path.resolve(resolvedRoot, path.relative(base, expected))
  let current = resolvedRoot
  const parts = path.relative(base, target).split(path.sep).filter(Boolean)
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i])
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!stat) break
    if (stat.isSymbolicLink()) throw new UnsafeLearnPathError(`Learn path must not contain a symlink: ${current}`)
    if (i < parts.length - 1 && !stat.isDirectory())
      throw new UnsafeLearnPathError(`Learn path ancestor must be a directory: ${current}`)
    if (!stat.isDirectory() && !stat.isFile())
      throw new UnsafeLearnPathError(`Learn path must be a regular file or directory: ${current}`)
    const resolved = await fs.realpath(current)
    if (resolved !== current || (within(resolvedExpected, current) && !within(resolvedExpected, resolved)))
      throw new UnsafeLearnPathError(`Learn path resolves outside its expected directory: ${current}`)
  }
  return target
}

export async function mkdir(root: string, directory: string, expectedDirectory?: string) {
  const checked = await assertSafePath(root, directory, expectedDirectory)
  const base = await fs.realpath(root)
  const target = path.resolve(base, path.relative(path.resolve(root), checked))
  let current = base
  for (const part of path.relative(base, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    // Check before every mkdir; recursive mkdir alone follows existing ancestor symlinks.
    await assertSafePath(base, current, base)
    await fs.mkdir(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error
    })
    const checked = await assertSafePath(base, current, base)
    if (!(await fs.lstat(checked)).isDirectory()) throw new UnsafeLearnPathError(`Learn path must be a directory: ${current}`)
  }
}

export async function open(root: string, file: string, flags: number, mode?: number, expectedDirectory?: string) {
  const target = await assertSafePath(root, file, expectedDirectory)
  const handle = await fs.open(target, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, mode).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ELOOP") throw new UnsafeLearnPathError(`Learn path must not be a symlink: ${file}`)
    throw error
  })
  try {
    if (!(await handle.stat()).isFile()) throw new UnsafeLearnPathError(`Learn path must be a regular file: ${file}`)
    await assertSafePath(root, file, expectedDirectory)
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}

export async function rename(root: string, from: string, to: string, expectedDirectory?: string) {
  const source = await assertSafePath(root, from, expectedDirectory)
  const target = await assertSafePath(root, to, expectedDirectory)
  await fs.rename(source, target)
}

export async function remove(root: string, file: string, expectedDirectory?: string) {
  await fs.rm(await assertSafePath(root, file, expectedDirectory), { force: true })
}
