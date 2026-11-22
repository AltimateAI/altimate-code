import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./grep.txt"
import * as Tool from "./tool"
// altimate_change start — enforce read permissions on bounded search results
import type { Match } from "@opencode-ai/core/filesystem/schema"
import { readableSearchResults, searchReadApproval } from "@/altimate/search-read-permissions"
import type { CredentialRedactor } from "@/altimate/tool-output-credentials"
// altimate_change end

// altimate_change start — redact adjacent source lines before adding labels or clipping
type RenderedLine = { path: string; line: number; text: string }

function redactSourceLines(
  rows: RenderedLine[],
  sourceLines: readonly Ripgrep.GrepSourceLine[],
  redact: CredentialRedactor,
): void {
  const pieces: string[] = []
  const ranges: { row: RenderedLine; from: number; to: number; clipped: boolean }[] = []
  let length = 0

  function flush() {
    if (ranges.length) {
      const source = pieces.join("")
      if (
        ranges[0].from === 0 &&
        ranges[ranges.length - 1].to === source.length &&
        ranges.every((range) => !range.clipped)
      ) {
        const redacted = redact.lines(source)
        if (redacted !== source) {
          const lines = redacted.split(/(?<=\n)/)
          for (const [index, range] of ranges.entries()) range.row.text = lines[index] ?? ""
        }
      } else {
        for (const { row, from, to, clipped } of ranges) {
          const visible = source.slice(from, to)
          const rendered = redact.window(source, from, to)
          if (visible === rendered) continue
          const ending = visible.endsWith("\r\n") ? "\r\n" : visible.endsWith("\n") ? "\n" : ""
          row.text = rendered + (rendered.endsWith(ending) ? "" : ending) + (clipped ? "..." : "")
        }
      }
    }
    pieces.length = ranges.length = length = 0
  }

  for (const [index, row] of rows.entries()) {
    const source = sourceLines[index]
    const previous = rows[index - 1]
    const previousSource = sourceLines[index - 1]
    if (
      previous &&
      (previous.path !== row.path ||
        previous.line + 1 !== row.line ||
        !(previousSource.tail ?? previousSource.head).endsWith("\n"))
    ) {
      flush()
    }

    ranges.push({
      row,
      from: length,
      to: length + source.visibleEnd,
      clipped: source.tail !== undefined || source.visibleEnd < source.head.length,
    })
    pieces.push(source.head)
    length += source.head.length
    if (source.tail !== undefined) {
      // The omitted middle is a real gap. Keep the tail for matches that cross
      // the next newline, without inventing adjacency between head and tail.
      flush()
      pieces.push(source.tail)
      length = source.tail.length
    }
  }
  flush()
}
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
          // altimate_change start — approve bounded search candidates before reading content
          const limit = 100
          const scanLimit = 10_000
          let scanned = 0
          let permitted = 0
          const readPatterns = new Set<string>()
          const readable = (relative: string) => {
            const full = info?.type === "Directory" ? path.resolve(requested, relative) : requested
            const resolved = path.resolve(cwd, relative)
            const checked = readableSearchResults([full, resolved], ins.worktree, ctx.permissions)
            return checked.allowed.has(full) && checked.allowed.has(resolved) ? checked : undefined
          }
          // This listing uses --files: ask-scoped content must remain unread until approval.
          // `*` is the listing default and must not become an explicit --glob on the content pass,
          // so both passes see exactly the same files.
          const include = params.include === "*" ? undefined : params.include
          const candidates = file ? [file] : (yield* ripgrep.find({
            cwd,
            pattern: include ?? "*",
            hidden: true,
            limit: scanLimit,
          })).map((entry) => entry.path)
          const listedToLimit = !file && candidates.length >= scanLimit
          const readableCandidates = candidates.filter((relative) => {
            const checked = readable(relative)
            if (!checked) return false
            for (const pattern of checked.patterns) readPatterns.add(pattern)
            return true
          })
          if (readPatterns.size > 0) {
            yield* ctx.ask(searchReadApproval([...readPatterns], ctx.permissions))
          }
          // Recheck after approval in case the rules changed while the prompt was open.
          // Literal, rooted globs also keep newly discovered files out of the content search.
          const approved = new Set(readableCandidates.filter((relative) => {
            const checked = readable(relative)
            return checked && checked.patterns.every((pattern) => readPatterns.has(pattern))
          }))
          const filterPath = (relative: string) => {
            scanned++
            const candidate = path.relative(cwd, path.resolve(cwd, relative)).split(path.sep).join("/")
            // Deny on either the requested alias or the resolved target; never return an unlisted file.
            if (!approved.has(candidate) || !readable(relative)) return false
            permitted++
            return true
          }
          const redact = ctx.redactCredentials
          const sourceLines: Ripgrep.GrepSourceLine[] = []
          const sourceContext = redact?.windowLookaround
            ? {
                lookaround: redact.windowLookaround,
                onMatch: (line: Ripgrep.GrepSourceLine) => {
                  sourceLines.push(line)
                },
              }
            : undefined
          const result: Match[] = []
          if (!listedToLimit && approved.size === candidates.length) {
            // Every candidate was listed and approved: one content search, as before. A listing cut at
            // the cap may hide unlisted files, so it always takes the restricted path below.
            result.push(...(yield* ripgrep.grep({
              cwd,
              pattern: params.pattern,
              file,
              include,
              limit,
              scanLimit,
              filterPath,
              sourceContext,
            })))
          } else {
            // Some candidates are denied or unapproved: restrict ripgrep to the approved files so a denied
            // file with many matches neither gets read nor consumes the scan ceiling. Literal, rooted globs
            // are batched to keep each argument list bounded.
            const batches: string[][] = []
            let argumentBytes = 0
            for (const relative of approved) {
              const literal = `/${relative.replace(/[\\*?\[\]{}]/g, "\\$&")}`
              const bytes = Buffer.byteLength(literal) + 64
              if (batches.length === 0 || argumentBytes + bytes > 16_384) {
                batches.push([])
                argumentBytes = 0
              }
              batches[batches.length - 1]!.push(literal)
              argumentBytes += bytes
            }
            for (const batch of batches) {
              if (permitted > limit || scanned >= scanLimit) break
              result.push(...(yield* ripgrep.grep({
                cwd,
                pattern: params.pattern,
                file,
                include: file ? include : batch,
                limit: limit - result.length,
                scanLimit: scanLimit - scanned,
                filterPath,
                sourceContext,
              })))
            }
          }

          const truncated = listedToLimit || permitted > limit || scanned >= scanLimit
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
          if (redact && sourceLines.length === final.length) redactSourceLines(final, sourceLines, redact)
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
