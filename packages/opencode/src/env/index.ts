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

// altimate_change start — restore the imperative wrappers upstream removed in the Effect-only
// migration. Env is backed by process.env (no async IO), and the fork callers read it
// synchronously, so these run the Service effects via runSync and return plain values.
const { runSync: runEnvSync } = makeRuntime(Service, defaultLayer)
export function get(key: string) {
  return runEnvSync((s) => s.get(key))
}
export function all() {
  return runEnvSync((s) => s.all())
}
export function set(key: string, value: string) {
  return runEnvSync((s) => s.set(key, value))
}
export function remove(key: string) {
  return runEnvSync((s) => s.remove(key))
}
// altimate_change end

export * as Env from "."
