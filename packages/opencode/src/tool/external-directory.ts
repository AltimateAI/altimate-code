import path from "path"
// altimate_change start — resolve symlinked external_directory targets
import { realpathSync } from "fs"
// altimate_change end
import { Effect } from "effect"
import { InstanceState } from "@/effect/instance-state"
import type * as Tool from "./tool"
import { containsPath } from "../project/instance-context"
import { FSUtil } from "@opencode-ai/core/fs-util"
// altimate_change start — sensitive-write guard (restore #209; see assertSensitiveWriteEffect)
import { Protected } from "../file/protected"
// altimate_change end
// altimate_change start — Promise-based variant for legacy zod tools
import { Instance } from "../project/instance"
import type { LegacyContext } from "../altimate/tool-zod-compat"
// altimate_change end

type Kind = "file" | "directory"

type Options = {
  bypass?: boolean
  kind?: Kind
}

// altimate_change start — symlink-resolved directory of an external_directory target
function directoryGlob(dir: string) {
  return process.platform === "win32"
    ? FSUtil.normalizePathPattern(path.join(dir, "*"))
    : path.join(dir, "*").replaceAll("\\", "/")
}

function resolvedDirectory(full: string, kind: Kind) {
  try {
    const real = realpathSync(full)
    return kind === "directory" ? real : path.dirname(real)
  } catch {
    if (kind === "directory") return
    // A file that does not exist yet (a write target): resolve the directory it would land in.
    try {
      return realpathSync(path.dirname(full))
    } catch {
      return
    }
  }
}
// altimate_change end

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
  // altimate_change start — an allowed directory can hold a symlink to somewhere else, so also ask
  // for the directory the path really resolves to (unless that is inside the project)
  const glob = directoryGlob(dir)
  const real = resolvedDirectory(full, kind)
  const realGlob = real && directoryGlob(real)
  const patterns = realGlob && realGlob !== glob && !containsPath(real, ins) ? [glob, realGlob] : [glob]

  yield* ctx.ask({
    permission: "external_directory",
    patterns,
    always: patterns,
    // altimate_change end
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

// altimate_change start — upstream_fix: restore #209's sensitive-write guard, dropped by the v1.17.9
// merge (the wrapper + its call sites in write/edit/apply_patch were lost; Protected.isSensitiveWrite
// survived as dead code). Blocks modifying credential / VCS / security locations even INSIDE the
// project boundary (.git/, .ssh/, .aws/, .env*, private keys, ...). Crucially it uses a SEPARATE
// "sensitive_write" permission, so an agent with `edit: "allow"` cannot silently bypass it — without
// it, the permissive builder default can overwrite .env / .git/hooks/* / checked-in keys with no
// prompt (exfiltration/persistence vector). Effect port of main's assertSensitiveWrite; the underlying
// match logic is the surviving Protected.isSensitiveWrite.
export const assertSensitiveWriteEffect = Effect.fn("Tool.assertSensitiveWrite")(function* (
  ctx: Tool.Context,
  target?: string,
) {
  if (!target) return
  const ins = yield* InstanceState.context
  const relativePath = path.relative(ins.directory, target)
  const matched = Protected.isSensitiveWrite(relativePath)
  if (!matched) return
  yield* ctx.ask({
    permission: "sensitive_write",
    patterns: [relativePath],
    always: [relativePath],
    metadata: {
      filepath: target,
      sensitive: matched,
      reason: `This file is in a sensitive location (${matched}). Modifications could affect credentials, version control, or security configuration.`,
    },
  })
})

// Promise-based wrapper (legacy tools + tests). Uses the synchronous Instance.directory boundary
// (like the Legacy external-directory variant) rather than InstanceState.context.
export async function assertSensitiveWrite(ctx: Tool.Context, target?: string): Promise<void> {
  if (!target) return
  const relativePath = path.relative(Instance.directory, target)
  const matched = Protected.isSensitiveWrite(relativePath)
  if (!matched) return
  await Effect.runPromise(
    ctx.ask({
      permission: "sensitive_write",
      patterns: [relativePath],
      always: [relativePath],
      metadata: {
        filepath: target,
        sensitive: matched,
        reason: `This file is in a sensitive location (${matched}). Modifications could affect credentials, version control, or security configuration.`,
      },
    }),
  )
}
// altimate_change end

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
