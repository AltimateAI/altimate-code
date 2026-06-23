import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { promises as fs } from "node:fs"
import path from "node:path"
import type { ChangedFile } from "./diff-filter"

/**
 * Git helpers for the review pipeline. Produces the ChangedFile[] for a PR
 * (base..head) and a content resolver for old/new file versions, used by both
 * the dbt_pr_review tool and the `altimate review` CLI command.
 */

const exec = promisify(execFile)

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

function parseStatus(code: string): ChangedFile["status"] {
  if (code.startsWith("A")) return "added"
  if (code.startsWith("D")) return "deleted"
  if (code.startsWith("R")) return "renamed"
  return "modified"
}

export interface CollectOptions {
  base: string
  /** Omit to diff against the working tree. */
  head?: string
  cwd: string
}

/** Collect changed files between base and head (or working tree). */
export async function collectChangedFiles(opts: CollectOptions): Promise<ChangedFile[]> {
  const range = opts.head ? [`${opts.base}...${opts.head}`] : [opts.base]
  const nameStatus = await git(["diff", "--name-status", "-M", ...range], opts.cwd)

  // Parse the name-status lines first, then fetch per-file hunk diffs
  // concurrently — a large PR must not spawn N serial git processes.
  const entries: Array<{ status: ChangedFile["status"]; newPath: string; oldPath?: string }> = []
  for (const line of nameStatus.split("\n")) {
    if (!line.trim()) continue
    const parts = line.split("\t")
    const status = parseStatus(parts[0])
    const oldPath = status === "renamed" ? parts[1] : undefined
    const newPath = status === "renamed" ? parts[2] : parts[1]
    if (!newPath) continue
    entries.push({ status, newPath, oldPath })
  }

  return Promise.all(
    entries.map(async ({ status, newPath, oldPath }) => {
      let diff = ""
      try {
        diff = await git(["diff", "-M", ...range, "--", newPath], opts.cwd)
      } catch {
        diff = ""
      }
      return { path: newPath, status, diff, oldPath } satisfies ChangedFile
    }),
  )
}

/** Build a getContent(path, side) resolver over git refs / the working tree.
 *  `renames` maps a new path → its old path so the "old" side of a renamed file
 *  resolves from where it actually lived at `base` (not the post-rename path). */
export function makeContentResolver(opts: CollectOptions & { renames?: Map<string, string> }) {
  return async (file: string, side: "old" | "new"): Promise<string | undefined> => {
    try {
      if (side === "old") {
        const oldFile = opts.renames?.get(file) ?? file
        return await git(["show", `${opts.base}:${oldFile}`], opts.cwd)
      }
      if (opts.head) {
        return await git(["show", `${opts.head}:${file}`], opts.cwd)
      }
      return await fs.readFile(path.join(opts.cwd, file), "utf8")
    } catch {
      return undefined
    }
  }
}

/** Resolve a sensible default base ref (merge-base with origin/main/master). */
export async function defaultBaseRef(cwd: string): Promise<string> {
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    try {
      const mb = (await git(["merge-base", "HEAD", candidate], cwd)).trim()
      if (mb) return mb
    } catch {
      // try next
    }
  }
  // Fall back to the previous commit.
  return "HEAD~1"
}

/** Compute a short hash of the manifest file for the verdict envelope. */
export async function manifestHash(manifestPath: string, cwd: string): Promise<string | undefined> {
  try {
    const { createHash } = await import("node:crypto")
    const buf = await fs.readFile(path.isAbsolute(manifestPath) ? manifestPath : path.join(cwd, manifestPath))
    return createHash("sha256").update(buf).digest("hex").slice(0, 16)
  } catch {
    return undefined
  }
}
