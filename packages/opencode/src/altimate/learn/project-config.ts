// altimate_change - new file
//
// Project config discovery for `learn enable/disable` (the writer, in `cli/cmd/learn.ts`) and the rules service (the
// reader); `directory` is where discovery starts (the session's or the command's working directory), `root` the
// project root it stops at.
import fs from "node:fs/promises"
import path from "node:path"
import { parse } from "jsonc-parser"
import * as SafeFS from "./safe-fs"

/**
 * The highest-precedence existing project config file, from `directory` up to `root`, and its text; the default
 * `.altimate-code/altimate-code.json` (empty) when there is none. Config merges in the opposite order, so editing
 * this file means a second supported config cannot silently override the change.
 */
export async function projectConfigFile(root: string, directory: string): Promise<{ file: string; text: string }> {
  const { Filesystem } = await import("@/util/filesystem")
  const names = ["opencode.jsonc", "opencode.json", "altimate-code.jsonc", "altimate-code.json"]
  const directories: string[] = []
  for await (const dir of Filesystem.up({ targets: [".altimate-code", ".opencode"], start: directory, stop: root }))
    directories.push(dir)
  const candidates = directories.reverse().flatMap((dir) => names.map((name) => path.join(dir, name)))
  for await (const file of Filesystem.up({ targets: ["opencode.jsonc", "opencode.json"], start: directory, stop: root }))
    candidates.push(file)
  let file = path.join(root, ".altimate-code", "altimate-code.json")
  let text = "{}\n"
  for (const candidate of candidates) {
    // Reject linked project config files and their ancestors before reading.
    await SafeFS.assertSafePath(root, candidate, root)
    const current = await fs.readFile(candidate, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (current === undefined) continue
    file = candidate
    text = current
    break
  }
  return { file, text }
}

/**
 * `learn` as the project config file sets it: read from disk, so a change shows at once
 * rather than when the session's config is next loaded (`learn enable` / `learn disable` write it). Undefined when the file has no `learn` object.
 */
export async function readProjectLearning(root: string, directory: string): Promise<Record<string, unknown> | undefined> {
  const { text } = await projectConfigFile(root, directory)
  const learn = parse(text, [], { allowTrailingComma: true })?.learn
  return learn && typeof learn === "object" && !Array.isArray(learn) ? learn : undefined
}
