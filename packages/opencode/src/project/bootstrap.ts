import { unwatchFile, watchFile } from "node:fs"
import { stat, readFile } from "node:fs/promises"
import path from "node:path"
import { Effect, Layer, Stream } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
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
import { Config } from "@/config/config"
import { Service } from "./bootstrap-service"
import { Instance } from "./instance"
// altimate_change start — upstream_fix: bridge merge dropped the Truncate.init()
// call below. Without it the hourly Scheduler cleanup task for tool-output files
// (Global.Path.data/tool-output/tool_*) never registers, so the directory grows
// unboundedly. Restore main's call site.
import { Truncate } from "../tool/truncation"
// altimate_change end

export { Service } from "./bootstrap-service"
export type { Interface } from "./bootstrap-service"

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

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Yield each bootstrap dep at layer init so `run` itself has R = never.
    // InstanceStore imports only the lightweight tag from bootstrap-service.ts,
    // so it can depend on bootstrap without importing this implementation graph.
    const config = yield* Config.Service
    const format = yield* Format.Service
    const lsp = yield* LSP.Service
    const plugin = yield* Plugin.Service
    const project = yield* Project.Service
    const shareNext = yield* ShareNext.Service
    const snapshot = yield* Snapshot.Service
    const vcs = yield* Vcs.Service
    // altimate_change start — bootstrap needs EventV2Bridge for the branch-HEAD watcher and the
    // Command.Event.Executed -> Project.setInitialized bridge below (both fork additions, absent upstream)
    const events = yield* EventV2Bridge.Service
    // altimate_change end

    const run = Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      yield* Effect.logInfo("bootstrapping", { directory: ctx.directory })
      // everything depends on config so eager load it for nice traces
      yield* config.get()
      // Plugin can mutate config so it has to be initialized before anything else.
      yield* plugin.init()

      // altimate_change start — upstream_fix: bootstrap branch watcher for Vcs.init()
      yield* startBranchHeadWatcher(ctx, events)
      // altimate_change end

      // altimate_change start — File.init still uses the legacy Instance.state store.
      yield* Effect.sync(() => Instance.restore(ctx, () => File.init()))
      // altimate_change end

      // Each service self-manages its own slow work via Effect.forkScoped against
      // its per-instance state scope. We just await materialization here.
      yield* Effect.forEach(
        [lsp, shareNext, format, vcs, snapshot, project],
        (s) => s.init().pipe(Effect.catchCause((cause) => Effect.logWarning("init failed", { cause }))),
        { concurrency: "unbounded", discard: true },
      ).pipe(Effect.withSpan("InstanceBootstrap.init"))

      // altimate_change start — upstream_fix: see header note for why this is here
      yield* Effect.sync(() => Truncate.init())
      // altimate_change end

      // altimate_change start — mark the project initialized once the dbt/etc `init` command runs
      const projectID = ctx.project.id
      yield* Stream.runForEach(events.subscribe(Command.Event.Executed), (payload) =>
        payload.data.name === Command.Default.INIT ? project.setInitialized(projectID) : Effect.void,
      ).pipe(Effect.forkDetach)
      // altimate_change end
    }).pipe(Effect.withSpan("InstanceBootstrap"))

    return Service.of({ run })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer: layer,
  // altimate_change start — EventV2Bridge.node: the branch-HEAD watcher + setInitialized bridge
  // above need EventV2Bridge.Service, which upstream's bootstrap doesn't depend on.
  deps: [
    Config.node,
    Format.node,
    LSP.node,
    Plugin.node,
    Project.node,
    ShareNext.node,
    Snapshot.node,
    Vcs.node,
    EventV2Bridge.node,
  ],
  // altimate_change end
})

// altimate_change start — imperative bootstrap entrypoint for the fork's ALS-based
// `Instance.provide({ init })` path (server.ts / project.ts / serve-upgrade-check.ts).
// Upstream drives `bootstrap.run` via the Effect InstanceStore; the fork still boots
// instances through the imperative `Instance` namespace, so expose the same `run`
// Effect as an async callback that explicitly threads the active InstanceRef. The
// Effect layer exports above (Service/layer/node) serve the upstream path.
async function bootstrap() {
  const { Instance } = await import("./instance")
  const { AppRuntime } = await import("@/effect/app-runtime")
  const ctx = Instance.current
  const runBootstrap = Effect.gen(function* () {
    const service = yield* Service
    yield* service.run
  })
  await AppRuntime.runPromise(runBootstrap.pipe(Effect.provideService(InstanceRef, ctx)))
}

export const InstanceBootstrap = Object.assign(bootstrap, {
  Service,
  layer,
  node,
})
// altimate_change end
