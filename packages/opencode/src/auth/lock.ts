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
// Keyed on the resolved path rather than a bare name so a process pointed at a different data
// directory (tests, `OPENCODE_TEST_HOME`, an alternate XDG root) takes a different lock instead
// of serializing against unrelated stores.
import path from "path"
import { Global } from "@opencode-ai/core/global"

export const AUTH_FILE = path.join(Global.Path.data, "auth.json")

export const AUTH_LOCK_KEY = `auth-store:${path.resolve(AUTH_FILE)}`
