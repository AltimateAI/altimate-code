// altimate_change — ONE atomic writer, shared by every path that writes a mode-restricted file.
//
// There were two: `FSUtil.writeJson` (core) wrote credentials atomically, while
// `Filesystem.write` (opencode) still wrote in place and chmod'd afterwards. Both write the same
// `auth.json`, so the world-readable window the atomic writer was introduced to close was only
// closed on one of them — and a reader seeing "atomic writer, fixed" had no reason to check the
// other. Keeping the sequence in one place is the point: two copies of a delicate
// write/chmod/rename dance drift the moment one of them is fixed.
import * as NFS from "fs/promises"
import { dirname, basename, join } from "path"

function errno(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined
  const code = (err as { code: unknown }).code
  return typeof code === "string" ? code : undefined
}

/**
 * The canonical physical path for `path`, resolving symlinks and filesystem casing.
 *
 * Shared by the atomic writer and the auth store's lock key so both agree on what "the same
 * file" means. Two processes reaching one `auth.json` through different routes — a symlinked
 * XDG data dir, a case-aliased path on macOS — must resolve to the same string, or they take
 * different locks and the lost-credential race reopens.
 *
 * ENOENT is the one expected miss: the target does not exist yet (first credential write) or is
 * a dangling link. Both are handled by canonicalising the PARENT and re-appending the basename,
 * which still collapses symlinks and casing above the leaf. Every other errno — EACCES on an
 * unreadable parent, ELOOP on a symlink cycle, EIO — is a real failure and propagates. Treating
 * those as "no target" is what let the writer replace a valid symlink whose directory was
 * temporarily unreadable, leaving the actual credential file stale.
 */
export async function canonicalPath(path: string): Promise<string> {
  try {
    return await NFS.realpath(path)
  } catch (err) {
    if (errno(err) !== "ENOENT") throw err
  }
  const parent = dirname(path)
  try {
    return join(await NFS.realpath(parent), basename(path))
  } catch (err) {
    // The parent may not exist either (a store being created from scratch). Anything else is
    // still a genuine error.
    if (errno(err) !== "ENOENT") throw err
    return path
  }
}

/**
 * Write `content` to `path` so it is never visible at that path with the wrong permissions.
 *
 * Writes a temp file in the target's directory, sets the mode on it, then renames it over the
 * target. Rename is atomic, so a concurrent reader sees either the whole old file or the whole
 * new one — never a partial write, and never the new bytes under looser permissions.
 *
 * Writing in place is what this replaces: the content lands first and the chmod follows, so the
 * secret sits at its real path under whatever mode the file already had (open(2) ignores the
 * mode argument for an existing file) until the chmod completes — or forever, if the process
 * dies in between.
 *
 * Does NOT create the parent directory. Callers that want that behaviour should catch ENOENT,
 * mkdir, and retry; keeping it out of here means the temp file and the target are always
 * resolved the same way.
 */
export async function writeFileAtomic(
  path: string,
  content: string | Buffer | Uint8Array,
  mode: number,
): Promise<void> {
  return writeFileAtomicResolved(await canonicalPath(path), content, mode)
}

/**
 * `writeFileAtomic` for a target that has ALREADY been canonicalised.
 *
 * Callers that resolve the path themselves — because they also lock on it — must use this. If
 * they went through `writeFileAtomic` the path would be resolved a SECOND time, and a symlink
 * retargeted in between would send the bytes somewhere the lock does not cover: locked A, wrote
 * B. Resolution happens once, at the caller, and the identity it locked is the identity written.
 */
export async function writeFileAtomicResolved(
  target: string,
  content: string | Buffer | Uint8Array,
  mode: number,
): Promise<void> {
  // Same directory as the target, so the rename cannot cross a filesystem boundary. `wx` refuses
  // to reuse a leftover temp file rather than writing secrets into one we do not own.
  const temp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  try {
    await NFS.writeFile(temp, content, { mode, flag: "wx" })
    // `mode` on open() is masked by the process umask, so the file can land MORE restrictive than
    // asked — under `umask 0777` it is created 000 and the next read fails permanently. chmod is
    // not masked, so it sets exactly the requested mode. Done before the rename, so the file is
    // never visible at its real path with the wrong mode; and the open() mode still bounds the
    // temp file's permissions in the meantime, since umask can only clear bits.
    await NFS.chmod(temp, mode)
    await NFS.rename(temp, target)
  } catch (err) {
    await NFS.rm(temp, { force: true }).catch(() => {})
    throw err
  }
}
