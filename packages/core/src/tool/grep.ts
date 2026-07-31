export * as GrepTool from "./grep"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import path from "path"
import { makeLocationNode } from "../effect/app-node"
import { FileSystem } from "../filesystem"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { PermissionV2 } from "../permission"
import { Ripgrep } from "../ripgrep"
import { RelativePath } from "../schema"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "grep"

export const Input = Schema.Struct({
  pattern: FileSystem.GrepInput.fields.pattern.annotate({
    description: "Regex pattern to search for in file contents",
  }),
  path: RelativePath.pipe(Schema.optional).annotate({
    description: "Relative directory to search. Defaults to the active Location.",
  }),
  include: FileSystem.GrepInput.fields.include.annotate({
    description: 'File glob to include in the search (for example, "*.js" or "*.{ts,tsx}")',
  }),
  limit: FileSystem.GrepInput.fields.limit.annotate({
    description: "Maximum matches to return",
  }),
})

export const Output = Schema.Array(FileSystem.Match)
type ModelOutput = typeof Output.Encoded

/** Format raw search matches into the familiar concise model output. */
export const toModelOutput = (output: ModelOutput) => {
  const lines = output.length === 0 ? ["No files found"] : [`Found ${output.length} matches`]
  let current = ""
  for (const match of output) {
    if (current !== match.entry.path) {
      if (current) lines.push("")
      current = match.entry.path
      lines.push(`${match.entry.path}:`)
    }
    lines.push(`  Line ${match.line}: ${match.text}`)
  }
  return lines.join("\n")
}

/** Grep leaf that defaults its filesystem root to the active Location. */
const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    const location = yield* Location.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Search file contents by regular expression within the active Location or an absolute managed tool-output file. Use a path to narrow the search, include to filter files by glob, and limit to bound the match count. Returns concise file resources, line numbers, and bounded line previews.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: toModelOutput(
                output.map((match) => ({
                  ...match,
                  entry: { ...match.entry, path: path.resolve(location.directory, match.entry.path) },
                })),
              ),
            },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: [input.pattern],
                save: ["*"],
                metadata: {
                  root: ".",
                  path: input.path,
                  include: input.include,
                  limit: input.limit,
                },
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              const target = path.resolve(location.directory, input.path ?? ".")
              const info = yield* fs.stat(target).pipe(Effect.catch(() => Effect.succeed(undefined)))
              // altimate_change start — upstream_fix: contain the ACTUAL search root to the active
              // Location. A model-controlled input.path (absolute like /etc, a ".." traversal, or a
              // symlink to an external dir) would otherwise make ripgrep return line previews of file
              // contents outside the project — a recursive content-read escape. We contain-check `cwd`
              // (the dir ripgrep recurses from) via its real, symlink-resolved path. Checking `cwd`
              // rather than `target` is deliberate: cwd is what actually gets searched, and it is the
              // more robust thing to resolve — for input like "symlink-to-outside/missing-leaf",
              // cwd = dirname(target) = the symlink dir, which exists and realPath-resolves to the
              // external dir (→ contained), whereas `target` itself may not exist (a realPath that
              // ENOENT-fell-back to the lexical path could slip through). A genuinely-nonexistent cwd
              // can't be searched (ripgrep errors), so the catch fallback is safe.
              const cwd = info?.type === "Directory" ? target : path.dirname(target)
              const rootReal = yield* fs.realPath(location.directory).pipe(Effect.orDie)
              const cwdReal = yield* fs.realPath(cwd).pipe(Effect.catch(() => Effect.succeed(cwd)))
              if (cwdReal !== rootReal && !FSUtil.contains(rootReal, cwdReal))
                return yield* Effect.die(new Error("grep path escapes the active Location"))
              // When searching a single FILE, contain the file itself too: cwd (its parent dir) can be
              // safely in-project while the file is a symlink pointing outside (e.g. secret ->
              // /etc/passwd), and ripgrep would open the symlink target. realPath the file and require it
              // inside the Location. Fail CLOSED: if realPath fails (dangling/just-swapped symlink), die
              // rather than fall back to the lexical path (which a TOCTOU swap could exploit).
              if (info?.type === "File") {
                const fileReal = yield* fs.realPath(target).pipe(Effect.catch(() => Effect.succeed(undefined)))
                if (fileReal === undefined || !FSUtil.contains(rootReal, fileReal))
                  return yield* Effect.die(new Error("grep path escapes the active Location"))
              }
              // KNOWN RESIDUAL (not a static escape): a precheck like this is inherently TOCTOU — a
              // concurrent process in the checkout could swap `cwd`/the file for an external symlink
              // AFTER these checks and BEFORE ripgrep opens it. Closing that fully needs O_NOFOLLOW fd /
              // in-process search rather than a path-based precheck (the shipped opencode grep's
              // assertExternalDirectory has the same class). Tracked for the v2-core hardening pass; the
              // model-controlled-path escapes (the actually-reachable threat) are closed above.
              // altimate_change end
              return yield* ripgrep
                .grep({
                  cwd,
                  pattern: input.pattern,
                  file: info?.type === "File" ? path.basename(target) : undefined,
                  include: input.include,
                  limit: input.limit ?? Number.MAX_SAFE_INTEGER,
                })
                .pipe(
                  Effect.map((result) =>
                    result.map((match) =>
                      FileSystem.Match.make({
                        ...match,
                        entry: FileSystem.Entry.make({
                          ...match.entry,
                          path: RelativePath.make(
                            path.relative(
                              location.directory,
                              path.resolve(
                                info?.type === "Directory" ? target : path.dirname(target),
                                match.entry.path,
                              ),
                            ),
                          ),
                        }),
                      }),
                    ),
                  ),
                )
            }).pipe(Effect.mapError(() => new ToolFailure({ message: `Unable to grep for ${input.pattern}` }))),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/grep",
  layer,
  deps: [ToolRegistry.node, FSUtil.node, Ripgrep.node, Location.node, PermissionV2.node],
})
