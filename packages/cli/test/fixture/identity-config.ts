// altimate: ALT-F01
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect } from "effect"
import { Global } from "@opencode/util/global"
import { Config } from "../../src/config"
import { resolveConfigPath } from "../../src/commands/handlers/mcp/add"
import { localPluginDirectories } from "@opencode/tui/plugin/discovery"

const root = process.argv[2]
const project = path.join(root, "project")
const global = path.join(root, "global")
await mkdir(path.join(project, ".git"), { recursive: true })
const empty = await resolveConfigPath(project)
const initialPlugins = await localPluginDirectories(project, global)
await Bun.write(path.join(project, "opencode.jsonc"), "{}")
const fallback = await resolveConfigPath(project)
await Bun.write(path.join(project, "altimate-code.json"), "{}")
await Bun.write(path.join(project, "opencode.json"), "{}")
const competing = await resolveConfigPath(project)
await mkdir(path.join(project, ".opencode"), { recursive: true })
await mkdir(path.join(project, ".altimate-code"), { recursive: true })
const plugins = await localPluginDirectories(project, global)
const config = await Effect.runPromise(
  Effect.gen(function* () {
    const config = yield* Config.Service
    return { path: config.path, value: yield* config.get() }
  }).pipe(
    Effect.provide(Config.layer),
    Effect.provide(Global.layerWith({ config: global, state: path.join(root, "state") })),
    Effect.provide(NodeFileSystem.layer),
  ),
)
console.log(JSON.stringify({ empty, fallback, competing, initialPlugins, plugins, config }))
