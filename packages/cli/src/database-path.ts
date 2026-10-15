// altimate: ALT-F01
import { Env } from "@opencode/util/env"
import path from "node:path"
import { OPENCODE_CHANNEL } from "./version"

export function databasePath(data: string) {
  const filename =
    // altimate: ALT-F01
    Env.get("OPENCODE_DB") ??
    (["latest", "dev", "beta", "next", "prod"].includes(OPENCODE_CHANNEL) ||
    Env.get("OPENCODE_DISABLE_CHANNEL_DB") === "1" ||
    Env.get("OPENCODE_DISABLE_CHANNEL_DB") === "true"
      ? "opencode.db"
      : `opencode-${OPENCODE_CHANNEL.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
  return filename === ":memory:" ? filename : path.resolve(data, filename)
}
