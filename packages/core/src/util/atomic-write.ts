// altimate_change — ONE atomic writer, shared by every path that writes a mode-restricted file.
//
// There were two: `FSUtil.writeJson` (core) wrote credentials atomically, while
// `Filesystem.write` (opencode) still wrote in place and chmod'd afterwards. Both write the same
// `auth.json`, so the world-readable window the atomic writer was introduced to close was only
// closed on one of them — and a reader seeing "atomic writer, fixed" had no reason to check the
// other. Keeping the sequence in one place is the point: two copies of a delicate
// write/chmod/rename dance drift the moment one of them is fixed.
import * as NFS from "fs/promises"

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
  // Follow a symlink to its target and replace THAT, rather than replacing the link with a
  // regular file. Writing in place used to update the target, so someone who symlinks auth.json
  // into a dotfiles repo or a managed directory keeps working; renaming over the link would
  // silently strip it and leave the real file stale. A dangling link has no target to resolve
  // and falls back to replacing the link itself.
  const target = await NFS.realpath(path).catch(() => path)
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
