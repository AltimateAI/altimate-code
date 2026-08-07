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
import { writeFileAtomic, canonicalPath } from "@opencode-ai/core/util/atomic-write"
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

  it.instance("index.ts (the FSUtil path) also replaces auth.json atomically", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return

      // The sibling assertion for `Auth.Service`. Asserting only the final mode does NOT
      // discriminate on either path — write-then-chmod also ends at 0600 — so reverting
      // FSUtil.writeJson to an in-place write left every other FSUtil assertion here green
      // while reopening the exposure window. The inode is what tells the two apart.
      const auth = yield* Auth.Service
      const before = yield* seedLooseFile(AUTH_FILE)

      yield* auth.set("fsutil-atomic", api("secret"))

      const stat = yield* Effect.promise(() => fs.stat(AUTH_FILE))
      expect(stat.ino).not.toBe(before)
      expect(stat.mode & 0o777).toBe(0o600)

      const data = yield* auth.all()
      const entry = data["fsutil-atomic"]
      expect(entry).toBeDefined()
      if (entry!.type === "api") expect(entry!.key).toBe("secret")
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

describe("Auth store schema parity", () => {
  // The two implementations decoded `auth.json` with SEPARATE Info schemas, and they had drifted:
  // service.ts's `Api` had no `metadata`. Decoding narrows to the declared shape and both
  // implementations rewrite the WHOLE file, so touching any unrelated provider through
  // AuthService stripped metadata from every entry. For the free tier that silently removes
  // `install_secret` — the identity the gateway derives its budget principal from — so the next
  // registration mints a second principal instead of rotating.
  const withMetadata = {
    type: "api" as const,
    key: "free-key",
    metadata: { install_secret: "s3cret", base_url: "http://localhost:4000" },
  }

  it.instance("metadata survives a rewrite triggered by the OTHER implementation", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const service = yield* AuthSvc.AuthService

      // Free tier registers through the index.ts path.
      yield* auth.set("altimate-free", withMetadata)

      // The user then adds an unrelated provider through the service.ts path, which rewrites
      // every entry. This is the step that used to drop the metadata.
      yield* service.set("some-other-provider", api("unrelated"))

      for (const read of [yield* auth.all(), yield* service.all()]) {
        const entry = read["altimate-free"]
        expect(entry).toBeDefined()
        expect(entry!.type).toBe("api")
        if (entry!.type === "api") {
          expect(entry!.metadata?.["install_secret"]).toBe("s3cret")
          expect(entry!.metadata?.["base_url"]).toBe("http://localhost:4000")
        }
      }
    }),
  )

  it.instance("metadata survives a remove triggered by the OTHER implementation", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const service = yield* AuthSvc.AuthService

      yield* auth.set("altimate-free-2", withMetadata)
      yield* auth.set("doomed-provider", api("bye"))
      yield* service.remove("doomed-provider")

      const entry = (yield* auth.all())["altimate-free-2"]
      expect(entry).toBeDefined()
      if (entry!.type === "api") expect(entry!.metadata?.["install_secret"]).toBe("s3cret")
    }),
  )

  it.instance("metadata written THROUGH service.ts round-trips intact via BOTH readers", () =>
    Effect.gen(function* () {
      const service = yield* AuthSvc.AuthService
      const auth = yield* Auth.Service

      yield* service.set("altimate-free-3", withMetadata)

      // Reading through index.ts alone does not discriminate: `set` serialises the caller's
      // object as given, so metadata reaches the file even under the narrow schema — the loss
      // happens on DECODE. service.all() is the reader that has to see it too.
      for (const read of [yield* auth.all(), yield* service.all()]) {
        const entry = read["altimate-free-3"]
        expect(entry).toBeDefined()
        if (entry!.type === "api") expect(entry!.metadata?.["base_url"]).toBe("http://localhost:4000")
      }
    }),
  )
})

describe("canonicalPath and symlink safety", () => {
  // The writer resolves its target with realpath so it replaces what a symlink POINTS AT.
  // An earlier version swallowed every realpath error, which meant "cannot resolve" and
  // "nothing there" were treated identically: a valid symlink whose directory was momentarily
  // unreadable, or a symlink cycle, looked like a fresh file and got REPLACED — reporting
  // success while the real credential file silently went stale.
  it.instance("canonicalPath resolves a symlink to its physical target", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "canon-")))
      try {
        const real = path.join(dir, "real.json")
        const link = path.join(dir, "link.json")
        yield* Effect.promise(() => fs.writeFile(real, "{}"))
        yield* Effect.promise(() => fs.symlink(real, link))
        const resolved = yield* Effect.promise(() => canonicalPath(link))
        expect(resolved).toBe(yield* Effect.promise(() => fs.realpath(real)))
      } finally {
        yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
      }
    }),
  )

  it.instance("canonicalPath falls back for an absent target but still canonicalises the parent", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "canon-absent-")))
      try {
        // The parent is reached through a symlink; the leaf does not exist yet. The result must
        // still collapse the parent symlink, or two processes reaching one store by different
        // routes would compute different lock keys.
        const realDir = path.join(dir, "real-dir")
        const linkDir = path.join(dir, "link-dir")
        yield* Effect.promise(() => fs.mkdir(realDir))
        yield* Effect.promise(() => fs.symlink(realDir, linkDir))
        const resolved = yield* Effect.promise(() => canonicalPath(path.join(linkDir, "absent.json")))
        const expected = path.join(yield* Effect.promise(() => fs.realpath(realDir)), "absent.json")
        expect(resolved).toBe(expected)
      } finally {
        yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
      }
    }),
  )

  it.instance("a symlink cycle (ELOOP) is propagated, not treated as a missing file", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "canon-loop-")))
      try {
        const a = path.join(dir, "a.json")
        const b = path.join(dir, "b.json")
        yield* Effect.promise(() => fs.symlink(b, a))
        yield* Effect.promise(() => fs.symlink(a, b))

        const outcome = yield* Effect.promise(() =>
          writeFileAtomic(a, "{}", 0o600).then(
            () => "wrote" as const,
            (err) => (err as { code?: string }).code ?? "threw",
          ),
        )
        // Must NOT report success by replacing the link.
        expect(outcome).not.toBe("wrote")
        expect(outcome).toBe("ELOOP")
        // And the cycle is still a cycle — nothing was clobbered.
        expect((yield* Effect.promise(() => fs.lstat(a))).isSymbolicLink()).toBe(true)
      } finally {
        yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
      }
    }),
  )

  it.instance("a symlink into an unreadable directory is NOT replaced (EACCES)", () =>
    Effect.gen(function* () {
      // Running as root defeats permission checks entirely, so the assertion would be vacuous.
      if (process.platform === "win32" || process.getuid?.() === 0) return

      // The exact shape that swallowing realpath errors got wrong: the LINK lives somewhere
      // writable, its target lives in a directory that is momentarily unreadable. Treating the
      // resolve failure as "no target" means the temp file is created next to the link and
      // renamed OVER it — the write reports success, the symlink is gone, and the real
      // credential file is left stale. Nothing about that is visible to the caller.
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "canon-eacces-")))
      const locked = path.join(dir, "locked")
      const link = path.join(dir, "auth.json")
      try {
        yield* Effect.promise(() => fs.mkdir(locked))
        const real = path.join(locked, "real-auth.json")
        yield* Effect.promise(() => fs.writeFile(real, JSON.stringify({ credential: "original" }), { mode: 0o600 }))
        yield* Effect.promise(() => fs.symlink(real, link))
        yield* Effect.promise(() => fs.chmod(locked, 0o000))

        const outcome = yield* Effect.promise(() =>
          writeFileAtomic(link, JSON.stringify({ credential: "new" }), 0o600).then(
            () => "wrote" as const,
            (err) => (err as { code?: string }).code ?? "threw",
          ),
        )

        expect(outcome).not.toBe("wrote")
        expect(outcome).toBe("EACCES")
        // The link must survive: replacing it is the silent-staleness bug.
        expect((yield* Effect.promise(() => fs.lstat(link))).isSymbolicLink()).toBe(true)
      } finally {
        yield* Effect.promise(() => fs.chmod(locked, 0o700).catch(() => {}))
        yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
      }
    }),
  )
})
