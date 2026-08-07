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
