import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./grep.txt"
import * as Tool from "./tool"
// altimate_change start — enforce read permissions on bounded search results
import { readableSearchResults } from "@/altimate/search-read-permissions"
// altimate_change end

export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "The regex pattern to search for in file contents" }),
  path: Schema.optional(Schema.String).annotate({
    description: "The directory to search in. Defaults to the current working directory.",
  }),
  include: Schema.optional(Schema.String).annotate({
    description: 'File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")',
  }),
})

export const GrepTool = Tool.define(
  "grep",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { pattern: string; path?: string; include?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const empty = {
            title: params.pattern,
            metadata: { matches: 0, truncated: false },
            output: "No files found",
          }
          if (!params.pattern) {
            throw new Error("pattern is required")
          }

          yield* ctx.ask({
            permission: "grep",
            patterns: [params.pattern],
            always: ["*"],
            metadata: {
              pattern: params.pattern,
              path: params.path,
              include: params.include,
            },
          })

          const ins = yield* InstanceState.context
          const requested = path.isAbsolute(params.path ?? ins.directory)
            ? (params.path ?? ins.directory)
            : path.join(ins.directory, params.path ?? ".")
          const requestedInfo = yield* fs.stat(requested).pipe(Effect.catch(() => Effect.succeed(undefined)))
          yield* assertExternalDirectoryEffect(ctx, requested, {
            bypass: false,
            kind: requestedInfo?.type === "Directory" ? "directory" : "file",
          })

          const search = FSUtil.resolve(requested)
          const info = yield* fs.stat(search).pipe(Effect.catch(() => Effect.succeed(undefined)))
          const cwd = info?.type === "Directory" ? search : path.dirname(search)
          // altimate_change start — upstream_fix: keep grep path scoped to exact file arguments.
          const file = info?.type === "Directory" ? undefined : path.basename(search)
          // altimate_change end
          // altimate_change start — bound permission filtering and retain only returned paths for approval
          const limit = 100
          const scanLimit = 10_000
          let scanned = 0
          let permitted = 0
          const readPatterns = new Set<string>()
          // altimate_change end
          const result = yield* ripgrep.grep({
            cwd,
            pattern: params.pattern,
            // altimate_change start — upstream_fix: pass file paths through to ripgrep.
            file,
            // altimate_change end
            include: params.include,
            // altimate_change start — stream through read rules with one permitted lookahead and a scan ceiling
            limit,
            scanLimit,
            filterPath: (relative) => {
              scanned++
              const full = path.resolve(cwd, relative)
              const readable = readableSearchResults([full], ins.worktree, ctx.permissions)
              if (!readable.allowed.has(full)) return false
              permitted++
              if (permitted <= limit) {
                for (const pattern of readable.patterns) readPatterns.add(pattern)
              }
              return true
            },
            // altimate_change end
          })

          // altimate_change start — only retained matches are exposed or included in read approval
          const truncated = permitted > limit || scanned >= scanLimit
          if (result.length === 0) {
            if (!truncated) return empty
            return {
              ...empty,
              metadata: { matches: 0, truncated: true },
              output: "No permitted matches found before the search scan limit.\n\n(Results truncated. Consider using a more specific path or pattern.)",
            }
          }
          const final = result.map((item) => ({
            path: path.resolve(cwd, item.entry.path),
            line: item.line,
            text: item.text,
          }))
          if (readPatterns.size > 0) {
            const patterns = [...readPatterns]
            yield* ctx.ask({ permission: "read", patterns, always: patterns, metadata: {} })
          }
          const total = final.length
          const hasMore = permitted > limit
          // altimate_change end
          const output = [`Found ${total} matches${hasMore ? " (more matches available)" : ""}`]

          let current = ""
          for (const match of final) {
            if (current !== match.path) {
              if (current !== "") output.push("")
              current = match.path
              output.push(`${match.path}:`)
            }
            output.push(`  Line ${match.line}: ${match.text}`)
          }

          if (truncated) {
            output.push("")
            output.push("(Results truncated. Consider using a more specific path or pattern.)")
          }

          return {
            title: params.pattern,
            metadata: {
              matches: total,
              truncated,
            },
            output: output.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
