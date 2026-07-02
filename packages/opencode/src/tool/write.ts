import { Schema } from "effect"
import * as path from "path"
import { Effect } from "effect"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import { createTwoFilesPatch } from "diff"
import DESCRIPTION from "./write.txt"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { Format } from "../format"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { trimDiff } from "./edit"
import { assertExternalDirectoryEffect, assertSensitiveWriteEffect } from "./external-directory"
import * as Bom from "@/util/bom"
// altimate_change start — upstream_fix: restore stale-file guard (dropped in v1.17.9 merge)
import { FileTime } from "../file/time"
import { Instance, type InstanceContext } from "../project/instance"
// altimate_change end

const MAX_PROJECT_DIAGNOSTICS_FILES = 5
// altimate_change start — upstream_fix: restore stale-file guard (dropped in v1.17.9 merge)
const STALE_FILE_MESSAGE = "File was modified since it was read — read it again before modifying it."

const assertFreshFile = Effect.fn("WriteTool.assertFreshFile")(function* (
  instance: InstanceContext,
  ctx: Tool.Context,
  filepath: string,
) {
  yield* Effect.tryPromise({
    try: () => Instance.restore(instance, () => FileTime.assert(ctx.sessionID, filepath)),
    catch: (error) => {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes("has been modified since it was last read")) {
        return new Error(`${STALE_FILE_MESSAGE}\n\n${message}`)
      }
      return error instanceof Error ? error : new Error(message)
    },
  })
})
// altimate_change end

export const Parameters = Schema.Struct({
  content: Schema.String.annotate({ description: "The content to write to the file" }),
  filePath: Schema.String.annotate({
    description: "The absolute path to the file to write (must be absolute, not relative)",
  }),
})

export const WriteTool = Tool.define(
  "write",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const fs = yield* FSUtil.Service
    const events = yield* EventV2Bridge.Service
    const format = yield* Format.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { content: string; filePath: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const filepath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(instance.directory, params.filePath)
          yield* assertExternalDirectoryEffect(ctx, filepath)
          // altimate_change start — upstream_fix: restore #209 sensitive-write guard (separate permission)
          yield* assertSensitiveWriteEffect(ctx, filepath)
          // altimate_change end

          const exists = yield* fs.existsSafe(filepath)
          // altimate_change start — upstream_fix: restore stale-file guard (dropped in v1.17.9 merge)
          if (exists) yield* assertFreshFile(instance, ctx, filepath)
          // altimate_change end
          const source = exists ? yield* Bom.readFile(fs, filepath) : { bom: false, text: "" }
          const next = Bom.split(params.content)
          const desiredBom = source.bom || next.bom
          const contentOld = source.text
          const contentNew = next.text

          const diff = trimDiff(createTwoFilesPatch(filepath, filepath, contentOld, contentNew))
          yield* ctx.ask({
            permission: "edit",
            patterns: [path.relative(instance.worktree, filepath)],
            always: ["*"],
            metadata: {
              filepath,
              diff,
            },
          })

          yield* fs.writeWithDirs(filepath, Bom.join(contentNew, desiredBom))
          if (yield* format.file(filepath)) {
            yield* Bom.syncFile(fs, filepath, desiredBom)
          }
          yield* events.publish(FileSystem.Event.Edited, { file: filepath })
          yield* events.publish(Watcher.Event.Updated, {
            file: filepath,
            event: exists ? "change" : "add",
          })
          // altimate_change start — upstream_fix: restore stale-file guard (dropped in v1.17.9 merge)
          Instance.restore(instance, () => FileTime.read(ctx.sessionID, filepath))
          // altimate_change end

          let output = "Wrote file successfully."
          yield* lsp.touchFile(filepath, "document")
          const diagnostics = yield* lsp.diagnostics()
          const normalizedFilepath = FSUtil.normalizePath(filepath)
          let projectDiagnosticsCount = 0
          for (const [file, issues] of Object.entries(diagnostics)) {
            const current = file === normalizedFilepath
            if (!current && projectDiagnosticsCount >= MAX_PROJECT_DIAGNOSTICS_FILES) continue
            const block = LSP.Diagnostic.report(current ? filepath : file, issues)
            if (!block) continue
            if (current) {
              output += `\n\nLSP errors detected in this file, please fix:\n${block}`
              continue
            }
            projectDiagnosticsCount++
            output += `\n\nLSP errors detected in other files:\n${block}`
          }

          return {
            title: path.relative(instance.worktree, filepath),
            metadata: {
              diagnostics,
              filepath,
              exists: exists,
            },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
