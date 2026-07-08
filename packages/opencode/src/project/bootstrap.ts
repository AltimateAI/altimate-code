import { unwatchFile, watchFile } from "node:fs"
import { stat, readFile } from "node:fs/promises"
import path from "node:path"
import { Effect, Layer, Stream } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { Location } from "@opencode-ai/core/location"
import { Project as CoreProject } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Plugin } from "../plugin"
import { Format } from "../format"
import { LSP } from "../lsp/lsp"
import { File } from "../file"
import { Snapshot } from "../snapshot"
import { Project } from "./project"
import { Vcs } from "./vcs"
import { Command } from "../command"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import { ShareNext } from "@/share/share-next"
import { Service as BootstrapService } from "./bootstrap-service"
import { Instance } from "./instance"
// altimate_change start — upstream_fix: bridge merge dropped the Truncate.init()
// call below. Without it the hourly Scheduler cleanup task for tool-output files
// (Global.Path.data/tool-output/tool_*) never registers, so the directory grows
// unboundedly. Restore main's call site.
import { Truncate } from "../tool/truncation"
// altimate_change end

// altimate_change start — upstream_fix: restore branch HEAD watcher in shipped bootstrap
async function gitHeadPath(directory: string) {
  const dotgit = path.join(directory, ".git")
  const dotgitStat = await stat(dotgit).catch(() => undefined)
  if (dotgitStat?.isDirectory()) return path.join(dotgit, "HEAD")
  if (dotgitStat?.isFile()) {
    const content = await readFile(dotgit, "utf8").catch(() => "")
    const match = /^gitdir:\s*(.+)\s*$/m.exec(content)
    if (match) {
      const gitdir = path.isAbsolute(match[1]) ? match[1] : path.resolve(directory, match[1])
      return path.join(gitdir, "HEAD")
    }
  }
  return path.join(dotgit, "HEAD")
}

async function headStamp(file: string) {
  const [info, content] = await Promise.all([
    stat(file).then(
      (value) => value.mtimeMs,
      () => 0,
    ),
    readFile(file, "utf8").catch(() => ""),
  ])
  return `${info}:${content}`
}

const startBranchHeadWatcher = Effect.fn("InstanceBootstrap.startBranchHeadWatcher")(function* (
  ctx: InstanceContext,
  events: EventV2.Interface,
) {
  if (ctx.project.vcs !== "git") return
  const head = yield* Effect.promise(() => gitHeadPath(ctx.worktree))
  let last = yield* Effect.promise(() => headStamp(head))
  const location = new Location.Info({
    directory: AbsolutePath.make(ctx.directory),
    project: { id: CoreProject.ID.make(ctx.project.id), directory: AbsolutePath.make(ctx.worktree) },
  })
  const context = yield* Effect.context()
  const runFork = Effect.runForkWith(context)

  yield* Effect.sync(() => {
    let stopped = false
    const publish = () => {
      void headStamp(head).then((next) => {
        if (stopped || next === last) return
        last = next
        runFork(
          events.publish(Watcher.Event.Updated, { file: head, event: "change" }, { location }).pipe(Effect.ignore),
        )
      })
    }
    const stop = () => {
      if (stopped) return
      stopped = true
      unwatchFile(head, publish)
      GlobalBus.off("event", onEvent)
    }
    const onEvent = (event: GlobalEvent) => {
      if (event.directory === ctx.directory && event.payload?.type === "server.instance.disposed") stop()
    }
    watchFile(head, { persistent: false, interval: 500 }, publish)
    GlobalBus.on("event", onEvent)
  })
})
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
  // altimate_change start — upstream_fix: bootstrap branch watcher for Vcs.init()
  yield* startBranchHeadWatcher(ctx, events)
  // altimate_change end

  yield* plugin.init()
  yield* share.init()
  yield* format.init()
  yield* lsp.init()
  // altimate_change start — File.init still uses the legacy Instance.state store.
  yield* Effect.sync(() => Instance.restore(ctx, () => File.init()))
  // altimate_change end
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

// altimate_change start — Layer.suspend defers the facade .defaultLayer reads past the circular
// module-init (the fork Service facades are added to namespace modules that participate in import
// cycles; accessing X.defaultLayer at module-eval yielded undefined).
export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(ShareNext.defaultLayer),
    Layer.provide(Format.defaultLayer),
    Layer.provide(LSP.defaultLayer),
    Layer.provide(Vcs.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(Project.defaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
  ),
)
// altimate_change end

// altimate_change start — upstream_fix: thunk defers reading cyclically-imported facade
// `.node` exports until buildLayer runs, avoiding load-time undefined.
export const node = LayerNode.make(layer, () => [
  Plugin.node,
  ShareNext.node,
  Format.node,
  LSP.node,
  Vcs.node,
  Snapshot.node,
  Project.node,
  EventV2Bridge.node,
])
// altimate_change end

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
