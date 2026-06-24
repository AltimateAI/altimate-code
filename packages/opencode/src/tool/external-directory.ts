import path from "path"
import { Effect } from "effect"
import { InstanceState } from "@/effect/instance-state"
import type * as Tool from "./tool"
import { containsPath } from "../project/instance-context"
import { FSUtil } from "@opencode-ai/core/fs-util"
// altimate_change start — Promise-based variant for legacy zod tools
import { Instance } from "../project/instance"
import type { LegacyContext } from "../altimate/tool-zod-compat"
// altimate_change end

type Kind = "file" | "directory"

type Options = {
  bypass?: boolean
  kind?: Kind
}

export const assertExternalDirectoryEffect = Effect.fn("Tool.assertExternalDirectory")(function* (
  ctx: Tool.Context,
  target?: string,
  options?: Options,
) {
  if (!target) return false

  if (options?.bypass) return false

  const ins = yield* InstanceState.context
  const full = process.platform === "win32" ? FSUtil.normalizePath(target) : target
  if (containsPath(full, ins)) return false

  const kind = options?.kind ?? "file"
  const dir = kind === "directory" ? full : path.dirname(full)
  const glob =
    process.platform === "win32"
      ? FSUtil.normalizePathPattern(path.join(dir, "*"))
      : path.join(dir, "*").replaceAll("\\", "/")

  yield* ctx.ask({
    permission: "external_directory",
    patterns: [glob],
    always: [glob],
    metadata: {
      filepath: full,
      parentDir: dir,
    },
  })
  return true
})

export async function assertExternalDirectory(ctx: Tool.Context, target?: string, options?: Options) {
  return Effect.runPromise(assertExternalDirectoryEffect(ctx, target, options))
}

// altimate_change start — Promise-based external-directory check for legacy zod
// tools (ls/glob). Their `ctx.ask` resolves a Promise (bridged from the Effect
// context by tool-zod-compat), so they can't drive the Effect helper above. This
// mirrors its logic using the synchronous `Instance.containsPath` boundary check.
export async function assertExternalDirectoryLegacy(
  ctx: LegacyContext,
  target?: string,
  options?: Options,
): Promise<boolean> {
  if (!target) return false
  if (options?.bypass) return false

  const full = process.platform === "win32" ? FSUtil.normalizePath(target) : target
  if (Instance.containsPath(full)) return false

  const kind = options?.kind ?? "file"
  const dir = kind === "directory" ? full : path.dirname(full)
  const glob =
    process.platform === "win32"
      ? FSUtil.normalizePathPattern(path.join(dir, "*"))
      : path.join(dir, "*").replaceAll("\\", "/")

  await ctx.ask({
    permission: "external_directory",
    patterns: [glob],
    always: [glob],
    metadata: {
      filepath: full,
      parentDir: dir,
    },
  })
  return true
}
// altimate_change end
