import path from "path"
import os from "os"
import z from "zod"
import { type ParseError as JsoncParseError, parse as parseJsonc, printParseErrorCode } from "jsonc-parser"
import { NamedError } from "@opencode-ai/util/error"
import { Filesystem } from "@/util/filesystem"
import { Flag } from "@/flag/flag"
import { Global } from "@/global"

export namespace ConfigPaths {
  export async function projectFiles(name: string, directory: string, worktree: string) {
    const files: string[] = []
    for (const file of [`${name}.jsonc`, `${name}.json`]) {
      const found = await Filesystem.findUp(file, directory, worktree)
      for (const resolved of found.toReversed()) {
        files.push(resolved)
      }
    }
    return files
  }

  export async function directories(directory: string, worktree: string) {
    // altimate_change start - dual config dir support: .altimate-code (primary) + .opencode (fallback)
    const configTargets = [".altimate-code", ".opencode"]
    // altimate_change end
    return [
      Global.Path.config,
      ...(!Flag.OPENCODE_DISABLE_PROJECT_CONFIG
        ? await Array.fromAsync(
            Filesystem.up({
              targets: configTargets,
              start: directory,
              stop: worktree,
            }),
          )
        : []),
      ...(await Array.fromAsync(
        Filesystem.up({
          targets: configTargets,
          start: Global.Path.home,
          stop: Global.Path.home,
        }),
      )),
      ...(Flag.OPENCODE_CONFIG_DIR ? [Flag.OPENCODE_CONFIG_DIR] : []),
    ]
  }

  export function fileInDirectory(dir: string, name: string) {
    return [path.join(dir, `${name}.jsonc`), path.join(dir, `${name}.json`)]
  }

  export const JsonError = NamedError.create(
    "ConfigJsonError",
    z.object({
      path: z.string(),
      message: z.string().optional(),
    }),
  )

  export const InvalidError = NamedError.create(
    "ConfigInvalidError",
    z.object({
      path: z.string(),
      issues: z.custom<z.core.$ZodIssue[]>().optional(),
      message: z.string().optional(),
    }),
  )

  /** Read a config file, returning undefined for missing files and throwing JsonError for other failures. */
  export async function readFile(filepath: string) {
    return Filesystem.readText(filepath).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return
      throw new JsonError({ path: filepath }, { cause: err })
    })
  }

  type ParseSource = string | { source: string; dir: string }

  function source(input: ParseSource) {
    return typeof input === "string" ? input : input.source
  }

  function dir(input: ParseSource) {
    return typeof input === "string" ? path.dirname(input) : input.dir
  }

  // altimate_change start — shared env-var interpolation primitives
  // Unified regex for env-var interpolation, single source of truth.
  // Syntaxes (alternation, left-to-right):
  //   1. $${VAR} or $${VAR:-default} — literal escape (docker-compose style)
  //   2. ${VAR} or ${VAR:-default}   — shell/dotenv substitution
  //   3. {env:VAR}                    — raw text injection (backward compat)
  // Exported so other modules (e.g. mcp/discover) can reuse the exact same grammar
  // without forking the regex. See issue #635, #656.
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
   * string value (i.e. a value that is already a parsed JS string, NOT JSON text).
   * Returns the resolved string without any JSON escaping — safe for direct use in
   * process environments, HTTP headers, or anywhere a plain string is needed.
   *
   * Does NOT JSON-escape — use the internal `substitute()` wrapper below if you
   * need that (substitute() operates on raw JSON text pre-parse).
   */
  export function resolveEnvVarsInString(
    value: string,
    stats?: EnvSubstitutionStats,
  ): string {
    return value.replace(ENV_VAR_PATTERN, (match, escaped, dollarVar, dollarDefault, braceVar) => {
      if (escaped !== undefined) {
        // $${VAR} → literal ${VAR}
        if (stats) stats.dollarEscaped++
        return "$" + escaped
      }
      if (dollarVar !== undefined) {
        // ${VAR} / ${VAR:-default}
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
        // {env:VAR} → raw text injection
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

  /** Apply {env:VAR} and {file:path} substitutions to config text. */
  async function substitute(text: string, input: ParseSource, missing: "error" | "empty" = "error") {
    // altimate_change start — unified env-var interpolation
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
    const { dollarRefs, dollarUnresolved, dollarDefaulted, dollarEscaped, legacyBraceRefs, legacyBraceUnresolved } = stats
    // Emit telemetry if any env interpolation happened. Dynamic import avoids a
    // circular dep with @/altimate/telemetry (which imports @/config/config).
    if (dollarRefs > 0 || legacyBraceRefs > 0 || dollarEscaped > 0) {
      import("@/altimate/telemetry")
        .then(({ Telemetry }) => {
          Telemetry.track({
            type: "config_env_interpolation",
            timestamp: Date.now(),
            session_id: Telemetry.getContext().sessionId,
            dollar_refs: dollarRefs,
            dollar_unresolved: dollarUnresolved,
            dollar_defaulted: dollarDefaulted,
            dollar_escaped: dollarEscaped,
            legacy_brace_refs: legacyBraceRefs,
            legacy_brace_unresolved: legacyBraceUnresolved,
          })
        })
        .catch(() => {})
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
  export async function parseText(text: string, input: ParseSource, missing: "error" | "empty" = "error") {
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
}
