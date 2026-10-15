// altimate: ALT-F01
import { Env } from "@opencode/util/env"
import { defaults, Identity } from "@opencode/util/identity"
import { existsSync } from "node:fs"
import path from "node:path"
import { OPENCODE_CHANNEL } from "./version"

export function databasePath(data: string) {
  // altimate: ALT-F01
  const override = Env.get("OPENCODE_DB")
  const suffix =
    ["latest", "dev", "beta", "next", "prod"].includes(OPENCODE_CHANNEL) ||
    Env.get("OPENCODE_DISABLE_CHANNEL_DB") === "1" ||
    Env.get("OPENCODE_DISABLE_CHANNEL_DB") === "true"
      ? ""
      : `-${OPENCODE_CHANNEL.replace(/[^a-zA-Z0-9._-]/g, "-")}`
  const filename = override ?? `${Identity.app}${suffix}.db`
  if (filename === ":memory:") return filename
  const target = path.resolve(data, filename)
  if (override !== undefined || Identity.app === defaults.app || existsSync(target)) return target
  // Include the unsuffixed v1 database even when this build uses a channel-specific target.
  const legacy = [path.join(data, `${defaults.app}${suffix}.db`), path.join(data, `${defaults.app}.db`)].find(
    existsSync,
  )
  if (legacy)
    throw new Error(
      `Existing database ${legacy} found, but ${target} does not exist. No data was moved. ` +
        `Set ${Env.keys("OPENCODE_DB")[0]} to ${JSON.stringify(legacy)} to use the existing database, ` +
        `or migrate a consistent SQLite copy to ${target} before restarting.`,
    )
  return target
}
