export * as ConfigVariable from "./variable"

import path from "path"
import os from "os"
import { Filesystem } from "@/util/filesystem"
import { InvalidError } from "@opencode-ai/core/v1/config/error"
// altimate_change start — upstream_fix: restore ${VAR}/${VAR:-default}/$${VAR} config interpolation
import { ConfigPaths } from "@/config/paths"
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
const _blankedEnv = new Map<string, Set<string>>()

/**
 * Who a config source belongs to: a project directory, or SHARED for one every instance loads.
 *
 * Declared by the loader rather than guessed from the path. An earlier attempt inferred it —
 * "under this project, or under $HOME/the config dir, is mine" — which is wrong in the ordinary
 * case, because projects live under $HOME: `/Users/me/code/projB/altimate-code.json` was
 * classified as shared and leaked into project A's diagnostics. The loader always knows; the
 * path never reliably tells you.
 */
const _sourceOwner = new Map<string, string>()

/** Marker for a config every instance in the process loads: global config, OPENCODE_CONFIG, managed. */
export const SHARED_CONFIG = "\u0000shared"

/**
 * Drop `src`'s record so a load starts clean, and declare who it belongs to.
 *
 * `owner` is the project directory being loaded, or `SHARED_CONFIG`. Substitution then unions
 * into the source within that load.
 */
export function resetBlankedEnvVars(src: string, owner: string) {
  _blankedEnv.delete(src)
  _sourceOwner.set(src, owner)
}

/**
 * Variable names that silently became "" while loading `projectDir`, grouped by config source.
 *
 * Returns this project's own sources plus the shared ones. A source whose owner was never
 * declared is omitted: a diagnostic that cannot be attributed is not worth showing to the wrong
 * session, and every loader in this file declares one.
 */
export function blankedEnvVars(projectDir: string): { source: string; names: string[] }[] {
  return [..._blankedEnv.entries()]
    .filter(([src]) => {
      const owner = _sourceOwner.get(src)
      return owner === projectDir || owner === SHARED_CONFIG
    })
    .map(([src, names]) => ({ source: src, names: [...names].sort() }))
    .sort((a, b) => a.source.localeCompare(b.source))
}

/** Test seam — forget every source's ownership and recorded names. */
export function resetAllBlankedEnvVars() {
  _blankedEnv.clear()
  _sourceOwner.clear()
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
