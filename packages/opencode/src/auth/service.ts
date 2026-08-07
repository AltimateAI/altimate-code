import path from "path"
import { Context, Effect, Layer, Record, Result, Schema } from "effect"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"
// altimate_change — shared cross-process lock for auth.json (see auth/lock.ts)
import { Flock } from "@opencode-ai/core/util/flock"
import { AUTH_LOCK_KEY } from "./lock"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: Schema.Number,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

export const Info = Schema.Union([Oauth, Api, WellKnown])
export type Info = Schema.Schema.Type<typeof Info>

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
          try: () =>
            Flock.withLock(AUTH_LOCK_KEY, async () => {
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
          try: () =>
            Flock.withLock(AUTH_LOCK_KEY, async () => {
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
