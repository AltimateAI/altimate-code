import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { Effect, Layer, Record, Result, Schema, Context } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
// altimate_change start — makeRuntime for the restored Promise wrappers (bottom of file)
import { makeRuntime } from "@/effect/run-service"
// altimate_change end

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

const file = path.join(Global.Path.data, "auth.json")

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

export const Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export type Info = Schema.Schema.Type<typeof Info>

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

    const all = Effect.fn("Auth.all")(function* () {
      if (process.env.OPENCODE_AUTH_CONTENT) {
        try {
          return JSON.parse(process.env.OPENCODE_AUTH_CONTENT)
        } catch (err) {}
      }

      const data = (yield* fsys.readJson(file).pipe(Effect.orElseSucceed(() => ({})))) as Record<string, unknown>
      return Record.filterMap(data, (value) => Result.fromOption(decode(value), () => undefined))
    })

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* all()
      if (norm !== key) delete data[key]
      delete data[norm + "/"]
      yield* fsys
        .writeJson(file, { ...data, [norm]: info }, 0o600)
        .pipe(Effect.mapError(fail("Failed to write auth data")))
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* all()
      delete data[key]
      delete data[norm]
      yield* fsys.writeJson(file, data, 0o600).pipe(Effect.mapError(fail("Failed to write auth data")))
    })

    return Service.of({ get, all, set, remove })
  }),
)

// altimate_change start — Layer.suspend defers facade refs past circular module-init
export const defaultLayer = Layer.suspend(() => layer.pipe(Layer.provide(FSUtil.defaultLayer)))
// altimate_change end

// altimate_change start — thunk LayerNode deps defers facade refs past circular module-init
export const node = LayerNode.make(layer, () => [FSUtil.node])
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
