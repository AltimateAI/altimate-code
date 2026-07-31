export * as OpenCode from "./opencode"

import { Context, Effect, Layer } from "effect"
import { Catalog } from "../catalog"
import { AppNodeBuilder } from "../effect/app-node-builder"
import { LayerNode } from "../effect/layer-node"
import { locationServiceMapLayer, LocationServiceMap } from "../location-services"
import { PluginV2 } from "../plugin"
import { VariantPlugin } from "../plugin/variant"
import { SessionV2 } from "../session"
import { SessionExecution } from "../session/execution"
import * as SessionExecutionLocal from "../session/execution/local"
import { ApplicationTools } from "../tool/application-tools"
import { Session } from "./session"
import { Tool } from "./tool"

export interface Interface {
  readonly sessions: Session.Interface
  readonly tools: Tool.Interface
}

/** Intentional public native API for Effect applications embedding OpenCode. */
export class Service extends Context.Service<Service, Interface>()("@opencode/public/OpenCode") {}

class SessionModelValidation extends Context.Service<
  SessionModelValidation,
  {
    readonly validate: (
      input: Session.SwitchModelInput & { readonly location: Session.Info["location"] },
    ) => Effect.Effect<void, Session.ModelUnavailableError | Session.VariantUnavailableError>
  }
>()("@opencode/public/OpenCode/SessionModelValidation") {}

// altimate_change start — upstream_fix: v1.18.10 replaced the per-module `.layer` exports and
// the standalone `LocationServiceMap.layer` (../location-layer, deleted) with a LayerNode graph
// (see location-services.ts / effect/layer-node.ts). Compose the public API's runtime from each
// module's `.node` and resolve the two remaining unbound nodes at build time:
//  - LocationServiceMap.node with the real `locationServiceMapLayer` — the same module-level
//    singleton session.ts's own `defaultLayer` uses to satisfy the identical unbound dependency.
//  - SessionExecution.node (a routing-only interface, `LayerNode.unbound`) with its concrete
//    same-process implementation, SessionExecutionLocal.node.
// Both LocationServiceMap.node and ApplicationTools.node are included in the root group (not
// just pulled in transitively) so their Services are also part of this Layer's output, letting
// SessionModelValidationLayer and OpenCode.Service consume them directly.
const CoreLayer = AppNodeBuilder.build(
  LayerNode.group([SessionV2.node, ApplicationTools.node, LocationServiceMap.node]),
  [
    [LocationServiceMap.node, locationServiceMapLayer],
    [SessionExecution.node, SessionExecutionLocal.node],
  ],
)

const SessionModelValidationLayer = Layer.effect(
  SessionModelValidation,
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    return SessionModelValidation.of({
      validate: Effect.fn("OpenCode.sessions.validateModel")(function* (input) {
        yield* Effect.gen(function* () {
          // PluginBoot.Service (the old "wait for plugins booted" surface, which awaited a
          // Deferred resolved after every built-in plugin finished its first load) was removed
          // in the v1.18.10 refactor with no direct successor — PluginInternal.node now boots the
          // same built-in plugins sequentially but as a bare forkScoped fiber with no completion
          // signal. session/runner/model.ts's catalog.model.available() call accepts that race
          // ("Location plugins populate and filter the catalog asynchronously during layer
          // startup"), but the public API can be called immediately after `sessions.create`,
          // before that fiber has had a chance to run — reconstruct the old wait by blocking on
          // PluginV2.Service.wait() for "variant", the last plugin PluginInternal.node adds
          // (plugin/internal.ts), since adds run sequentially so its completion implies every
          // earlier built-in plugin — including config-provider, which populates the catalog from
          // this Location's opencode.json — has already settled.
          const plugin = yield* PluginV2.Service
          yield* plugin.wait(PluginV2.ID.make(VariantPlugin.Plugin.id))
          const catalog = yield* Catalog.Service
          // Registering a catalog transform (state.transform, called by each built-in plugin's
          // ctx.catalog.transform) is synchronous, but *applying* it (state.reload) is deferred
          // to the end of the outer State.batch wrapping the whole boot sequence (see
          // plugin/internal.ts / state.ts) — plugin.wait() above only guarantees every transform
          // has been *registered*, not yet materialized. Force a synchronous reload against the
          // now-fully-registered transform set instead of racing that deferred batch flush.
          yield* catalog.reload()
          const model = (yield* catalog.model.available()).find(
            (model) => model.providerID === input.model.providerID && model.id === input.model.id,
          )
          if (!model)
            return yield* new Session.ModelUnavailableError({
              providerID: input.model.providerID,
              modelID: input.model.id,
            })
          if (
            input.model.variant !== undefined &&
            input.model.variant !== "default" &&
            !model.variants.some((variant) => variant.id === input.model.variant)
          )
            return yield* new Session.VariantUnavailableError({
              providerID: input.model.providerID,
              modelID: input.model.id,
              variant: input.model.variant,
            })
        }).pipe(Effect.provide(locations.get(input.location)))
      }),
    })
  }),
).pipe(Layer.provide(CoreLayer))
// altimate_change end

// TODO: Accept explicit storage so tests and embeddings can select disposable or application-owned persistence.
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* SessionV2.Service
    const tools = yield* ApplicationTools.Service
    const validation = yield* SessionModelValidation
    return Service.of({
      tools: { register: tools.register },
      sessions: {
        create: (input) =>
          sessions.create({
            id: input.id,
            agent: input.agent,
            model: input.model,
            location: input.location,
          }),
        get: sessions.get,
        list: sessions.list,
        switchModel: Effect.fn("OpenCode.sessions.switchModel")(function* (input) {
          const session = yield* sessions.get(input.sessionID)
          yield* validation.validate({ ...input, location: session.location })
          yield* sessions.switchModel(input)
        }),
        interrupt: sessions.interrupt,
        prompt: (input) =>
          sessions.prompt({
            id: input.id,
            sessionID: input.sessionID,
            prompt: input.prompt,
            delivery: input.delivery,
          }),
        messages: (input) =>
          sessions.messages({
            sessionID: input.sessionID,
            limit: input.limit,
            order: input.order,
            cursor: input.cursor,
          }),
        message: (input) => sessions.message({ sessionID: input.sessionID, messageID: input.messageID }),
        context: sessions.context,
        events: (input) => sessions.events({ sessionID: input.sessionID, after: input.after }),
      },
    })
  }),
).pipe(Layer.provide(Layer.merge(CoreLayer, SessionModelValidationLayer)))

// TODO: Add OpenCode.create(...) as the Promise facade over the same native API semantics.
