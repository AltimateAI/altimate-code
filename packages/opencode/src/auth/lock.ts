// altimate_change — fork-local. The canonical cross-process lock key for the shared auth store.
//
// There are TWO Auth implementations that read-modify-write the same `auth.json`: the upstream
// Effect service in `auth/index.ts` and the fork-local `auth/service.ts` (which backs the
// provider auth pipeline). Each does `read all → mutate one key → write all back`, so two
// concurrent writers lose one of the two edits. Since the write is now an atomic rename, the
// loser is not a corrupted entry but a whole credential silently deleted — Codex reproduced it
// 40/40. A per-feature lock (the free-tier registration lock, say) cannot help: it only excludes
// other registrations, not an unrelated provider being authorized at the same moment.
//
// Both `Flock` (promise) and `EffectFlock` (Effect) resolve a key to
// `<state>/locks/<Hash.fast(key)>.lock`, so the same string is the same lock file regardless of
// which API takes it. That is what lets the two implementations exclude each other.
//
// The key is the CANONICAL physical path, not merely an absolute one. `path.resolve` collapses
// `..` and relative segments but leaves symlinks and filesystem casing alone, so two processes
// reaching the same auth.json through a symlinked XDG data dir — or through a case-alias on
// macOS/Windows — would hash different keys, take different locks, and reopen exactly the
// lost-credential race the lock exists to close. `canonicalPath` is the same resolver the atomic
// writer uses to pick its target, so the lock and the write can never disagree about identity.
//
// Resolved once at module load and memoised: the key must be stable for the process, and the
// data directory does not move underneath a running CLI.
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { canonicalPath } from "@opencode-ai/core/util/atomic-write"

export const AUTH_FILE = path.join(Global.Path.data, "auth.json")

let cached: string | undefined

/**
 * Cross-process lock key for `auth.json`, keyed on its canonical physical path.
 *
 * Async because canonicalisation touches the filesystem. Falls back to the resolved-but-not-
 * canonicalised path if that fails outright — a lock on a slightly-wrong key still serialises
 * the common case, whereas throwing here would fail every credential write.
 */
export async function authLockKey(): Promise<string> {
  if (cached) return cached
  const canonical = await canonicalPath(AUTH_FILE).catch(() => path.resolve(AUTH_FILE))
  cached = `auth-store:${canonical}`
  return cached
}
