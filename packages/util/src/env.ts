// altimate: ALT-F01
export * as Env from "./env.js"

import { Identity } from "./identity.js"

/** Names are ordered by the host's preference; unrelated environment variables stay literal. */
export function keys(key: string) {
  return key.startsWith("OPENCODE_")
    ? Identity.envPrefixes.map((prefix) => prefix + key.slice("OPENCODE_".length))
    : [key]
}

/** Empty aliases fall back, but the upstream variable retains its original empty-value semantics. */
export function get(key: string, environment: NodeJS.ProcessEnv = process.env) {
  const names = keys(key)
  return names
    .map((name) => environment[name])
    .find((value, index) => value !== undefined && (value !== "" || index === names.length - 1))
}
