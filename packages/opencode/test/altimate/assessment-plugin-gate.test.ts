/**
 * Assessment mode installs no plugin: each loader skips exactly the specs it would install, and plugins
 * it loads from disk still load.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const { Plugin } = await import("../../src/plugin/index")
const { resolvePluginTarget } = await import("../../src/plugin/shared")
const { BunProc } = await import("../../src/bun")
const { Npm } = await import("@opencode-ai/core/npm")
const { EventV2Bridge } = await import("../../src/event-v2-bridge")
const { TestConfig } = await import("../fixture/config")
const { RuntimeFlags } = await import("../../src/effect/runtime-flags")
const { ConfigPlugin } = await import("../../src/config/plugin")

const saved = process.env.ALTIMATE_ASSESSMENT_MODE
const spies: { mockRestore(): void }[] = []

afterEach(async () => {
  for (const spy of spies.splice(0).reverse()) spy.mockRestore()
  if (saved === undefined) delete process.env.ALTIMATE_ASSESSMENT_MODE
  else process.env.ALTIMATE_ASSESSMENT_MODE = saved
  await disposeAllInstances()
})

const it = testEffect(Layer.mergeAll(CrossSpawnSpawner.defaultLayer, FSUtil.defaultLayer, testInstanceStoreLayer))

/** Loads `plugins` through the plugin service, from a project config that lists them. */
function load(dir: string, plugins: string[]) {
  const source = path.join(dir, "opencode.json")
  return Effect.gen(function* () {
    yield* Effect.promise(() => Bun.write(source, JSON.stringify({ plugin: plugins })))
    const plugin = yield* Plugin.Service
    yield* plugin.list()
  }).pipe(
    Effect.provide(
      Plugin.layer.pipe(
        Layer.provide(EventV2Bridge.defaultLayer),
        Layer.provide(RuntimeFlags.layer({ disableDefaultPlugins: true })),
        Layer.provide(
          TestConfig.layer({
            get: () =>
              Effect.succeed({
                plugin: plugins,
                plugin_origins: plugins.map((spec) => ({ spec, source, scope: "local" as const })),
              }),
            directories: () => Effect.succeed([dir]),
          }),
        ),
      ),
    ),
    provideInstance(dir),
  )
}

/** A file plugin that writes `mark` when it loads. */
async function filePlugin(dir: string) {
  const file = path.join(dir, "plugin.ts")
  const mark = path.join(dir, "loaded.txt")
  await Bun.write(file, `export default async () => {\n  await Bun.write(${JSON.stringify(mark)}, "loaded")\n  return {}\n}\n`)
  return { spec: pathToFileURL(file).href, mark }
}

describe("assessment mode and plugins", () => {
  it.live("the plugin service installs no npm plugin, and a file:// plugin still loads", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const local = yield* Effect.promise(() => filePlugin(dir))
      const install = spyOn(BunProc, "install").mockResolvedValue("")
      spies.push(install)
      process.env.ALTIMATE_ASSESSMENT_MODE = "1"
      yield* load(dir, ["some-npm-plugin@1.0.0", local.spec])
      expect(install).not.toHaveBeenCalled()
      expect(yield* Effect.promise(() => fs.readFile(local.mark, "utf8"))).toBe("loaded")
    }),
  )

  it.live("control: without the mode the same npm plugin is installed", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const install = spyOn(BunProc, "install").mockResolvedValue("")
      spies.push(install)
      delete process.env.ALTIMATE_ASSESSMENT_MODE
      yield* load(dir, ["some-npm-plugin@1.0.0"])
      expect(install).toHaveBeenCalledWith("some-npm-plugin", "1.0.0")
    }),
  )

  it.live("the shared resolver refuses an npm spec without installing it, and still resolves a path spec", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const local = yield* Effect.promise(() => filePlugin(dir))
      const add = spyOn(Npm, "add").mockRejectedValue(new Error("installed"))
      spies.push(add)
      process.env.ALTIMATE_ASSESSMENT_MODE = "1"
      const refused = yield* Effect.promise(() => resolvePluginTarget("some-npm-plugin@1.0.0").catch((e: Error) => e))
      expect((refused as Error).message).toBe("npm plugins are not installed in assessment mode")
      expect(add).not.toHaveBeenCalled()
      expect(yield* Effect.promise(() => resolvePluginTarget(local.spec))).toBe(local.spec)
    }),
  )
})

describe("assessment mode and plugin dependencies", () => {
  test("no dependency install is planned for a directory that would otherwise get one", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "assessment-deps-"))
    const pure = process.env.OPENCODE_PURE
    try {
      await fs.mkdir(path.join(dir, "node_modules"))
      delete process.env.OPENCODE_PURE
      delete process.env.ALTIMATE_ASSESSMENT_MODE
      expect(ConfigPlugin.shouldInstallDependencies(dir, undefined)).toBe(true)
      process.env.ALTIMATE_ASSESSMENT_MODE = "1"
      expect(ConfigPlugin.shouldInstallDependencies(dir, undefined)).toBe(false)
    } finally {
      if (pure === undefined) delete process.env.OPENCODE_PURE
      else process.env.OPENCODE_PURE = pure
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
