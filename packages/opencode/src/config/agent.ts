export * as ConfigAgent from "./agent"

import path from "path"
import { Exit, Schema } from "effect"
import { Glob } from "@opencode-ai/core/util/glob"
import { ConfigAgentV1 } from "@opencode-ai/core/v1/config/agent"
import { configEntryNameFromPath } from "./entry-name"
import * as ConfigMarkdown from "./markdown"
import { ConfigParse } from "./parse"
// altimate_change start — a folded agent key is logged, not silently accepted
import { Log } from "../util/log"

/** Log the top-level keys of one agent config that the schema folds into `options`. */
export function warnUnknownKeys(name: string, data: unknown, source: string) {
  const keys = ConfigAgentV1.unknownKeys(data)
  if (!keys.length) return
  Log.Default.warn("agent config: keys outside the agent schema were folded into options", {
    agent: name,
    source,
    keys: keys.join(","),
    known: ConfigAgentV1.knownKeys.join(","),
  })
}

/** The same for every entry of a parsed config's `agent` and `mode` sections. */
export function warnUnknownKeysInConfig(config: unknown, source: string) {
  if (typeof config !== "object" || config === null) return
  for (const section of ["agent", "mode"] as const) {
    const entries = (config as Record<string, unknown>)[section]
    if (typeof entries !== "object" || entries === null) continue
    for (const [name, data] of Object.entries(entries)) warnUnknownKeys(name, data, source)
  }
}
// altimate_change end

export async function load(dir: string) {
  const result: Record<string, ConfigAgentV1.Info> = {}
  for (const item of await Glob.scan("{agent,agents}/**/*.md", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    const md = await ConfigMarkdown.parse(item).catch(() => undefined)
    if (!md) continue

    const name = configEntryNameFromPath(path.relative(dir, item), ["agent/", "agents/"])

    const config = {
      name,
      ...md.data,
      prompt: md.content.trim(),
    }
    result[config.name] = ConfigParse.schema(ConfigAgentV1.Info, config, item)
    // altimate_change start — name the frontmatter keys the schema folded into options
    warnUnknownKeys(name, md.data, item)
    // altimate_change end
  }
  return result
}

export async function loadMode(dir: string) {
  const result: Record<string, ConfigAgentV1.Info> = {}
  for (const item of await Glob.scan("{mode,modes}/*.md", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    const md = await ConfigMarkdown.parse(item).catch(() => undefined)
    if (!md) continue

    const config = {
      name: configEntryNameFromPath(path.relative(dir, item), ["mode/", "modes/"]),
      ...md.data,
      prompt: md.content.trim(),
    }
    const parsed = Schema.decodeUnknownExit(ConfigAgentV1.Info)(config, { errors: "all", propertyOrder: "original" })
    if (Exit.isSuccess(parsed)) {
      result[config.name] = {
        ...parsed.value,
        mode: "primary" as const,
      }
      // altimate_change start — name the frontmatter keys the schema folded into options
      warnUnknownKeys(config.name, md.data, item)
      // altimate_change end
    }
  }
  return result
}
