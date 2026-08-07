import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { Effect, Layer, Record, Result, Schema, Context } from "effect"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
// altimate_change start — makeRuntime for the restored Promise wrappers (bottom of file)
import { makeRuntime } from "@/effect/run-service"
// altimate_change end
// altimate_change start — cross-process lock for the shared auth store (see auth/lock.ts)
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { resolveAuthTarget, isStoreMissing } from "./lock"
// altimate_change end

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

const file = path.join(Global.Path.data, "auth.json")

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

// altimate_change start — the schema moved to auth/schema.ts so `auth/service.ts` decodes with
// the SAME one. It had its own copy without `Api.metadata`, and since both implementations
// rewrite the whole file, writing through that one stripped metadata from every entry. Re-exported
// here so the public surface (`Auth.Info`, `Auth.Api`, …) is unchanged.
export { Oauth, Api, WellKnown, Info } from "./schema"
import { Info } from "./schema"
// altimate_change end

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
}

// altimate_change start — disambiguate from the fork-local `auth/service.ts` AuthService
// which uses the "@opencode/Auth" Effect Service identifier. Both run in independent
// runtimes today (CLI auth ops vs provider auth pipeline) but would share the same id —
// if anyone ever merges these layers, the duplicate id would silently overwrite. Use a
// distinct suffix here so the two services can never collide. (NOTE: v1.17.9 upstream
// ships only this index.ts; `auth/service.ts` is fork-local. Keep the suffix regardless:
// it stays correct if service.ts survives the merge and is harmless if it is dropped.)
export class Service extends Context.Service<Service, Interface>()("@opencode/Auth.cli") {}
// altimate_change end

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* FSUtil.Service
    const decode = Schema.decodeUnknownOption(Info)
    // altimate_change start — see auth/lock.ts
    const flock = yield* EffectFlock.Service
    // altimate_change end

    // altimate_change start — the env-override and decode steps of `all()` lifted out verbatim so
    // the mutation read below can reuse them without inheriting `all()`'s error handling, which is
    // the part the two must NOT share. Behaviour of `all()` is unchanged.
    const decodeAll = (data: Record<string, unknown>) =>
      Record.filterMap(data, (value) => Result.fromOption(decode(value), () => undefined))

    const fromEnv = () => {
      if (!process.env.OPENCODE_AUTH_CONTENT) return undefined
      try {
        return JSON.parse(process.env.OPENCODE_AUTH_CONTENT)
      } catch (err) {
        return undefined
      }
    }
    // altimate_change end

    const all = Effect.fn("Auth.all")(function* () {
      // altimate_change start — extracted helpers, same behaviour as the inlined original
      const env = fromEnv()
      if (env) return env

      const data = (yield* fsys.readJson(file).pipe(Effect.orElseSucceed(() => ({})))) as Record<string, unknown>
      return decodeAll(data)
      // altimate_change end
    })

    // altimate_change start — the read a MUTATION does, which is not the read `all()` does.
    //
    // Two differences, both load-bearing:
    //
    //   It reads the RESOLVED target, not the lexical `file`. The mutation locked that target; if
    //   the read followed the symlink separately it could observe a different file from the one it
    //   locked and the one it is about to write, and would then write that file's snapshot over
    //   the locked target.
    //
    //   Only ENOENT means "empty store". `all()` degrades every failure to `{}` because a failed
    //   READ is merely a missing answer — but a mutation follows its read with an atomic replace
    //   of the whole file, so the same degradation silently deletes EVERY provider's credentials
    //   on an EACCES blip, an EIO, or a file that fails to parse. Not just the free tier's: one
    //   unreadable moment during any `set()` wipes the store.
    const readForMutation = Effect.fn("Auth.readForMutation")(function* (target: string) {
      const env = fromEnv()
      if (env) return env

      const data = (yield* fsys.readJson(target).pipe(
        Effect.catchIf(isStoreMissing, () => Effect.succeed({})),
        Effect.mapError(fail("Failed to read auth data")),
      )) as Record<string, unknown>
      return decodeAll(data)
    })
    // altimate_change end

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    // altimate_change start — serialize the whole read-modify-write against the other Auth
    // implementation and other processes. See auth/lock.ts for why a per-feature lock is not
    // enough. The lock wraps read AND write: reading outside it would let another writer land
    // between our read and our rename, which is exactly the lost-credential case.
    //
    // Reads (`all`/`get`) are deliberately NOT locked. `writeJson` renames into place, so a
    // reader sees either the whole old file or the whole new one, never a partial write — and
    // locking reads would both add contention and deadlock any caller that reads while holding
    // the lock, since a file lock is not re-entrant. For the same reason the bodies below call
    // `all()` directly rather than going through a locked helper.
    // Resolved ONCE per mutation and used for the READ, the lock and the WRITE, so no two of them
    // can name different files. `body` receives the resolved physical target; it must read from
    // and write to THAT, not to `file`, and the write must go through `writeJsonResolved` so the
    // path is not canonicalised a second time. See auth/lock.ts for why sharing the resolver
    // function alone was not enough.
    const withStoreLock = <A, E, R>(body: (target: string) => Effect.Effect<A, E, R>) =>
      Effect.tryPromise({
        try: () => resolveAuthTarget(),
        catch: fail("Failed to resolve the auth store path"),
      }).pipe(
        Effect.flatMap(({ target, lockKey }) => body(target).pipe(flock.withLock(lockKey))),
        Effect.mapError(fail("Failed to lock auth store")),
      )

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
      yield* withStoreLock((target) =>
        Effect.gen(function* () {
          const norm = key.replace(/\/+$/, "")
          const data = yield* readForMutation(target)
          if (norm !== key) delete data[key]
          delete data[norm + "/"]
          yield* fsys
            .writeJsonResolved(target, { ...data, [norm]: info }, 0o600)
            .pipe(Effect.mapError(fail("Failed to write auth data")))
        }),
      )
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      yield* withStoreLock((target) =>
        Effect.gen(function* () {
          const norm = key.replace(/\/+$/, "")
          const data = yield* readForMutation(target)
          delete data[key]
          delete data[norm]
          yield* fsys.writeJsonResolved(target, data, 0o600).pipe(Effect.mapError(fail("Failed to write auth data")))
        }),
      )
    })
    // altimate_change end

    return Service.of({ get, all, set, remove })
  }),
)

// altimate_change start — Layer.suspend defers facade refs past circular module-init
export const defaultLayer = Layer.suspend(() =>
  layer.pipe(Layer.provide(EffectFlock.defaultLayer), Layer.provide(FSUtil.defaultLayer)),
)
// altimate_change end

// altimate_change start — thunk LayerNode deps defers facade refs past circular module-init
export const node = LayerNode.make(layer, () => [EffectFlock.node, FSUtil.node])
// altimate_change end

// altimate_change start — restore the imperative Promise wrappers upstream removed in the
// Effect-only migration; backed by the instance-bound makeRuntime so reads/writes stay scoped.
const { runPromise: runAuth } = makeRuntime(Service, defaultLayer)
export async function get(providerID: string) {
  return runAuth((s) => s.get(providerID))
}
export async function all() {
  return runAuth((s) => s.all())
}
export async function set(key: string, info: Info) {
  return runAuth((s) => s.set(key, info))
}
export async function remove(key: string) {
  return runAuth((s) => s.remove(key))
}
// altimate_change end

export * as Auth from "."
