export * as ConfigPaths from "./paths"

import path from "path"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { unique } from "remeda"
import * as Effect from "effect/Effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
// altimate_change start — imports for restored parseText (JSONC + env/file substitution)
import os from "os"
import { type ParseError as JsoncParseError, parse as parseJsonc, printParseErrorCode } from "jsonc-parser"
import { Filesystem } from "@/util/filesystem"
import { JsonError, InvalidError } from "@opencode-ai/core/v1/config/error"
// altimate_change end

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

// Restored after the v1.17.9 upstream rewrite of paths.ts dropped these fork
// helpers. Tests at test/config/paths-parsetext.test.ts exercise this surface.
// JsonError/InvalidError now live in @opencode-ai/core/v1/config/error and are
// re-exported here under the names the fork's call sites/tests expect.
export { JsonError, InvalidError }

type ParseSource = string | { source: string; dir: string }

function source(input: ParseSource) {
  return typeof input === "string" ? input : input.source
}

function dir(input: ParseSource) {
  return typeof input === "string" ? path.dirname(input) : input.dir
}

/** Apply ${VAR}/${VAR:-default}/$${VAR}/{env:VAR} and {file:path} substitutions to config text. */
async function substitute(text: string, input: ParseSource, missing: "error" | "empty" = "error") {
  // Single-pass substitution against the ORIGINAL text prevents output of one
  // pattern being re-matched by another (e.g. {env:A}="${B}" expanding B).
  // Uses the shared ENV_VAR_PATTERN grammar, adding JSON-escaping for values
  // substituted into raw JSON text (which is then parsed). This is the ONLY
  // call site that applies JSON escaping; raw-string callers should use
  // `resolveEnvVarsInString` instead.
  const stats = newEnvSubstitutionStats()
  text = text.replace(ENV_VAR_PATTERN, (match, escaped, dollarVar, dollarDefault, braceVar) => {
    if (escaped !== undefined) {
      stats.dollarEscaped++
      return "$" + escaped
    }
    if (dollarVar !== undefined) {
      stats.dollarRefs++
      const envValue = process.env[dollarVar]
      const resolved = envValue !== undefined && envValue !== ""
      if (!resolved && dollarDefault !== undefined) stats.dollarDefaulted++
      if (!resolved && dollarDefault === undefined) {
        stats.dollarUnresolved++
        stats.unresolvedNames.push(dollarVar)
      }
      const value = resolved ? envValue : (dollarDefault ?? "")
      // JSON-escape because this substitution happens against raw JSON text.
      return JSON.stringify(value).slice(1, -1)
    }
    if (braceVar !== undefined) {
      // {env:VAR} → raw text injection (backward compat)
      stats.legacyBraceRefs++
      const v = process.env[braceVar]
      if (v === undefined || v === "") {
        stats.legacyBraceUnresolved++
        stats.unresolvedNames.push(braceVar)
      }
      return v || ""
    }
    return match
  })

  const fileMatches = Array.from(text.matchAll(/\{file:[^}]+\}/g))
  if (!fileMatches.length) return text

  const configDir = dir(input)
  const configSource = source(input)
  let out = ""
  let cursor = 0

  for (const match of fileMatches) {
    const token = match[0]
    const index = match.index!
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

    out += JSON.stringify(fileContent).slice(1, -1)
    cursor = index + token.length
  }

  out += text.slice(cursor)
  return out
}

/** Substitute and parse JSONC text, throwing JsonError on syntax errors. */
export async function parseText(text: string, input: ParseSource, missing: "error" | "empty" = "error"): Promise<any> {
  const configSource = source(input)
  text = await substitute(text, input, missing)

  const errors: JsoncParseError[] = []
  const data = parseJsonc(text, errors, { allowTrailingComma: true })
  if (errors.length) {
    const lines = text.split("\n")
    const errorDetails = errors
      .map((e) => {
        const beforeOffset = text.substring(0, e.offset).split("\n")
        const line = beforeOffset.length
        const column = beforeOffset[beforeOffset.length - 1].length + 1
        const problemLine = lines[line - 1]

        const error = `${printParseErrorCode(e.error)} at line ${line}, column ${column}`
        if (!problemLine) return error

        return `${error}\n   Line ${line}: ${problemLine}\n${"".padStart(column + 9)}^`
      })
      .join("\n")

    throw new JsonError({
      path: configSource,
      message: `\n--- JSONC Input ---\n${text}\n--- Errors ---\n${errorDetails}\n--- End ---`,
    })
  }

  return data
}
// altimate_change end
