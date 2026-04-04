import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { Filesystem } from "../util/filesystem"
import DESCRIPTION from "./glob.txt"
import { Ripgrep } from "../file/ripgrep"
import { Instance } from "../project/instance"
import { assertExternalDirectory } from "./external-directory"
// altimate_change start — glob hardening: timeout, home/root blocking, default exclusions
import os from "os"
import { abortAfter } from "../util/abort"
import { IGNORE_PATTERNS } from "./ls"

const GLOB_TIMEOUT_MS = 30_000
// altimate_change end

export const GlobTool = Tool.define("glob", {
  description: DESCRIPTION,
  parameters: z.object({
    pattern: z.string().describe("The glob pattern to match files against"),
    path: z
      .string()
      .optional()
      .describe(
        `The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.`,
      ),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "glob",
      patterns: [params.pattern],
      always: ["*"],
      metadata: {
        pattern: params.pattern,
        path: params.path,
      },
    })

    let search = params.path ?? Instance.directory
    search = path.isAbsolute(search) ? search : path.resolve(Instance.directory, search)
    await assertExternalDirectory(ctx, search, { kind: "directory" })

    // altimate_change start — block home/root directory to prevent scanning entire filesystem
    const homeDir = os.homedir()
    if (search === "/" || search === homeDir) {
      return {
        title: path.relative(Instance.worktree, search),
        metadata: { count: 0, truncated: false },
        output: `The directory "${search}" is too broad to search. Please specify a more specific \`path\` parameter within your project or a subdirectory.`,
      }
    }
    // altimate_change end

    const limit = 100
    const files = []
    let truncated = false
    // altimate_change start — 30s timeout with default directory exclusions
    let timedOut = false

    const defaultExclusions = IGNORE_PATTERNS.map((p) => `!${p}*`)
    const globs = [params.pattern, ...defaultExclusions]

    const timeout = abortAfter(GLOB_TIMEOUT_MS)
    const localAbort = new AbortController()
    const parentSignals = ctx.abort ? [ctx.abort] : []
    const signal = AbortSignal.any([timeout.signal, localAbort.signal, ...parentSignals])

    try {
      for await (const file of Ripgrep.files({
        cwd: search,
        glob: globs,
        signal,
      })) {
        if (files.length >= limit) {
          truncated = true
          break
        }
        const full = path.resolve(search, file)
        const stats = Filesystem.stat(full)?.mtime.getTime() ?? 0
        files.push({
          path: full,
          mtime: stats,
        })
      }
    } catch (err: any) {
      if (
        err?.name === "AbortError" &&
        timeout.signal.aborted &&
        !ctx.abort?.aborted
      ) {
        // Our timeout fired — return partial results
        timedOut = true
      } else {
        // User cancellation, ENOENT, permission error, etc. — propagate
        throw err
      }
    } finally {
      localAbort.abort()
      timeout.clearTimeout()
    }
    // altimate_change end
    files.sort((a, b) => b.mtime - a.mtime)

    const output = []
    // altimate_change start — timeout-aware output messages
    if (files.length === 0 && timedOut) {
      output.push(
        `Glob search timed out after ${GLOB_TIMEOUT_MS / 1000}s with no results. The search directory "${search}" is too broad for the pattern "${params.pattern}". Use a more specific \`path\` parameter to narrow the search scope.`,
      )
    } else if (files.length === 0) {
      output.push("No files found")
    }
    if (files.length > 0) {
      output.push(...files.map((f) => f.path))
      if (timedOut) {
        output.push("")
        output.push(
          `(Search timed out after ${GLOB_TIMEOUT_MS / 1000}s: only partial results shown. Use a more specific \`path\` parameter to narrow the search scope.)`,
        )
      } else if (truncated) {
        output.push("")
        output.push(
          `(Results are truncated: showing first ${limit} results. Consider using a more specific path or pattern.)`,
        )
      }
    }

    return {
      title: path.relative(Instance.worktree, search),
      metadata: {
        count: files.length,
        // altimate_change start — include timeout in truncated flag
        truncated: truncated || timedOut,
        // altimate_change end
      },
      output: output.join("\n"),
    }
    // altimate_change end
  },
})
