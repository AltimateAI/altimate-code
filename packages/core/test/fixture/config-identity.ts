// altimate: ALT-F01
import path from "node:path"
import { mkdir, readdir } from "node:fs/promises"
import { Effect, Layer, Logger } from "effect"
import { Config } from "@opencode/core/config"
import { ConfigDiscovery } from "@opencode/core/config/discovery"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { Credential } from "@opencode/core/credential"
import { WellKnown } from "@opencode/core/wellknown"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Bus } from "@opencode/core/bus"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { emptyCredentialNode, emptyWellknownNode } from "./config-nodes"
import { location } from "./location"

const root = process.argv[2]
const project = path.join(root, "project")
const global = path.join(root, "global")
const system = path.join(root, "system")
const directories = [global, project, path.join(project, ".altimate-code"), path.join(project, ".opencode"), system]
await Promise.all(directories.map((directory) => mkdir(directory, { recursive: true })))
await Promise.all(
  directories.flatMap((directory) =>
    ["opencode", "altimate-code"].flatMap((name) =>
      ["json", "jsonc"].map((extension) => {
        const file = path.join(directory, `${name}.${extension}`)
        return Bun.write(file, JSON.stringify({ shell: path.relative(root, file) }))
      }),
    ),
  ),
)

function layer(config: string, options: Config.Options) {
  return AppNodeBuilder.build(LayerNode.group([Config.node, Bus.node]), [
    Config.node.replace(Config.configured(options)),
    Location.node.replace(Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(project) }))),
    Global.node.replace(Global.layerWith({ config, home: path.join(root, "home") })),
    Credential.node.replace(emptyCredentialNode),
    WellKnown.node.replace(emptyWellknownNode),
    Watcher.node.replace(Watcher.testLayer),
  ])
}

const entries = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* Config.Service
      const entries = (yield* config.entries()).flatMap((entry) =>
        entry.type === "document" && entry.info.shell ? [entry.info.shell] : [],
      )
      yield* config.update!({ shell: "updated" })
      return entries
    }).pipe(Effect.provide(layer(global, { system })), Effect.provide(Logger.layer([]))),
  ),
)

const empty = path.join(root, "empty")
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* Config.Service
      yield* config.update!({ shell: "created" })
    }).pipe(Effect.provide(layer(empty, { system: false, project: false })), Effect.provide(Logger.layer([]))),
  ),
)

console.log(
  JSON.stringify({
    names: ConfigDiscovery.names,
    entries,
    created: await readdir(empty),
    updated: await Promise.all(
      ["opencode", "altimate-code"].map(async (name) => ({
        name,
        value: await Bun.file(path.join(global, `${name}.jsonc`)).json(),
      })),
    ),
    system: ConfigDiscovery.systemDirectory("linux", {}),
    preferences: ConfigDiscovery.preferencePaths("alice"),
  }),
)
