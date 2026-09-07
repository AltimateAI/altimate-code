import fs from "fs/promises"
import path from "path"
import { Global } from "../global"
import { PermissionNext } from "../permission/next"
import type { Agent } from "../agent/agent"
import { Scheduler } from "../scheduler"
import { Filesystem } from "../util/filesystem"
import { Glob } from "../util/glob"
import { ToolID } from "./schema"
// altimate_change start — shared truncation algorithm (see truncate-core.ts
// header) so this twin and tool/truncate.ts's Effect Service can't drift.
import { TruncateCore } from "./truncate-core"
// altimate_change end

export namespace Truncate {
  export const MAX_LINES = TruncateCore.MAX_LINES
  export const MAX_BYTES = TruncateCore.MAX_BYTES
  export const DIR = path.join(Global.Path.data, "tool-output")
  export const GLOB = path.join(DIR, "*")
  const RETENTION_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
  const HOUR_MS = 60 * 60 * 1000

  export type Result = { content: string; truncated: false } | { content: string; truncated: true; outputPath: string }

  export type Options = TruncateCore.Options

  export function init() {
    Scheduler.register({
      id: "tool.truncation.cleanup",
      interval: HOUR_MS,
      run: cleanup,
      scope: "global",
    })
  }

  export async function cleanup() {
    // altimate_change start — upstream_fix: age files by mtime, not decoded ID
    // timestamps. Identifier packs `timestamp * 4096` into 48 bits, wrapping
    // every 2^36 ms (~795 days; the 26th wrap: 2026-08-14T11:19:55Z), after
    // which every new ID decoded as "ancient" and cleanup deleted files the
    // moment they were written. File mtime has no wrap. Stat failures keep
    // the file — deletion must fail safe.
    const cutoffMs = Date.now() - RETENTION_MS
    const entries = await Glob.scan("tool_*", { cwd: DIR, include: "file" }).catch(() => [] as string[])
    for (const entry of entries) {
      const file = path.join(DIR, entry)
      const mtimeMs = await fs
        .stat(file)
        .then((st) => st.mtimeMs)
        .catch(() => Number.POSITIVE_INFINITY)
      if (mtimeMs >= cutoffMs) continue
      await fs.unlink(file).catch(() => {})
    }
    // altimate_change end
  }

  function hasTaskTool(agent?: Agent.Info): boolean {
    if (!agent?.permission) return false
    const rule = PermissionNext.evaluate("task", "*", agent.permission)
    return rule.action !== "deny"
  }

  // altimate_change start — default direction "middle" (head+tail,
  // tail-weighted elision) via the shared truncate-core.ts algorithm.
  export async function output(text: string, options: Options = {}, agent?: Agent.Info): Promise<Result> {
    const maxLines = options.maxLines ?? MAX_LINES
    const maxBytes = options.maxBytes ?? MAX_BYTES
    const direction = options.direction ?? TruncateCore.DEFAULT_DIRECTION
    const headRatio = options.headRatio ?? TruncateCore.DEFAULT_HEAD_RATIO
    const lines = text.split("\n")
    const totalBytes = Buffer.byteLength(text, "utf-8")

    if (TruncateCore.fits(lines, totalBytes, maxLines, maxBytes)) {
      return { content: text, truncated: false }
    }

    const preview = TruncateCore.preview(lines, totalBytes, { maxLines, maxBytes, direction, headRatio })

    const id = ToolID.ascending()
    const filepath = path.join(DIR, id)
    await Filesystem.write(filepath, text)

    const hint = hasTaskTool(agent)
      ? `The tool call succeeded but the output was truncated. Full output saved to: ${filepath}\nUse the Task tool to have explore agent process this file with Grep and Read (with offset/limit). Do NOT read the full file yourself - delegate to save context.`
      : `The tool call succeeded but the output was truncated. Full output saved to: ${filepath}\nUse Grep to search the full content or Read with offset/limit to view specific sections.`

    return { content: TruncateCore.assemble(preview, hint, direction), truncated: true, outputPath: filepath }
  }
  // altimate_change end
}
