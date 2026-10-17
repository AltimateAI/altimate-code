import { readFile } from "node:fs/promises"
import path from "node:path"
import { parse } from "jsonc-parser"
import { Global } from "@/global"
import { MAX_LINES, MAX_BYTES } from "@/tool/truncate-core"

// Read only output settings: loading the full agent config can install dependencies
// or fetch remote configuration, neither of which belongs in this standalone server.
export async function outputLimits() {
  const limits = { maxLines: MAX_LINES, maxBytes: MAX_BYTES }
  const apply = (text: string) => {
    const output = parse(text)?.tool_output
    if (Number.isInteger(output?.max_lines) && output.max_lines > 0) limits.maxLines = output.max_lines
    if (Number.isInteger(output?.max_bytes) && output.max_bytes > 0) limits.maxBytes = output.max_bytes
  }
  const load = async (file: string) => {
    const text = await readFile(file, "utf8").catch((error) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (text) apply(text)
  }
  for (const name of ["config.json", "opencode.json", "opencode.jsonc", "altimate-code.json", "altimate-code.jsonc"]) {
    await load(path.join(Global.Path.config, name))
  }
  if (process.env.OPENCODE_CONFIG) await load(process.env.OPENCODE_CONFIG)
  if (process.env.OPENCODE_DISABLE_PROJECT_CONFIG !== "1" && process.env.OPENCODE_DISABLE_PROJECT_CONFIG !== "true") {
    const ancestors = []
    for (let directory = process.cwd(); ; directory = path.dirname(directory)) {
      ancestors.unshift(directory)
      if (directory === path.dirname(directory)) break
    }
    for (const directory of ancestors) {
      for (const base of [directory, path.join(directory, ".opencode"), path.join(directory, ".altimate-code")]) {
        for (const name of ["opencode.jsonc", "opencode.json", "altimate-code.jsonc", "altimate-code.json"]) {
          await load(path.join(base, name))
        }
      }
    }
  }
  if (process.env.OPENCODE_CONFIG_DIR) {
    for (const name of ["opencode.jsonc", "opencode.json", "altimate-code.jsonc", "altimate-code.json"]) {
      await load(path.join(process.env.OPENCODE_CONFIG_DIR, name))
    }
  }
  if (process.env.OPENCODE_CONFIG_CONTENT) apply(process.env.OPENCODE_CONFIG_CONTENT)
  return limits
}
