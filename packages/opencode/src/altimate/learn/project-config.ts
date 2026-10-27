// altimate_change - new file
//
// The project config writer behind the TUI's `/rules` learning toggle; `directory` is where config discovery starts (the session's
// or the command's working directory), `root` the project root it stops at.
import fs from "node:fs/promises"
import path from "node:path"
import { constants } from "node:fs"
import { randomUUID } from "node:crypto"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import * as SafeFS from "./safe-fs"

/**
 * The highest-precedence existing project config file, from `directory` up to `root`, and its text; the default
 * `.altimate-code/altimate-code.json` (empty) when there is none. Config merges in the opposite order, so editing
 * this file means a second supported config cannot silently override the change.
 */
async function projectConfigFile(root: string, directory: string): Promise<{ file: string; text: string }> {
  // altimate_change start — match discovered project config precedence from the current directory
  const { Filesystem } = await import("@/util/filesystem")
  const names = ["opencode.jsonc", "opencode.json", "altimate-code.jsonc", "altimate-code.json"]
  const directories: string[] = []
  for await (const dir of Filesystem.up({ targets: [".altimate-code", ".opencode"], start: directory, stop: root }))
    directories.push(dir)
  const candidates = directories.reverse().flatMap((dir) => names.map((name) => path.join(dir, name)))
  for await (const file of Filesystem.up({ targets: ["opencode.jsonc", "opencode.json"], start: directory, stop: root }))
    candidates.push(file)
  // altimate_change end
  let file = path.join(root, ".altimate-code", "altimate-code.json")
  let text = "{}\n"
  for (const candidate of candidates) {
    // altimate_change start — reject linked project config files and their ancestors before reading
    await SafeFS.assertSafePath(root, candidate, root)
    // altimate_change end
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
 * `learn` as the project config file sets it: read from disk, so a change written by `/learn` shows at once
 * rather than when the session's config is next loaded. Undefined when the file has no `learn` object.
 */
export async function readProjectLearning(root: string, directory: string): Promise<Record<string, unknown> | undefined> {
  const { text } = await projectConfigFile(root, directory)
  const learn = parse(text, [], { allowTrailingComma: true })?.learn
  return learn && typeof learn === "object" && !Array.isArray(learn) ? learn : undefined
}

/**
 * Set `learn.capture` (learning from this person's sessions) in the project config: what `/rules` → "Turn
 * learning on/off for me" writes. Match the project locations loaded by Config, never the user's global one.
 */
export async function writeProjectLearning(root: string, directory: string, capture: boolean): Promise<string> {
  const found = await projectConfigFile(root, directory)
  const file = found.file
  let text = found.text
  const errors: ParseError[] = []
  const config = parse(text, errors, { allowTrailingComma: true })
  if (errors.length || !config || typeof config !== "object" || Array.isArray(config))
    throw new Error(`Cannot update ${file}: expected a JSON configuration object.`)
  const indent = /^([ \t]+)"/m.exec(text)?.[1]
  const formattingOptions = {
    insertSpaces: !indent?.includes("\t"),
    tabSize: indent?.length ?? 2,
    eol: text.includes("\r\n") ? "\r\n" : "\n",
  }
  // Like the MCP config writer, patch JSONC without expanding variables or rewriting other keys.
  text = applyEdits(text, modify(text, ["learn", "capture"], capture, { formattingOptions }))
  // altimate_change start — preserve regular config permissions without following linked targets or ancestors
  await SafeFS.mkdir(root, path.dirname(file), root)
  await SafeFS.assertSafePath(root, file, root)
  const mode = await fs.lstat(file).then((stat) => stat.mode & 0o777).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return 0o600
    throw error
  })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await SafeFS.open(root, temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode, root)
    try {
      await handle.writeFile(text)
      await handle.chmod(mode)
    } finally {
      await handle.close()
    }
    await SafeFS.rename(root, temporary, file, root)
  } finally {
    await SafeFS.remove(root, temporary, root)
  }
  // altimate_change end
  return file
}
