import { Effect, Layer, Stream } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Plugin } from "../plugin"
import { Format } from "../format"
import { LSP } from "../lsp/lsp"
import { File } from "../file"
import { Snapshot } from "../snapshot"
import { Project } from "./project"
import { Vcs } from "./vcs"
import { Command } from "../command"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { InstanceRef } from "@/effect/instance-ref"
import { ShareNext } from "@/share/share-next"
import { Service as BootstrapService } from "./bootstrap-service"
// altimate_change start — upstream_fix: bridge merge dropped the Truncate.init()
// call below. Without it the hourly Scheduler cleanup task for tool-output files
// (Global.Path.data/tool-output/tool_*) never registers, so the directory grows
// unboundedly. Restore main's call site.
import { Truncate } from "../tool/truncation"
// altimate_change end

// Per-instance bootstrap logic. Requires the individual services (provided by the
// bootstrap layer's deps in the upstream path, or by AppRuntime's AppLayer in the
// fork's imperative path) plus the InstanceRef supplied by the caller.
const runBootstrap = Effect.gen(function* () {
  const plugin = yield* Plugin.Service
  const share = yield* ShareNext.Service
  const format = yield* Format.Service
  const lsp = yield* LSP.Service
  const vcs = yield* Vcs.Service
  const snapshot = yield* Snapshot.Service
  const project = yield* Project.Service
  const events = yield* EventV2Bridge.Service

  const ctx = yield* InstanceState.context
  yield* Effect.logInfo("bootstrapping", { directory: ctx.directory })

  yield* plugin.init()
  yield* share.init()
  yield* format.init()
  yield* lsp.init()
  yield* Effect.sync(() => File.init())
  yield* vcs.init()
  yield* snapshot.init()
  // altimate_change start — upstream_fix: see header note for why this is here
  yield* Effect.sync(() => Truncate.init())
  // altimate_change end

  const projectID = ctx.project.id
  yield* Stream.runForEach(events.subscribe(Command.Event.Executed), (payload) =>
    payload.data.name === Command.Default.INIT ? project.setInitialized(projectID) : Effect.void,
  ).pipe(Effect.forkDetach)
})

export const layer: Layer.Layer<
  BootstrapService,
  never,
  | Plugin.Service
  | ShareNext.Service
  | Format.Service
  | LSP.Service
  | Vcs.Service
  | Snapshot.Service
  | Project.Service
  | EventV2Bridge.Service
> = Layer.effect(
  BootstrapService,
  Effect.gen(function* () {
    // Capture the bootstrap dependencies at layer construction so the per-instance
    // `run` Effect surfaces no requirements beyond the InstanceRef the caller supplies.
    const context = yield* Effect.context<
      | Plugin.Service
      | ShareNext.Service
      | Format.Service
      | LSP.Service
      | Vcs.Service
      | Snapshot.Service
      | Project.Service
      | EventV2Bridge.Service
    >()
    return BootstrapService.of({ run: Effect.provide(runBootstrap, context) })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Plugin.defaultLayer),
  Layer.provide(ShareNext.defaultLayer),
  Layer.provide(Format.defaultLayer),
  Layer.provide(LSP.defaultLayer),
  Layer.provide(Vcs.defaultLayer),
  Layer.provide(Snapshot.defaultLayer),
  Layer.provide(Project.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
)

export const node = LayerNode.make(layer, [
  Plugin.node,
  ShareNext.node,
  Format.node,
  LSP.node,
  Vcs.node,
  Snapshot.node,
  Project.node,
  EventV2Bridge.node,
])

// altimate_change start — imperative bootstrap entrypoint for the fork's ALS-based
// `Instance.provide({ init })` path (server.ts / project.ts / serve-upgrade-check.ts).
// Upstream drives `bootstrap.run` via the Effect InstanceStore; the fork still boots
// instances through the imperative `Instance` namespace, so expose the same `run`
// Effect as an async callback that explicitly threads the active InstanceRef. The
// Effect layer exports above (Service/layer/defaultLayer/node) serve the upstream path.
async function bootstrap() {
  const { Instance } = await import("./instance")
  const { AppRuntime } = await import("@/effect/app-runtime")
  const ctx = Instance.current
  await AppRuntime.runPromise(runBootstrap.pipe(Effect.provideService(InstanceRef, ctx)))
}

export const InstanceBootstrap = Object.assign(bootstrap, {
  Service: BootstrapService,
  layer,
  defaultLayer,
  node,
})
// altimate_change end
