export * as ConfigPaths from "./paths"

import path from "path"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { unique } from "remeda"
import * as Effect from "effect/Effect"
import { FSUtil } from "@opencode-ai/core/fs-util"

export const files = Effect.fn("ConfigPaths.projectFiles")(function* (
  name: string,
  directory: string,
  worktree?: string,
) {
  const afs = yield* FSUtil.Service
  return (yield* afs.up({
    targets: [`${name}.jsonc`, `${name}.json`],
    start: directory,
    stop: worktree,
  })).toReversed()
})

export const directories = Effect.fn("ConfigPaths.directories")(function* (directory: string, worktree?: string) {
  const afs = yield* FSUtil.Service
  // altimate_change start - dual config dir support: .altimate-code (primary) + .opencode (fallback)
  const configTargets = [".altimate-code", ".opencode"]
  // altimate_change end
  return unique([
    Global.Path.config,
    ...(!Flag.OPENCODE_DISABLE_PROJECT_CONFIG
      ? yield* afs.up({
          targets: configTargets,
          start: directory,
          stop: worktree,
        })
      : []),
    ...(yield* afs.up({
      targets: configTargets,
      start: Global.Path.home,
      stop: Global.Path.home,
    })),
    ...(Flag.OPENCODE_CONFIG_DIR ? [Flag.OPENCODE_CONFIG_DIR] : []),
  ])
})

export function fileInDirectory(dir: string, name: string) {
  return [path.join(dir, `${name}.json`), path.join(dir, `${name}.jsonc`)]
}

// altimate_change start — env-var interpolation grammar shared with mcp/discover (PR #666, #635, #656)
// Restored after the v1.17.9 upstream rewrite of paths.ts dropped these fork helpers.
// Supported syntaxes:
//   1. $${VAR} or $${VAR:-default} — literal escape (docker-compose style)
//   2. ${VAR} or ${VAR:-default}   — shell/dotenv substitution
//   3. {env:VAR}                    — raw text injection (backward compat)
export const ENV_VAR_PATTERN =
  /\$\$(\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\})|(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g

export interface EnvSubstitutionStats {
  dollarRefs: number
  dollarUnresolved: number
  dollarDefaulted: number
  dollarEscaped: number
  legacyBraceRefs: number
  legacyBraceUnresolved: number
  unresolvedNames: string[]
}

/**
 * Resolve ${VAR}, ${VAR:-default}, {env:VAR}, and $${VAR} patterns in a raw
 * string value (already a parsed JS string, NOT JSON text). Returns the resolved
 * string without JSON escaping — safe for process environments, HTTP headers, or
 * anywhere a plain string is needed.
 */
export function resolveEnvVarsInString(value: string, stats?: EnvSubstitutionStats): string {
  return value.replace(ENV_VAR_PATTERN, (match, escaped, dollarVar, dollarDefault, braceVar) => {
    if (escaped !== undefined) {
      if (stats) stats.dollarEscaped++
      return "$" + escaped
    }
    if (dollarVar !== undefined) {
      if (stats) stats.dollarRefs++
      const envValue = process.env[dollarVar]
      const resolved = envValue !== undefined && envValue !== ""
      if (!resolved && dollarDefault !== undefined && stats) stats.dollarDefaulted++
      if (!resolved && dollarDefault === undefined) {
        if (stats) {
          stats.dollarUnresolved++
          stats.unresolvedNames.push(dollarVar)
        }
      }
      return resolved ? envValue : (dollarDefault ?? "")
    }
    if (braceVar !== undefined) {
      if (stats) stats.legacyBraceRefs++
      const v = process.env[braceVar]
      if ((v === undefined || v === "") && stats) {
        stats.legacyBraceUnresolved++
        stats.unresolvedNames.push(braceVar)
      }
      return v || ""
    }
    return match
  })
}

export function newEnvSubstitutionStats(): EnvSubstitutionStats {
  return {
    dollarRefs: 0,
    dollarUnresolved: 0,
    dollarDefaulted: 0,
    dollarEscaped: 0,
    legacyBraceRefs: 0,
    legacyBraceUnresolved: 0,
    unresolvedNames: [],
  }
}
// altimate_change end
