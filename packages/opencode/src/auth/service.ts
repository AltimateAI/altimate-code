import path from "path"
import { Context, Effect, Layer, Record, Result, Schema } from "effect"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"
// altimate_change — shared cross-process lock for auth.json (see auth/lock.ts)
import { Flock } from "@opencode-ai/core/util/flock"
import { authLockKey } from "./lock"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

// altimate_change start — was a SECOND copy of the credential schema whose `Api` had no
// `metadata` field. Decoding narrows to the declared shape and this service rewrites the whole
// file, so a single provider change here stripped `install_secret`/`base_url` from every entry.
// Same schema as auth/index.ts now, by construction rather than by both files agreeing.
export { Oauth, Api, WellKnown, Info } from "./schema"
import { Info } from "./schema"
// altimate_change end

export class AuthServiceError extends Schema.TaggedErrorClass<AuthServiceError>()("AuthServiceError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

const file = path.join(Global.Path.data, "auth.json")

const fail = (message: string) => (cause: unknown) => new AuthServiceError({ message, cause })

export namespace AuthService {
  export interface Service {
    readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthServiceError>
    readonly all: () => Effect.Effect<Record<string, Info>, AuthServiceError>
    readonly set: (key: string, info: Info) => Effect.Effect<void, AuthServiceError>
    readonly remove: (key: string) => Effect.Effect<void, AuthServiceError>
  }
}

export class AuthService extends Context.Service<AuthService, AuthService.Service>()("@opencode/Auth") {
  static readonly layer = Layer.effect(
    AuthService,
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownOption(Info)

      const all = Effect.fn("AuthService.all")(() =>
        Effect.tryPromise({
          try: async () => {
            const data = await Filesystem.readJson<Record<string, unknown>>(file).catch(() => ({}))
            return Record.filterMap(data, (value) => Result.fromOption(decode(value), () => undefined))
          },
          catch: fail("Failed to read auth data"),
        }),
      )

      const get = Effect.fn("AuthService.get")(function* (providerID: string) {
        return (yield* all())[providerID]
      })

      // altimate_change start — same cross-process store lock as auth/index.ts, same key, so the
      // two implementations exclude each other rather than only themselves. See auth/lock.ts.
      // The read happens INSIDE the lock; reading first and locking only the write would leave
      // the lost-credential window open. Reads stay unlocked (atomic rename makes them safe).
      const readAll = async () => {
        const data = await Filesystem.readJson<Record<string, unknown>>(file).catch(() => ({}))
        return Record.filterMap(data, (value) => Result.fromOption(decode(value), () => undefined))
      }

      const set = Effect.fn("AuthService.set")(function* (key: string, info: Info) {
        yield* Effect.tryPromise({
          try: async () =>
            Flock.withLock(await authLockKey(), async () => {
              const norm = key.replace(/\/+$/, "")
              const data = await readAll()
              if (norm !== key) delete data[key]
              delete data[norm + "/"]
              await Filesystem.writeJson(file, { ...data, [norm]: info }, 0o600)
            }),
          catch: fail("Failed to write auth data"),
        })
      })

      const remove = Effect.fn("AuthService.remove")(function* (key: string) {
        yield* Effect.tryPromise({
          try: async () =>
            Flock.withLock(await authLockKey(), async () => {
              const norm = key.replace(/\/+$/, "")
              const data = await readAll()
              delete data[key]
              delete data[norm]
              await Filesystem.writeJson(file, data, 0o600)
            }),
          catch: fail("Failed to write auth data"),
        })
      })
      // altimate_change end

      return AuthService.of({
        get,
        all,
        set,
        remove,
      })
    }),
  )

  static readonly defaultLayer = AuthService.layer
}
