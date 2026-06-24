import { TuiConfig } from "@opencode-ai/tui/config"
import { isRecord } from "@opencode-ai/tui/util/record"
import { Schema } from "effect"
import path from "path"
import { fileURLToPath } from "url"

function resolveHostSoundPath(root: string, value: string) {
  // altimate_change start — preserve file URL sound paths as local host paths instead of resolving "file:" as relative.
  if (value.startsWith("file://")) return fileURLToPath(value)
  // altimate_change end
  return path.isAbsolute(value) ? value : path.resolve(root, value)
}

export function resolveHostAttentionSoundPaths(
  root: string,
  sounds: unknown,
  options?: { trim?: boolean },
): TuiConfig.AttentionSoundPaths {
  if (!isRecord(sounds)) return {}
  return Object.fromEntries(
    Object.entries(sounds).flatMap(([name, file]) => {
      if (!Schema.is(TuiConfig.AttentionSoundName)(name)) return []
      if (typeof file !== "string") return []
      const value = options?.trim ? file.trim() : file
      if (!value) return []
      return [[name, resolveHostSoundPath(root, value)]]
    }),
  )
}
