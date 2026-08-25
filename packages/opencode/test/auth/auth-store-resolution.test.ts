/**
 * altimate_change — the auth store's mutation path resolves its target ONCE and uses that one
 * resolution for the read, the lock and the write.
 *
 * The round-3 tests asserted the end state a correct mutation produces, which the buggy paths also
 * produce whenever nothing moves underneath them. These construct the movement. Two mechanisms,
 * each with a test that fails when only that mechanism is reverted:
 *
 *   Coupling. Resolution, read and write must all name the same physical file. `writeFileAtomic`
 *   canonicalises its argument, so routing the write through it re-resolves a path the caller has
 *   already resolved and locked; and reading the lexical `auth.json` follows the symlink a second
 *   time. Either one lets a symlink retargeted mid-mutation split the three apart.
 *
 *   A failed read is not an empty store. Both mutations do `read all → change one key → write all
 *   back`, and the write is an atomic replace, so a read that degrades to `{}` does not lose the
 *   entry being touched — it deletes every provider's credentials.
 *
 * Isolation: `test/preload.ts` points XDG_DATA_HOME at a per-pid tmp dir before any `src/` import,
 * so `AUTH_FILE` is a throwaway. Every case restores it to a plain file on the way out, because
 * the symlink ones replace it.
 */

import { describe, expect, spyOn } from "bun:test"
import fs from "node:fs/promises"
import * as NFS from "fs/promises"
import path from "node:path"
import { Effect, Exit, Layer } from "effect"
import { Auth } from "../../src/auth"
import * as AuthSvc from "../../src/auth/service"
import { AUTH_FILE, isStoreMissing } from "../../src/auth/lock"
import { writeFileAtomic, writeFileAtomicResolved } from "@opencode-ai/core/util/atomic-write"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Filesystem } from "../../src/util/filesystem"
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

const unsupported = () => process.platform === "win32"

/** Put AUTH_FILE back to a plain file so the symlink cases cannot leak into later tests. */
const restoreStore = (content: Record<string, unknown> = {}) =>
  Effect.promise(async () => {
    await fs.rm(AUTH_FILE, { force: true })
    await fs.mkdir(path.dirname(AUTH_FILE), { recursive: true })
    await fs.writeFile(AUTH_FILE, JSON.stringify(content), { mode: 0o600 })
  })

const readStore = (target: string) =>
  Effect.promise(async () => JSON.parse(await fs.readFile(target, "utf8")) as Record<string, any>)

describe("auth store resolves once per mutation", () => {
  /**
   * Count canonicalisations of the auth store.
   *
   * `canonicalPath` calls `realpath`, so one such call per canonicalisation of a path named
   * `auth.json`. The lock file lives elsewhere under a hashed name and does not match.
   */
  const countResolutions = <A, E, R>(work: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const counter = { calls: 0 }
      const original = NFS.realpath
      const spy = yield* Effect.sync(() =>
        spyOn(NFS, "realpath").mockImplementation((async (p: any, ...rest: any[]) => {
          if (typeof p === "string" && path.basename(p) === "auth.json") counter.calls++
          return (original as any)(p, ...rest)
        }) as any),
      )
      yield* Effect.exit(work)
      yield* Effect.sync(() => spy.mockRestore())
      return counter.calls
    })

  // Exactly one, not "at most a few": the single-resolution property IS the count. Routing the
  // write back through the resolving writer makes this 2 — the number the fix exists to prevent —
  // and any upper bound would accept it.
  it.instance("Auth.set canonicalises the store exactly once", () =>
    Effect.gen(function* () {
      if (unsupported()) return
      const auth = yield* Auth.Service
      // Pre-created, so `canonicalPath` takes its one-realpath path rather than the absent-target
      // fallback, which legitimately resolves the parent as well.
      yield* restoreStore({ seeded: { type: "api", key: "old" } })

      const calls = yield* countResolutions(auth.set("resolve-once-index", api("k")))

      expect(calls).toBe(1)
      yield* restoreStore()
    }),
  )

  it.instance("AuthService.set canonicalises the store exactly once", () =>
    Effect.gen(function* () {
      if (unsupported()) return
      const service = yield* AuthSvc.AuthService
      yield* restoreStore({ seeded: { type: "api", key: "old" } })

      const calls = yield* countResolutions(service.set("resolve-once-service", api("k")))

      expect(calls).toBe(1)
      yield* restoreStore()
    }),
  )

  it.instance("Auth.remove canonicalises the store exactly once", () =>
    Effect.gen(function* () {
      if (unsupported()) return
      const auth = yield* Auth.Service
      yield* restoreStore({ doomed: { type: "api", key: "old" } })

      const calls = yield* countResolutions(auth.remove("doomed"))

      expect(calls).toBe(1)
      yield* restoreStore()
    }),
  )
})

describe("auth store read, lock and write cannot be split apart", () => {
  /**
   * Run `work` with the store symlink retargeted the instant it has been resolved.
   *
   * That is the exact window the fix closes: the mutation has captured — and locked — A, and
   * everything after it, the read and the write, must still reach A. Anything that consults the
   * lexical path a second time gets B.
   */
  const withRetargetedStore = <A, E, R>(work: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const dir = path.dirname(AUTH_FILE)
      const a = path.join(dir, "store-a.json")
      const b = path.join(dir, "store-b.json")

      yield* Effect.promise(async () => {
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(a, JSON.stringify({ alpha: { type: "api", key: "alpha-key" } }), { mode: 0o600 })
        await fs.writeFile(b, JSON.stringify({ beta: { type: "api", key: "beta-key" } }), { mode: 0o600 })
        await fs.rm(AUTH_FILE, { force: true })
        await fs.symlink(a, AUTH_FILE)
      })

      const original = NFS.realpath
      let armed = true
      const spy = yield* Effect.sync(() =>
        spyOn(NFS, "realpath").mockImplementation((async (p: any, ...rest: any[]) => {
          const resolved = await (original as any)(p, ...rest)
          if (armed && p === AUTH_FILE) {
            armed = false
            await fs.rm(AUTH_FILE, { force: true })
            await fs.symlink(b, AUTH_FILE)
          }
          return resolved
        }) as any),
      )
      yield* Effect.exit(work)
      yield* Effect.sync(() => spy.mockRestore())

      const result = { a: yield* readStore(a), b: yield* readStore(b), retargeted: !armed }
      yield* Effect.promise(async () => {
        await fs.rm(a, { force: true })
        await fs.rm(b, { force: true })
      })
      yield* restoreStore()
      return result
    })

  // Three distinct failures, all caught here:
  //   write re-resolves      → the new entry lands in B and A never gets it
  //   read follows the link  → the mutation reads B's snapshot and writes it over A, so alpha dies
  //   both                   → B is overwritten with B-plus-the-entry and A is untouched
  it.instance("Auth.set writes to the resolved target even if the link moves after resolution", () =>
    Effect.gen(function* () {
      if (unsupported()) return
      const auth = yield* Auth.Service

      const { a, b, retargeted } = yield* withRetargetedStore(auth.set("landed", api("landed-key")))

      // The scenario has to have happened, or everything below is vacuous.
      expect(retargeted).toBe(true)
      // The bytes went where the lock was taken.
      expect(a["landed"]?.key).toBe("landed-key")
      // The entry already in the locked file survived, which it cannot if the read followed the
      // retargeted link and wrote that file's snapshot back over this one.
      expect(a["alpha"]).toBeDefined()
      // And nothing at all reached the file the link now points at.
      expect(Object.keys(b)).toEqual(["beta"])
    }),
  )

  it.instance("AuthService.set writes to the resolved target even if the link moves after resolution", () =>
    Effect.gen(function* () {
      if (unsupported()) return
      const service = yield* AuthSvc.AuthService

      const { a, b, retargeted } = yield* withRetargetedStore(service.set("landed", api("landed-key")))

      expect(retargeted).toBe(true)
      expect(a["landed"]?.key).toBe("landed-key")
      expect(a["alpha"]).toBeDefined()
      expect(Object.keys(b)).toEqual(["beta"])
    }),
  )

  /**
   * The other half, and the one the reader test above cannot reach.
   *
   * There the link that moves is the lexical `auth.json`; the resolved target stays a real file,
   * so re-canonicalising it is a no-op and a write that re-resolves still lands correctly. The
   * write only diverges when the RESOLVED path itself becomes a link — which is what an attacker
   * with write access to the data directory does, and what the lock cannot prevent because the
   * lock names the path, not the inode.
   *
   * `writeFileAtomicResolved` renames onto the path it was given, so the bytes stay inside what
   * the lock covers and the planted link is destroyed. `writeFileAtomic` follows it to B.
   */
  const withPlantedLink = <A, E, R>(work: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const b = path.join(path.dirname(AUTH_FILE), "store-b.json")
      yield* restoreStore({ alpha: { type: "api", key: "alpha-key" } })
      yield* Effect.promise(() => fs.writeFile(b, JSON.stringify({ beta: { type: "api", key: "beta-key" } })))

      const original = NFS.realpath
      let armed = true
      const spy = yield* Effect.sync(() =>
        spyOn(NFS, "realpath").mockImplementation((async (p: any, ...rest: any[]) => {
          const resolved = await (original as any)(p, ...rest)
          if (armed && p === AUTH_FILE) {
            armed = false
            await fs.rm(AUTH_FILE, { force: true })
            await fs.symlink(b, AUTH_FILE)
          }
          return resolved
        }) as any),
      )
      yield* Effect.exit(work)
      yield* Effect.sync(() => spy.mockRestore())

      const stillLinked = yield* Effect.promise(() => fs.lstat(AUTH_FILE).then((s) => s.isSymbolicLink()))
      const result = { locked: yield* readStore(AUTH_FILE), b: yield* readStore(b), planted: !armed, stillLinked }
      yield* Effect.promise(() => fs.rm(b, { force: true }))
      yield* restoreStore()
      return result
    })

  it.instance("Auth.set writes onto the locked path when the resolved target becomes a link", () =>
    Effect.gen(function* () {
      if (unsupported()) return
      const auth = yield* Auth.Service

      const { locked, b, planted, stillLinked } = yield* withPlantedLink(auth.set("landed", api("landed-key")))

      expect(planted).toBe(true)
      // A second canonicalisation would have followed the planted link away from the locked path,
      // leaving it in place; the resolved writer renames over it.
      expect(stillLinked).toBe(false)
      expect(locked["landed"]?.key).toBe("landed-key")
      // The credential never reached the file outside the lock.
      expect(Object.keys(b)).toEqual(["beta"])
    }),
  )

  it.instance("AuthService.set writes onto the locked path when the resolved target becomes a link", () =>
    Effect.gen(function* () {
      if (unsupported()) return
      const service = yield* AuthSvc.AuthService

      const { locked, b, planted, stillLinked } = yield* withPlantedLink(service.set("landed", api("landed-key")))

      expect(planted).toBe(true)
      expect(stillLinked).toBe(false)
      expect(locked["landed"]?.key).toBe("landed-key")
      expect(Object.keys(b)).toEqual(["beta"])
    }),
  )
})

describe("a mutation read that FAILS is not an empty store", () => {
  // The writer bug of this shape was fixed a round ago: an error read as "absent". This is the
  // reader. A mutation cannot tell "no credentials yet" from "could not read the credentials" by
  // outcome, and it follows its read with an atomic replace of the whole file — so guessing
  // "absent" during any read failure deletes every provider's credentials at once.
  //
  // A half-written store is the unmocked way to produce a non-ENOENT read failure: it needs no
  // permissions, no platform assumptions, and it is the likeliest real trigger (a crash during
  // someone else's write, a truncated sync). The other errnos the review named — EACCES, EIO —
  // reach the identical branch, and are covered by injection below plus the predicate's own test.
  //
  // NOTE a mode-000 file does NOT work here, and a version of this test that used one passed for
  // the wrong reason: `realpath` fails EACCES on an unreadable file, so the mutation aborted
  // during RESOLUTION and never reached the read at all. It stayed green with the read fix
  // reverted.
  const withCorruptStore = <A, E, R>(work: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const truncated = '{"keep-me":{"type":"api","key":"important"},"keep-me-too":{"type":"api",'
      yield* Effect.promise(async () => {
        await fs.rm(AUTH_FILE, { force: true })
        await fs.mkdir(path.dirname(AUTH_FILE), { recursive: true })
        await fs.writeFile(AUTH_FILE, truncated, { mode: 0o600 })
      })
      const exit = yield* Effect.exit(work)
      const after = yield* Effect.promise(() => fs.readFile(AUTH_FILE, "utf8"))
      yield* restoreStore()
      return { failed: Exit.isFailure(exit), after, truncated }
    })

  it.instance("Auth.set aborts on an unreadable store instead of rewriting it from nothing", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service

      const { failed, after, truncated } = yield* withCorruptStore(auth.set("newcomer", api("new")))

      expect(failed).toBe(true)
      // Byte-identical: the mutation did not touch the file. Asserting only that "keep-me" is
      // absent from the parsed result would not discriminate, because the buggy path also cannot
      // parse it — the point is that the file was not REPLACED.
      expect(after).toBe(truncated)
    }),
  )

  it.instance("AuthService.set aborts on an unreadable store instead of rewriting it from nothing", () =>
    Effect.gen(function* () {
      const service = yield* AuthSvc.AuthService

      const { failed, after, truncated } = yield* withCorruptStore(service.set("newcomer", api("new")))

      expect(failed).toBe(true)
      expect(after).toBe(truncated)
    }),
  )

  it.instance("Auth.remove aborts on an unreadable store rather than emptying it", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service

      const { failed, after, truncated } = yield* withCorruptStore(auth.remove("keep-me"))

      expect(failed).toBe(true)
      expect(after).toBe(truncated)
    }),
  )

  // The premise the cases above rest on: EACCES must not look like ENOENT to the predicate that
  // decides "empty store". Asserted directly so they cannot go vacuous if the error shape changes.
  it.instance("isStoreMissing accepts ENOENT and rejects everything else", () =>
    Effect.gen(function* () {
      expect(isStoreMissing({ code: "ENOENT" })).toBe(true)
      expect(isStoreMissing({ reason: { _tag: "NotFound" } })).toBe(true)
      expect(isStoreMissing({ cause: { code: "ENOENT" } })).toBe(true)
      expect(isStoreMissing({ code: "EACCES" })).toBe(false)
      expect(isStoreMissing({ code: "EIO" })).toBe(false)
      expect(isStoreMissing(new SyntaxError("Unexpected end of JSON input"))).toBe(false)
      // A self-referential cause chain must terminate rather than hang the mutation.
      const loop: { cause?: unknown; code: string } = { code: "EACCES" }
      loop.cause = loop
      expect(isStoreMissing(loop)).toBe(false)
    }),
  )
})

describe("EACCES specifically, injected at the read", () => {
  // The named scenario, and it cannot be produced with file permissions: this runtime's `realpath`
  // fails on a file it cannot read, so denying the read by mode aborts the mutation one step
  // earlier and proves nothing about the read. Injecting the errno at the reader is the only way
  // to reach the branch with EACCES rather than a parse failure.
  const eacces = () => Object.assign(new Error("EACCES: permission denied, open"), { code: "EACCES" })

  const seeded = { "keep-me": { type: "api", key: "important" }, "keep-me-too": { type: "api", key: "also" } }

  // `auth/index.ts` reads through the injected FSUtil service, so the layer is the seam.
  const deniedFsUtil = Layer.effect(
    FSUtil.Service,
    Effect.map(FSUtil.Service, (real) =>
      FSUtil.Service.of({
        ...real,
        readJson: (p: string) =>
          path.basename(p) === "auth.json"
            ? Effect.fail(new FSUtil.FileSystemError({ method: "readJson", cause: eacces() }))
            : real.readJson(p),
      }),
    ),
  ).pipe(Layer.provide(FSUtil.defaultLayer))

  const itDenied = testEffect(
    Layer.mergeAll(
      Auth.layer.pipe(Layer.provide(EffectFlock.defaultLayer), Layer.provide(deniedFsUtil)),
      CrossSpawnSpawner.defaultLayer,
    ),
  )

  itDenied.instance("Auth.set propagates EACCES rather than treating the store as empty", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* restoreStore(seeded)

      const exit = yield* Effect.exit(auth.set("newcomer", api("new")))
      const store = yield* readStore(AUTH_FILE)
      yield* restoreStore()

      expect(Exit.isFailure(exit)).toBe(true)
      // What makes this data loss rather than a free-tier bug: BOTH unrelated providers are gone
      // if the failed read became `{}`.
      expect(store["keep-me"]).toBeDefined()
      expect(store["keep-me-too"]).toBeDefined()
      expect(store["newcomer"]).toBeUndefined()
    }),
  )

  // `auth/service.ts` reads through the `Filesystem` module, so the module is the seam.
  it.instance("AuthService.set propagates EACCES rather than treating the store as empty", () =>
    Effect.gen(function* () {
      const service = yield* AuthSvc.AuthService
      yield* restoreStore(seeded)

      const spy = yield* Effect.sync(() =>
        spyOn(Filesystem, "readJson").mockImplementation(async (p: string) => {
          if (path.basename(p) === "auth.json") throw eacces()
          throw new Error("unexpected read in this test: " + p)
        }),
      )
      const exit = yield* Effect.exit(service.set("newcomer", api("new")))
      yield* Effect.sync(() => spy.mockRestore())

      const store = yield* readStore(AUTH_FILE)
      yield* restoreStore()

      expect(Exit.isFailure(exit)).toBe(true)
      expect(store["keep-me"]).toBeDefined()
      expect(store["keep-me-too"]).toBeDefined()
      expect(store["newcomer"]).toBeUndefined()
    }),
  )
})

describe("the resolved writer does not resolve again", () => {
  // The primitive the coupling rests on, asserted alone so a regression is attributable.
  // `writeFileAtomic` replaces what a symlink POINTS AT; `writeFileAtomicResolved` is handed a
  // physical path and must treat it as one. Pointing it at a link is a caller error, and the
  // observable difference is that the link itself is replaced rather than followed.
  it.instance("writeFileAtomicResolved treats its argument as physical, writeFileAtomic resolves", () =>
    Effect.gen(function* () {
      if (unsupported()) return
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(path.dirname(AUTH_FILE), "resolved-")))
      try {
        const real = path.join(dir, "real.json")
        const link = path.join(dir, "link.json")
        yield* Effect.promise(() => fs.writeFile(real, "{}", { mode: 0o600 }))
        yield* Effect.promise(() => fs.symlink(real, link))

        yield* Effect.promise(() => writeFileAtomic(link, '{"via":"resolving"}', 0o600))
        expect((yield* Effect.promise(() => fs.lstat(link))).isSymbolicLink()).toBe(true)
        expect(JSON.parse(yield* Effect.promise(() => fs.readFile(real, "utf8"))).via).toBe("resolving")

        yield* Effect.promise(() => writeFileAtomicResolved(link, '{"via":"resolved"}', 0o600))
        // The link is gone: no realpath happened, so the rename landed on the link's own path.
        expect((yield* Effect.promise(() => fs.lstat(link))).isSymbolicLink()).toBe(false)
        expect(JSON.parse(yield* Effect.promise(() => fs.readFile(real, "utf8"))).via).toBe("resolving")
      } finally {
        yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
      }
    }),
  )
})
