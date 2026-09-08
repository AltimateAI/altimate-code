import path from "path"
import { modify, applyEdits, parse, parseTree, findNodeAtLocation, getNodeValue, type ParseError } from "jsonc-parser"
import { Filesystem } from "../util/filesystem"
import type { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"

// altimate_change start — primary config filename is altimate-code.json; the rest are
// fallbacks for users with pre-existing installs. The list mirrors every filename the
// config loader merges (config/config.ts loadFile calls: altimate-code.json/.jsonc,
// opencode.json/.jsonc, legacy config.json) — an entry in any of them is live config,
// so lookups/removals/heals must see them all. New writes land in altimate-code.json
// (first entry of the list).
const CONFIG_FILENAMES = ["altimate-code.json", "altimate-code.jsonc", "opencode.json", "opencode.jsonc"]
// The GLOBAL config dir additionally merges the legacy config.json
// (config/config.ts global load path). The project loader never reads
// config.json, so it must stay out of project-side candidates — otherwise an
// unrelated project file named config.json becomes a discovery hit and, worse,
// a write target for entries the loader would never load.
const GLOBAL_CONFIG_FILENAMES = [...CONFIG_FILENAMES, "config.json"]
// altimate_change end

export async function resolveConfigPath(baseDir: string, global = false) {
  const candidates: string[] = []

  if (!global) {
    // Check subdirectory configs first — that's where existing project configs typically live
    candidates.push(
      ...CONFIG_FILENAMES.map((f) => path.join(baseDir, ".altimate-code", f)),
      ...CONFIG_FILENAMES.map((f) => path.join(baseDir, ".opencode", f)),
    )
  }

  // Then check root-level configs (the global dir also accepts legacy config.json)
  candidates.push(...(global ? GLOBAL_CONFIG_FILENAMES : CONFIG_FILENAMES).map((f) => path.join(baseDir, f)))

  for (const candidate of candidates) {
    if (await Filesystem.exists(candidate)) {
      return candidate
    }
  }

  return candidates[0]
}

export async function addMcpToConfig(name: string, mcpConfig: ConfigMCPV1.Info, configPath: string) {
  let text = "{}"
  if (await Filesystem.exists(configPath)) {
    text = await Filesystem.readText(configPath)
  }

  // Guard: refuse to overwrite a config whose JSON/JSONC we cannot parse.
  // jsonc-parser's modify() (and parseTree()) are error-tolerant and would
  // best-effort clobber a recoverable file, so use parse() with an error sink —
  // comments and trailing commas are allowed (it is JSONC), but a genuinely
  // malformed/truncated file produces errors and we bail instead of overwriting.
  if (text.trim()) {
    const parseErrors: ParseError[] = []
    parse(text, parseErrors, { allowTrailingComma: true })
    if (parseErrors.length > 0) {
      throw new Error(`Refusing to write MCP config: ${configPath} is not valid JSON/JSONC`)
    }
  }

  const edits = modify(text, ["mcp", name], mcpConfig, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  })
  const result = applyEdits(text, edits)

  await Filesystem.write(configPath, result)

  return configPath
}

export async function removeMcpFromConfig(name: string, configPath: string): Promise<boolean> {
  if (!(await Filesystem.exists(configPath))) return false

  const text = await Filesystem.readText(configPath)
  const tree = parseTree(text)
  if (!tree) return false

  const node = findNodeAtLocation(tree, ["mcp", name])
  if (!node) return false

  const edits = modify(text, ["mcp", name], undefined, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  })
  const result = applyEdits(text, edits)
  await Filesystem.write(configPath, result)
  return true
}

export async function listMcpInConfig(configPath: string): Promise<string[]> {
  if (!(await Filesystem.exists(configPath))) return []

  const text = await Filesystem.readText(configPath)
  const tree = parseTree(text)
  if (!tree) return []

  const mcpNode = findNodeAtLocation(tree, ["mcp"])
  if (!mcpNode || mcpNode.type !== "object" || !mcpNode.children) return []

  return mcpNode.children
    .filter((child) => child.type === "property" && child.children?.[0])
    .map((child) => child.children![0].value as string)
}

/** Find all config files that exist (project + global) */
export async function findProjectConfigPaths(projectDir: string): Promise<string[]> {
  const paths: string[] = []
  for (const name of CONFIG_FILENAMES) {
    const p = path.join(projectDir, name)
    if (await Filesystem.exists(p)) paths.push(p)
  }
  // Also check .altimate-code and .opencode subdirectories
  for (const subdir of [".altimate-code", ".opencode"]) {
    for (const name of CONFIG_FILENAMES) {
      const p = path.join(projectDir, subdir, name)
      if (await Filesystem.exists(p)) paths.push(p)
    }
  }
  return paths
}

export async function findGlobalConfigPaths(globalDir: string): Promise<string[]> {
  const paths: string[] = []
  for (const name of GLOBAL_CONFIG_FILENAMES) {
    const p = path.join(globalDir, name)
    if (await Filesystem.exists(p)) paths.push(p)
  }
  return paths
}

export async function findAllConfigPaths(projectDir: string, globalDir: string): Promise<string[]> {
  return [...(await findProjectConfigPaths(projectDir)), ...(await findGlobalConfigPaths(globalDir))]
}

/**
 * Read a single MCP entry directly from a config file, bypassing the Config
 * singleton so callers can get the freshly-written config without busting the
 * whole cache. Returns undefined if the entry is not found in the file.
 */
export async function readMcpEntryFromDisk(
  name: string,
  configPath: string,
): Promise<ConfigMCPV1.Info | undefined> {
  if (!(await Filesystem.exists(configPath))) return undefined

  const text = await Filesystem.readText(configPath)
  const tree = parseTree(text)
  if (!tree) return undefined

  const node = findNodeAtLocation(tree, ["mcp", name])
  if (!node || node.type !== "object") return undefined

  // getNodeValue reconstructs the full value tree. A manual children walk reading
  // `prop.children[1].value` would silently drop array/object fields (command,
  // environment, headers, oauth) — jsonc-parser only populates `Node.value` for
  // primitives — corrupting the entry on the next disk write.
  return getNodeValue(node) as ConfigMCPV1.Info
}
