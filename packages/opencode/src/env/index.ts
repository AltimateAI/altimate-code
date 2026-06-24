import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer } from "effect"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { InstanceState } from "@/effect/instance-state"
// altimate_change start — makeRuntime for the restored Promise wrappers (bottom of file)
import { makeRuntime } from "@/effect/run-service"
// altimate_change end

type State = Record<string, string | undefined>

export interface Interface {
  readonly get: (key: string) => Effect.Effect<string | undefined>
  readonly all: () => Effect.Effect<State>
  readonly set: (key: string, value: string) => Effect.Effect<void>
  readonly remove: (key: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Env") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make<State>(Effect.fn("Env.state")(() => Effect.succeed({ ...process.env })))

    const get = Effect.fn("Env.get")((key: string) => InstanceState.use(state, (env) => env[key]))
    const all = Effect.fn("Env.all")(() => InstanceState.get(state))
    const set = Effect.fn("Env.set")(function* (key: string, value: string) {
      const env = yield* InstanceState.get(state)
      env[key] = value
    })
    const remove = Effect.fn("Env.remove")(function* (key: string) {
      const env = yield* InstanceState.get(state)
      delete env[key]
    })

    return Service.of({ get, all, set, remove })
  }),
)

export const defaultLayer = layer

export const node = LayerNode.make(layer, [])

// altimate_change start — restore the imperative Promise wrappers upstream removed in the
// Effect-only migration; backed by the instance-bound makeRuntime so reads/writes stay scoped.
const { runPromise: runEnv } = makeRuntime(Service, defaultLayer)
export async function get(key: string) {
  return runEnv((s) => s.get(key))
}
export async function all() {
  return runEnv((s) => s.all())
}
export async function set(key: string, value: string) {
  return runEnv((s) => s.set(key, value))
}
export async function remove(key: string) {
  return runEnv((s) => s.remove(key))
}
// altimate_change end

export * as Env from "."
