export * as ConfigVariable from "./variable"

import path from "path"
import os from "os"
import { Filesystem } from "@/util/filesystem"
import { InvalidError } from "@opencode-ai/core/v1/config/error"
// altimate_change start — upstream_fix: restore ${VAR}/${VAR:-default}/$${VAR} config interpolation
import { ConfigPaths } from "@/config/paths"
import { Global } from "@/global"
// altimate_change end

type ParseSource =
  | {
      type: "path"
      path: string
    }
  | {
      type: "virtual"
      source: string
      dir: string
    }

type SubstituteInput = ParseSource & {
  text: string
  missing?: "error" | "empty"
  env?: Record<string, string>
  // altimate_change start — upstream_fix: restore ${VAR}/${VAR:-default}/$${VAR} config interpolation
  format?: "json" | "raw"
  // altimate_change end
}

// altimate_change start — upstream_fix (#701): keep the names of variables that silently blanked.
// An unresolved bare `${VAR}` is left LITERAL above on purpose, so it stays visible and is not
// recorded here. `{env:VAR}` has no such deferral — it becomes "" and the config parses clean, so
// a missing `{env:SNOWFLAKE_PASSWORD}` launches an MCP server with a blank credential and fails
// later with an error naming neither the variable nor this file.
//
// Keyed projectDir -> config source. One process serves several projects (the server resolves an
// instance per request from `x-opencode-directory`), and a flat source-keyed map meant
// `blankedEnvVars()` handed every session every other project's config files.
const _blankedEnv = new Map<string, Set<string>>()

/** Drop `src`'s record so a load starts clean; substitution then unions within that load. */
export function resetBlankedEnvVars(src: string) {
  _blankedEnv.delete(src)
}

/**
 * Variable names that silently became "" during config substitution, grouped by config source.
 *
 * Scoped by path rather than by threading a project through `substitute`: a config file that
 * lives under a *different* project belongs to that project's session, not this one. One process
 * serves several projects (the server resolves an instance per request from
 * `x-opencode-directory`), and an unfiltered record handed every session every other project's
 * files. Sources that are not project-local — the global config dir, `OPENCODE_CONFIG_CONTENT`,
 * a remote config URL — are shared by every instance and are always included.
 */
export function blankedEnvVars(projectDir: string): { source: string; names: string[] }[] {
  return [..._blankedEnv.entries()]
    .filter(([src]) => !isForeignProjectPath(src, projectDir))
    .map(([src, names]) => ({ source: src, names: [...names].sort() }))
    .sort((a, b) => a.source.localeCompare(b.source))
}

/** True when `src` is an absolute path that sits outside `projectDir` and outside the config dir. */
function isForeignProjectPath(src: string, projectDir: string): boolean {
  if (!path.isAbsolute(src)) return false // OPENCODE_CONFIG_CONTENT, a URL — shared
  const rel = path.relative(projectDir, src)
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return false // under this project
  // The user-level config dir and the home directory are shared by every instance.
  const shared = [Global.Path.config, os.homedir()].filter(Boolean) as string[]
  return !shared.some((base) => {
    const r = path.relative(base, src)
    return r !== "" && !r.startsWith("..") && !path.isAbsolute(r)
  })
}
// altimate_change end

function source(input: ParseSource) {
  return input.type === "path" ? input.path : input.source
}

function dir(input: ParseSource) {
  return input.type === "path" ? path.dirname(input.path) : input.dir
}

/** Apply {env:VAR} and {file:path} substitutions to config text. */
export async function substitute(input: SubstituteInput) {
  const missing = input.missing ?? "error"
  // altimate_change start — upstream_fix: restore ${VAR}/${VAR:-default}/$${VAR} config interpolation
  const format = input.format ?? "json"
  const encode = (value: string) => (format === "raw" ? value : JSON.stringify(value).slice(1, -1))
  // altimate_change — upstream_fix (#701): collect blanked names for this parse, replacing any
  // earlier entry for the same source rather than accumulating stale ones.
  const blanked = new Set<string>()
  let text = input.text.replace(ConfigPaths.ENV_VAR_PATTERN, (match, escaped, dollarVar, dollarDefault, braceVar) => {
    if (escaped !== undefined) return "$" + escaped
    if (dollarVar !== undefined) {
      const envValue = input.env?.[dollarVar] ?? process.env[dollarVar]
      const resolved = envValue !== undefined && envValue !== ""
      if (resolved) return encode(envValue)
      if (dollarDefault !== undefined) return encode(dollarDefault)
      // Unresolved bare ${VAR} (unset/empty, no default): leave the placeholder LITERAL rather than
      // blanking it. Some values are resolved by a later runtime layer — e.g. the bedrock provider
      // fills ${AWS_REGION} from the effective (config-precedence) region after config load. Blanking
      // here would pre-empt that and yield an empty region (bedrock-mantle..api.aws).
      return match
    }
    if (braceVar !== undefined) {
      const value = input.env?.[braceVar] ?? process.env[braceVar]
      // altimate_change — upstream_fix (#701): record the blank, then behave exactly as before.
      if (!value) blanked.add(braceVar)
      return value || ""
    }
    return match
  })
  // altimate_change end

  // altimate_change start — upstream_fix (#701): publish after the whole text is scanned.
  // Union, not replace: one source is substituted more than once — a remote config resolves
  // its `url` and then each header separately, all under the same source. Replacing meant a
  // later clean call erased the names an earlier call had found, so `mcp list` silently
  // omitted a blank credential. Clearing is `resetBlankedEnvVars`, called per load below.
  if (blanked.size > 0) {
    const existing = _blankedEnv.get(source(input))
    if (existing) for (const name of blanked) existing.add(name)
    else _blankedEnv.set(source(input), blanked)
  }
  // altimate_change end

  const fileMatches = Array.from(text.matchAll(/\{file:[^}]+\}/g))
  if (!fileMatches.length) return text

  const configDir = dir(input)
  const configSource = source(input)
  let out = ""
  let cursor = 0

  for (const match of fileMatches) {
    const token = match[0]
    const index = match.index
    out += text.slice(cursor, index)

    const lineStart = text.lastIndexOf("\n", index - 1) + 1
    const prefix = text.slice(lineStart, index).trimStart()
    if (prefix.startsWith("//")) {
      out += token
      cursor = index + token.length
      continue
    }

    let filePath = token.replace(/^\{file:/, "").replace(/\}$/, "")
    if (filePath.startsWith("~/")) {
      filePath = path.join(os.homedir(), filePath.slice(2))
    }

    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(configDir, filePath)
    const fileContent = (
      await Filesystem.readText(resolvedPath).catch((error: NodeJS.ErrnoException) => {
        if (missing === "empty") return ""

        const errMsg = `bad file reference: "${token}"`
        if (error.code === "ENOENT") {
          throw new InvalidError(
            {
              path: configSource,
              message: errMsg + ` ${resolvedPath} does not exist`,
            },
            { cause: error },
          )
        }
        throw new InvalidError({ path: configSource, message: errMsg }, { cause: error })
      })
    ).trim()

    // altimate_change start — upstream_fix: keep raw-string substitution callers unescaped
    out += format === "raw" ? fileContent : JSON.stringify(fileContent).slice(1, -1)
    // altimate_change end
    cursor = index + token.length
  }

  out += text.slice(cursor)
  return out
}
