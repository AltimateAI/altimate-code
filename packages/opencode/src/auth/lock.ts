// altimate_change — fork-local. Resolution of the shared auth store: the physical file to write,
// and the cross-process lock key naming it.
//
// There are TWO Auth implementations that read-modify-write the same `auth.json`: the upstream
// Effect service in `auth/index.ts` and the fork-local `auth/service.ts` (which backs the
// provider auth pipeline). Each does `read all → mutate one key → write all back`, so two
// concurrent writers lose one of the two edits. Since the write is an atomic rename, the loser is
// not a corrupted entry but a whole credential silently deleted. A per-feature lock cannot help:
// the writers are unrelated features sharing one file.
//
// Both `Flock` (promise) and `EffectFlock` (Effect) resolve a key to
// `<state>/locks/<Hash.fast(key)>.lock`, so the same string is the same lock file regardless of
// which API takes it. That is what lets the two implementations exclude each other.
//
// THE LOCK AND THE WRITE MUST NAME THE SAME FILE, and sharing the resolver function is not enough
// to guarantee that — the first version of this shared resolver CODE but not resolution STATE.
// It cached one canonical path forever (and swallowed EACCES/ELOOP into a lexical fallback) while
// every write re-ran realpath independently. After permissions recovered, a symlink retargeted, or
// a missing parent appeared through an alias, the two disagreed: one process locked the stale key
// while writing the file another process was rewriting under a different key. That is the
// lost-credential race, reopened by the fix meant to close it.
//
// So: resolve ONCE per mutation, and use that one resolved target for BOTH the lock key and the
// write path. Passing the resolved target as the write path is what couples them — the writer
// canonicalises its argument, and canonicalising an already-physical path returns it unchanged,
// so the bytes land exactly where the lock says. No caching, and non-ENOENT errors propagate
// rather than degrading to a lexical guess.
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { canonicalPath } from "@opencode-ai/core/util/atomic-write"

/** The configured location. Reads use this directly — following a symlink to read is correct. */
export const AUTH_FILE = path.join(Global.Path.data, "auth.json")

export interface AuthTarget {
  /** Physical path to write. Pass this as the writer's path so lock and write cannot diverge. */
  readonly target: string
  /** Cross-process lock key naming that same physical path. */
  readonly lockKey: string
}

/**
 * Resolve the auth store for one mutation.
 *
 * Call once per read-modify-write and use both fields. Throws if the path cannot be resolved for
 * any reason other than "does not exist yet" — an unreadable parent or a symlink cycle is a real
 * failure, and treating it as "no file here" is how a valid symlink ends up replaced.
 */
export async function resolveAuthTarget(): Promise<AuthTarget> {
  const target = await canonicalPath(AUTH_FILE)
  return { target, lockKey: `auth-store:${target}` }
}

/**
 * Whether a read failure means "the store does not exist yet" rather than "the read failed".
 *
 * Only the first is safe to treat as an empty store. Both mutations do
 * `read everything → change one key → write everything back`, and the write is an atomic replace,
 * so a read that degrades to `{}` does not lose the one entry being touched — it deletes EVERY
 * provider's credentials. An `EACCES` while a directory is momentarily unreadable, an `EIO`, or a
 * half-written file that fails to parse are all real failures, and the mutation must abort rather
 * than rewrite the store from an empty snapshot.
 *
 * The chain is walked because the errno arrives wrapped differently on each path: node's `readFile`
 * rejects with `code: "ENOENT"` directly, while Effect's FileSystem raises a `PlatformError` whose
 * `reason` is the tagged `NotFound` and which carries the original error underneath.
 */
export function isStoreMissing(err: unknown): boolean {
  const seen = new Set<unknown>()
  let current: unknown = err
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current)
    const record = current as { code?: unknown; reason?: unknown; cause?: unknown }
    if (record.code === "ENOENT") return true
    // `reason` is a tagged value on Effect's PlatformError and a plain string on some adapters.
    if (record.reason === "NotFound") return true
    if (typeof record.reason === "object" && record.reason !== null) {
      if ((record.reason as { _tag?: unknown })._tag === "NotFound") return true
    }
    current = record.cause
  }
  return false
}
