import path from "path"
import type { Tool } from "./tool"
import { Instance } from "../project/instance"
import { Protected } from "../file/protected"

type Kind = "file" | "directory"

type Options = {
  bypass?: boolean
  kind?: Kind
}

export async function assertExternalDirectory(ctx: Tool.Context, target?: string, options?: Options) {
  if (!target) return

  if (options?.bypass) return

  if (Instance.containsPath(target)) return

  const kind = options?.kind ?? "file"
  const parentDir = kind === "directory" ? target : path.dirname(target)
  const glob = path.join(parentDir, "*").replaceAll("\\", "/")

  await ctx.ask({
    permission: "external_directory",
    patterns: [glob],
    always: [glob],
    metadata: {
      filepath: target,
      parentDir,
    },
  })
}

/**
 * Checks if a write target is a sensitive file or directory (e.g., .git/, .ssh/,
 * .env, credentials). If so, prompts the user for explicit permission even if the
 * path is inside the project boundary.
 *
 * Uses a dedicated "sensitive_write" permission (not "edit") so that agents with
 * `edit: "allow"` don't silently bypass this check. The "sensitive_write" permission
 * defaults to "ask" when not explicitly configured.
 */
export async function assertSensitiveWrite(ctx: Tool.Context, target?: string) {
  if (!target) return

  const relativePath = path.relative(Instance.directory, target)
  const matched = Protected.isSensitiveWrite(relativePath)
  if (!matched) return

  await ctx.ask({
    permission: "sensitive_write",
    patterns: [relativePath],
    always: [relativePath],
    metadata: {
      filepath: target,
      sensitive: matched,
      reason: `This file is in a sensitive location (${matched}). Modifications could affect credentials, version control, or security configuration.`,
    },
  })
}
