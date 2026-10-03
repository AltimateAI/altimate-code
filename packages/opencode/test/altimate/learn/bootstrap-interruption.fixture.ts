// Run only in a subprocess so the pending startup imports cannot affect other tests.
import { expect, spyOn } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer, Stream } from "effect"

const pending = process.env.LEARN_PENDING_STARTUP
const entered = Promise.withResolvers<void>()
const release = Promise.withResolvers<void>()
const starts: string[] = []
Bun.plugin({
  name: "learning startup interruption",
  setup(builder) {
    builder.onLoad({ filter: /[/\\]learn[/\\](capture|schedule)\.ts$/ }, () => ({
      loader: "object",
      exports: Object.fromEntries(["capture", "schedule"].map((module) => [
        module === "capture" ? "startCapture" : "startScheduler",
        async () => {
          starts.push(module)
          if (module !== pending) return
          entered.resolve()
          await release.promise
        },
      ])),
    }))
  },
})

const { CrossSpawnSpawner } = await import("@opencode-ai/core/cross-spawn-spawner")
const { InstanceBootstrap } = await import("../../../src/project/bootstrap")
const { InstanceBootstrap: BootstrapService } = await import("../../../src/project/bootstrap-service")
const { InstanceRef } = await import("../../../src/effect/instance-ref")
const { Plugin } = await import("../../../src/plugin")
const { ShareNext } = await import("../../../src/share/share-next")
const { Format } = await import("../../../src/format")
const { LSP } = await import("../../../src/lsp/lsp")
const { Vcs } = await import("../../../src/project/vcs")
const { Snapshot } = await import("../../../src/snapshot")
const { Project } = await import("../../../src/project/project")
const { ProjectID } = await import("../../../src/project/schema")
const { EventV2Bridge } = await import("../../../src/event-v2-bridge")
const { File } = await import("../../../src/file")
const { Truncate } = await import("../../../src/tool/truncation")
const { tmpdirScoped } = await import("../../fixture/fixture")
const { testEffect, awaitWithTimeout } = await import("../../lib/effect")

spyOn(File, "init").mockImplementation(() => {})
spyOn(Truncate, "init").mockImplementation(() => {})
const dependencies = Layer.mergeAll(
  Layer.mock(Plugin.Service, { init: () => Effect.void }),
  Layer.mock(ShareNext.Service, { init: () => Effect.void }),
  Layer.mock(Format.Service, { init: () => Effect.void }),
  Layer.mock(LSP.Service, { init: () => Effect.void }),
  Layer.mock(Vcs.Service, { init: () => Effect.void }),
  Layer.mock(Snapshot.Service, { init: () => Effect.void }),
  Layer.mock(Project.Service, {}),
  Layer.mock(EventV2Bridge.Service, { subscribe: () => Stream.empty }),
)
const it = testEffect(Layer.mergeAll(
  InstanceBootstrap.layer.pipe(Layer.provide(dependencies)),
  CrossSpawnSpawner.defaultLayer,
))
it.live(`interrupting ${pending} startup prevents bootstrap completion`, () => Effect.gen(function* () {
  const directory = yield* tmpdirScoped()
  const ctx = {
    directory,
    worktree: directory,
    project: { id: ProjectID.make("global"), worktree: directory, time: { created: 0, updated: 0 }, sandboxes: [] },
  }
  process.env.ALTIMATE_LEARN_CAPTURE = "1"
  process.env.ALTIMATE_LEARN_AUTO = "1"
  let completed = false
  const bootstrap = yield* BootstrapService.Service
  const fiber = yield* bootstrap.run.pipe(
    Effect.provideService(InstanceRef, ctx),
    Effect.andThen(Effect.sync(() => { completed = true })),
    Effect.forkScoped,
  )
  yield* awaitWithTimeout(Effect.promise(() => entered.promise), "startup never reached pending promise")
  yield* Fiber.interrupt(fiber)
  const exit = yield* Fiber.await(fiber)
  release.resolve()
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  expect(completed).toBe(false)
  expect(starts).toEqual(pending === "capture" ? ["capture"] : ["capture", "schedule"])
}))
