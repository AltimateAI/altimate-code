/**
 * altimate_change — regression tests for the shared `auth.json` store.
 *
 * Two bugs, both of which only appear under concurrency or an unusual environment, which is
 * exactly why they got past review:
 *
 *   1. Every writer does `read the whole file → change one key → write the whole file back`.
 *      Two concurrent writers each read the same starting state, so the second rename discards
 *      the first one's edit. Because the write is atomic, the casualty is not a corrupted entry
 *      but an entire credential silently deleted — a user re-authenticating one provider while
 *      another CLI stored a different one loses the other outright. A per-feature lock does not
 *      help; the writers are unrelated features sharing one file.
 *
 *   2. `writeFile(temp, content, { mode })` passes the mode to open(2), where it is masked by
 *      the process umask. Under a hostile umask the credential file lands more restrictive than
 *      requested — at `umask 0777` it is created mode 000 and can never be read again.
 *
 * Isolation: `test/preload.ts` points XDG_DATA_HOME at a per-pid tmp dir before any `src/`
 * import, so `Global.Path.data` — and therefore auth.json — is a throwaway. These tests never
 * touch a real credential store.
 */

import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Auth } from "../../src/auth"
import * as AuthSvc from "../../src/auth/service"
import { AUTH_FILE } from "../../src/auth/lock"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    Auth.defaultLayer,
    AuthSvc.AuthService.defaultLayer,
    FSUtil.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

const api = (key: string) => ({ type: "api" as const, key })

describe("Auth store concurrency", () => {
  it.instance("concurrent writes to different providers all survive", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const providers = ["conc-a", "conc-b", "conc-c", "conc-d", "conc-e"]

      // Unbounded concurrency: every one of these reads the store, mutates its own key, and
      // writes the whole thing back. Without a lock around the read-modify-write they all read
      // the same starting state and the last rename wins, leaving exactly one of them.
      yield* Effect.all(
        providers.map((p) => auth.set(p, api(`key-${p}`))),
        { concurrency: "unbounded" },
      )

      const data = yield* auth.all()
      for (const p of providers) {
        const entry = data[p]
        expect(entry).toBeDefined()
        expect(entry!.type).toBe("api")
        if (entry!.type === "api") expect(entry!.key).toBe(`key-${p}`)
      }
    }),
  )

  it.instance("a concurrent write from the OTHER Auth implementation is not lost", () =>
    Effect.gen(function* () {
      // The whole point of keying the lock on the auth.json path rather than on a feature name:
      // `auth/index.ts` and `auth/service.ts` are separate services over one file, and each one
      // locking only against itself leaves them free to clobber each other.
      const auth = yield* Auth.Service
      const service = yield* AuthSvc.AuthService

      yield* Effect.all([auth.set("cross-index", api("from-index")), service.set("cross-service", api("from-service"))], {
        concurrency: "unbounded",
      })

      const data = yield* auth.all()
      expect(data["cross-index"]).toBeDefined()
      expect(data["cross-service"]).toBeDefined()
    }),
  )

  it.instance("a concurrent remove does not resurrect or drop unrelated providers", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("rm-keep", api("keep"))
      yield* auth.set("rm-drop", api("drop"))

      yield* Effect.all([auth.remove("rm-drop"), auth.set("rm-added", api("added"))], { concurrency: "unbounded" })

      const data = yield* auth.all()
      expect(data["rm-keep"]).toBeDefined()
      expect(data["rm-added"]).toBeDefined()
      expect(data["rm-drop"]).toBeUndefined()
    }),
  )
})

describe("Atomic writeJson file mode", () => {
  // umask is process-global, so the window it is raised in must contain NOTHING but the write
  // under test. An earlier version of this test wrapped `Auth.set`, which takes the store lock
  // and lazily creates `<state>/locks` — that directory was then created mode 000 and the whole
  // test tmpdir became undeletable. Everything here is pre-created outside the window, and the
  // window covers exactly one writeJson: writeFile + chmod + rename, no mkdir.
  const withUmask = <A, E, R>(mask: number, body: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => process.umask(mask)),
      () => body,
      (previous) => Effect.sync(() => process.umask(previous)),
    )

  it.instance("honours the requested mode under a hostile umask", () =>
    Effect.gen(function* () {
      // chmod/umask are no-ops on Windows; the mode assertion would be noise there.
      if (process.platform === "win32") return

      const fsys = yield* FSUtil.Service
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "auth-mode-")))
      const target = path.join(dir, "auth.json")
      try {
        // 0o777 clears every permission bit open(2) would have granted, so passing `mode` to
        // writeFile alone yields a file with mode 000 — written successfully, then unreadable
        // forever. chmod is not masked, which is why the writer has to do both.
        yield* withUmask(0o777, fsys.writeJson(target, { credential: "kept" }, 0o600))

        const stat = yield* Effect.promise(() => fs.stat(target))
        expect(stat.mode & 0o777).toBe(0o600)

        // The mode is the mechanism; staying readable is the property that matters.
        const text = yield* Effect.promise(() => fs.readFile(target, "utf8"))
        expect(JSON.parse(text).credential).toBe("kept")
      } finally {
        yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
      }
    }),
  )

  it.instance("replaces a symlink's target rather than the symlink itself", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return

      // Writing in place used to update whatever a symlinked auth.json pointed at. Renaming over
      // the link would silently strip it and leave the real file stale, so anyone who keeps
      // auth.json in a managed directory would keep reading a frozen credential.
      const fsys = yield* FSUtil.Service
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "auth-link-")))
      const real = path.join(dir, "real-auth.json")
      const link = path.join(dir, "auth.json")
      try {
        yield* Effect.promise(() => fs.writeFile(real, "{}", { mode: 0o600 }))
        yield* Effect.promise(() => fs.symlink(real, link))

        yield* fsys.writeJson(link, { credential: "through-the-link" }, 0o600)

        expect((yield* Effect.promise(() => fs.lstat(link))).isSymbolicLink()).toBe(true)
        const text = yield* Effect.promise(() => fs.readFile(real, "utf8"))
        expect(JSON.parse(text).credential).toBe("through-the-link")
        expect((yield* Effect.promise(() => fs.stat(real))).mode & 0o777).toBe(0o600)
      } finally {
        yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
      }
    }),
  )
})

describe("Auth store writer parity", () => {
  // `auth/index.ts` and `auth/service.ts` write the same file through different helpers. The
  // atomic writer was added to close a window where credentials sit at their real path under
  // whatever mode the file already had — open(2) ignores the mode argument for an EXISTING file,
  // so the content lands first and the chmod follows. That was closed on the FSUtil path only;
  // service.ts kept writing in place. Half-closing a credential-exposure window is worse than
  // leaving it open, because the next reader sees "atomic writer, fixed" and stops looking.
  //
  // The observable discriminator is the inode. An atomic replace renames a new file over the
  // target, so the inode changes; an in-place write keeps it — and keeping it is exactly what
  // means the secret was written into the pre-existing, possibly loose-moded file.
  const seedLooseFile = (target: string) =>
    Effect.promise(async () => {
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, JSON.stringify({ seeded: { type: "api", key: "old" } }), { mode: 0o644 })
      await fs.chmod(target, 0o644)
      return (await fs.stat(target)).ino
    })

  it.instance("service.ts replaces auth.json atomically instead of writing into it", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return

      const service = yield* AuthSvc.AuthService
      const target = AUTH_FILE
      const before = yield* seedLooseFile(target)

      yield* service.set("writer-parity", api("secret"))

      const stat = yield* Effect.promise(() => fs.stat(target))
      // Different inode: the credential arrived by rename, so it never existed at this path
      // inside the old 0644 file.
      expect(stat.ino).not.toBe(before)
      expect(stat.mode & 0o777).toBe(0o600)

      const data = yield* service.all()
      const entry = data["writer-parity"]
      expect(entry).toBeDefined()
      if (entry!.type === "api") expect(entry!.key).toBe("secret")

      // The temp file is renamed, not left behind, on the success path.
      const stray = (yield* Effect.promise(() => fs.readdir(path.dirname(target)))).filter(
        (n) => n.startsWith("auth.json.") && n.endsWith(".tmp"),
      )
      expect(stray).toEqual([])
    }),
  )

  it.instance("both implementations produce the same mode on the same file", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return

      const auth = yield* Auth.Service
      const service = yield* AuthSvc.AuthService

      yield* seedLooseFile(AUTH_FILE)
      yield* service.set("parity-service", api("a"))
      const afterService = yield* Effect.promise(() => fs.stat(AUTH_FILE))

      yield* seedLooseFile(AUTH_FILE)
      yield* auth.set("parity-index", api("b"))
      const afterIndex = yield* Effect.promise(() => fs.stat(AUTH_FILE))

      expect(afterService.mode & 0o777).toBe(0o600)
      expect(afterIndex.mode & 0o777).toBe(0o600)
      expect(afterService.mode & 0o777).toBe(afterIndex.mode & 0o777)
    }),
  )
})
