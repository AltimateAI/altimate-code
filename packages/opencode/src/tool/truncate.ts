import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { NodePath } from "@effect/platform-node"
import { Cause, Duration, Effect, Layer, Option, Schedule, Context } from "effect"
import path from "path"
import type { Agent } from "../agent/agent"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { evaluate } from "@/permission/evaluate"
import { Config } from "@/config/config"
import { ToolID } from "./schema"
import { TRUNCATION_DIR } from "./truncation-dir"
// altimate_change start — shared truncation algorithm (see truncate-core.ts
// header) so this Service and the tool/truncation.ts twin can't drift.
import { TruncateCore } from "./truncate-core"
// altimate_change end

const RETENTION = Duration.days(7)

export const MAX_LINES = TruncateCore.MAX_LINES
export const MAX_BYTES = TruncateCore.MAX_BYTES
export const DIR = TRUNCATION_DIR
export const GLOB = path.join(TRUNCATION_DIR, "*")

export type Result = { content: string; truncated: false } | { content: string; truncated: true; outputPath: string }

export type Options = TruncateCore.Options

function hasTaskTool(agent?: Agent.Info) {
  if (!agent?.permission) return false
  return evaluate("task", "*", agent.permission).action !== "deny"
}

export interface Interface {
  readonly cleanup: () => Effect.Effect<void>
  readonly write: (text: string) => Effect.Effect<string>
  /**
   * Returns output unchanged when it fits within the limits, otherwise writes the full text
   * to the truncation directory and returns a preview plus a hint to inspect the saved file.
   */
  readonly output: (text: string, options?: Options, agent?: Agent.Info) => Effect.Effect<Result>
  /**
   * Resolved truncation limits: values from `tool_output` in opencode config, or MAX_LINES / MAX_BYTES if unset.
   */
  readonly limits: () => Effect.Effect<{ maxLines: number; maxBytes: number }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Truncate") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service

    const cleanup = Effect.fn("Truncate.cleanup")(function* () {
      // altimate_change start — upstream_fix: age files by mtime, not decoded ID timestamps.
      // Identifier packs `timestamp * 4096` into 48 bits, which wraps every
      // 2^36 ms (~795 days) — the 26th wrap landed 2026-08-14T11:19:55Z, after
      // which every new ID decoded as "ancient" and cleanup deleted files the
      // moment they were written. File mtime has no wrap.
      const cutoffMs = Date.now() - Duration.toMillis(RETENTION)
      const entries = yield* fs.readDirectory(TRUNCATION_DIR).pipe(
        Effect.map((all) => all.filter((name) => name.startsWith("tool_"))),
        Effect.catch(() => Effect.succeed([])),
      )
      for (const entry of entries) {
        const file = path.join(TRUNCATION_DIR, entry)
        // Stat through the INJECTED filesystem (FSUtil extends FileSystem) so
        // custom/in-memory providers behave identically to the host FS.
        const info = yield* fs.stat(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
        // Unstat-able file or absent mtime: keep it — deletion must fail safe.
        const mtimeMs =
          info && Option.isSome(info.mtime) ? info.mtime.value.getTime() : Number.POSITIVE_INFINITY
        if (mtimeMs >= cutoffMs) continue
        yield* fs.remove(file).pipe(Effect.catch(() => Effect.void))
      }
      // altimate_change end
    })

    const write = Effect.fn("Truncate.write")(function* (text: string) {
      const file = path.join(TRUNCATION_DIR, ToolID.ascending())
      yield* fs.ensureDir(TRUNCATION_DIR).pipe(Effect.orDie)
      yield* fs.writeFileString(file, text).pipe(Effect.orDie)
      return file
    })

    const limits = Effect.fn("Truncate.limits")(function* () {
      const configSvc = yield* Effect.serviceOption(Config.Service)
      if (Option.isNone(configSvc)) return { maxLines: MAX_LINES, maxBytes: MAX_BYTES }
      const cfg = yield* configSvc.value.get().pipe(Effect.catch(() => Effect.succeed(undefined)))
      return {
        maxLines: cfg?.tool_output?.max_lines ?? MAX_LINES,
        maxBytes: cfg?.tool_output?.max_bytes ?? MAX_BYTES,
      }
    })

    // altimate_change start — default direction "middle" (head+tail,
    // tail-weighted elision) via the shared truncate-core.ts algorithm.
    const output = Effect.fn("Truncate.output")(function* (text: string, options: Options = {}, agent?: Agent.Info) {
      const resolved = yield* limits()
      const maxLines = options.maxLines ?? resolved.maxLines
      const maxBytes = options.maxBytes ?? resolved.maxBytes
      const direction = options.direction ?? TruncateCore.DEFAULT_DIRECTION
      const headRatio = options.headRatio ?? TruncateCore.DEFAULT_HEAD_RATIO
      const lines = text.split("\n")
      const totalBytes = Buffer.byteLength(text, "utf-8")

      if (TruncateCore.fits(lines, totalBytes, maxLines, maxBytes)) {
        return { content: text, truncated: false } as const
      }

      const preview = TruncateCore.preview(lines, totalBytes, { maxLines, maxBytes, direction, headRatio })
      const file = yield* write(text)

      const hint = hasTaskTool(agent)
        ? `The tool call succeeded but the output was truncated. Full output saved to: ${file}\nUse the Task tool to have explore agent process this file with Grep and Read (with offset/limit). Do NOT read the full file yourself - delegate to save context.`
        : `The tool call succeeded but the output was truncated. Full output saved to: ${file}\nUse Grep to search the full content or Read with offset/limit to view specific sections.`

      return {
        content: TruncateCore.assemble(preview, hint, direction),
        truncated: true,
        outputPath: file,
      } as const
    })
    // altimate_change end

    yield* cleanup().pipe(
      Effect.catchCause((cause) => Effect.logError("truncation cleanup failed", { cause: Cause.pretty(cause) })),
      Effect.repeat(Schedule.spaced(Duration.hours(1))),
      Effect.delay(Duration.minutes(1)),
      Effect.forkScoped,
    )

    return Service.of({ cleanup, write, output, limits })
  }),
)

// altimate_change start — Layer.suspend defers facade refs past circular module-init
export const defaultLayer = Layer.suspend(() => layer.pipe(Layer.provide(FSUtil.defaultLayer), Layer.provide(NodePath.layer)))
// altimate_change end

// altimate_change start — thunk LayerNode deps defers facade refs past circular module-init
export const node = LayerNode.make(layer, () => [FSUtil.node])
// altimate_change end

export * as Truncate from "./truncate"
