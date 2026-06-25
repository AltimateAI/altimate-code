export * as GlobTool from "./glob"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import path from "path"
import { FileSystem } from "../filesystem"
// altimate_change start — upstream_fix: FSUtil for Location containment (see execute)
import { FSUtil } from "../fs-util"
// altimate_change end
import { Location } from "../location"
import { Ripgrep } from "../ripgrep"
import { RelativePath } from "../schema"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "glob"

export const Input = Schema.Struct({
  pattern: FileSystem.GlobInput.fields.pattern.annotate({ description: "Glob pattern to match files against" }),
  path: RelativePath.pipe(Schema.optional).annotate({
    description: "Relative directory to search. Defaults to the active Location.",
  }),
  limit: FileSystem.GlobInput.fields.limit.annotate({
    description: "Maximum results to return",
  }),
})

export const Output = Schema.Array(FileSystem.Entry)
type ModelOutput = typeof Output.Encoded

/** Format raw search results into the concise line-oriented output models expect. */
export const toModelOutput = (output: ModelOutput) => {
  const lines = output.length === 0 ? ["No files found"] : output.map((item) => item.path)
  return lines.join("\n")
}

/** Glob leaf that defaults its filesystem root to the active Location. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const ripgrep = yield* Ripgrep.Service
    const location = yield* Location.Service
    const permission = yield* PermissionV2.Service
    // altimate_change start — upstream_fix: fs for the Location-containment realPath check (see execute)
    const fs = yield* FSUtil.Service
    // altimate_change end

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Find files by glob pattern within the active Location. Returns concise relative file resources. Use a relative path to narrow the search and limit to bound the result count.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: toModelOutput(
                output.map((entry) => ({ ...entry, path: path.resolve(location.directory, entry.path) })),
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
                  root: input.path ?? ".",
                  path: input.path,
                  limit: input.limit,
                },
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              const cwd = path.resolve(location.directory, input.path ?? ".")
              // altimate_change start — upstream_fix: contain the glob root to the active Location.
              // Twin of the grep.ts containment: a model-controlled input.path (absolute, ".."
              // traversal, or a symlink to an external dir) would otherwise let ripgrep enumerate
              // file NAMES outside the project. Lower severity than grep (names, not contents) but the
              // same escape, so reject it the same way via the real, symlink-resolved path.
              const rootReal = yield* fs.realPath(location.directory).pipe(Effect.orDie)
              const cwdReal = yield* fs.realPath(cwd).pipe(Effect.catch(() => Effect.succeed(cwd)))
              if (cwdReal !== rootReal && !FSUtil.contains(rootReal, cwdReal))
                return yield* Effect.die(new Error("glob path escapes the active Location"))
              // altimate_change end
              return yield* ripgrep
                .glob({
                  cwd,
                  pattern: input.pattern,
                  limit: input.limit ?? Number.MAX_SAFE_INTEGER,
                })
                .pipe(
                  Effect.map((result) =>
                    result.map(
                      (entry) =>
                        new FileSystem.Entry({
                          ...entry,
                          path: RelativePath.make(path.relative(location.directory, path.resolve(cwd, entry.path))),
                        }),
                    ),
                  ),
                )
            }).pipe(
              Effect.mapError(() => new ToolFailure({ message: `Unable to find files matching ${input.pattern}` })),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)
