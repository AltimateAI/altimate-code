export * as ClaudeAgentStorage from "./storage"

import path from "path"
import { Effect } from "effect"
import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"
import { Log } from "@/util/log"

const log = Log.create({ service: "claude-agent.storage" })

// Upstream keeps this state in the plugin's own storage; the shipped CLI has no per-plugin store,
// so each key is one JSON file under the data directory.
function root() {
  return path.join(Global.Path.data, "claude-agent")
}

function file(key: string) {
  // Keys are plugin-chosen ("models", "sessions/<session id>"); never let one leave the root.
  const target = path.resolve(root(), `${key}.json`)
  if (!target.startsWith(root() + path.sep)) throw new Error(`Invalid Claude Agent storage key: ${key}`)
  return target
}

export async function read(key: string): Promise<unknown> {
  return Filesystem.readJson(file(key)).catch(() => undefined)
}

export async function write(key: string, value: unknown) {
  await Filesystem.writeJson(file(key), value)
}

// The shape ClaudeSessions expects. A failed write must not fail a chat, so it is logged and dropped.
export const sessions = {
  get: (key: string) => Effect.promise(() => read(key)),
  set: (key: string, value: unknown) =>
    Effect.promise(() =>
      write(key, value).catch((error) => log.warn("failed to save Claude session record", { key, error })),
    ),
}
