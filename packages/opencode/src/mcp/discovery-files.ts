import { realpath } from "fs/promises"
import path from "path"
import { Glob } from "@opencode-ai/core/util/glob"

export interface ProjectMcpFile {
  /** Canonical path used for reading, after resolving any symlink. */
  path: string
  /** Authored path relative to the project, retained for labels and precedence. */
  relative: string
}

function relativeProjectPath(root: string, file: string): string | undefined {
  const relative = path.relative(root, file)
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return undefined
  }
  return relative.split(path.sep).join("/")
}

function isIgnored(relative: string): boolean {
  return Glob.DEFAULT_IGNORE.some((pattern) => Glob.match(pattern, relative))
}

/**
 * Resolve a project discovery file without allowing a symlink alias to escape
 * the project or disguise a dependency/build artifact as authored config.
 */
export async function resolveProjectDiscoveryFile(
  projectDir: string,
  candidate: string,
): Promise<ProjectMcpFile | undefined> {
  try {
    const lexicalRoot = path.resolve(projectDir)
    const lexicalPath = path.resolve(candidate)
    const lexicalRelative = relativeProjectPath(lexicalRoot, lexicalPath)
    if (!lexicalRelative || isIgnored(lexicalRelative)) return undefined

    const [canonicalRoot, canonicalPath] = await Promise.all([realpath(lexicalRoot), realpath(lexicalPath)])
    const canonicalRelative = relativeProjectPath(canonicalRoot, canonicalPath)
    if (!canonicalRelative || isIgnored(canonicalRelative)) return undefined

    return { path: canonicalPath, relative: lexicalRelative }
  } catch {
    return undefined
  }
}

/**
 * Find authored mcp.json files while pruning dependency/build trees and then
 * checking the canonical target of every match. The canonical check is the
 * security boundary: glob ignores operate on aliases and cannot by themselves
 * detect `.vscode/mcp.json -> node_modules/pkg/mcp.json`.
 */
export async function scanProjectMcpJsonFiles(projectDir: string): Promise<ProjectMcpFile[]> {
  const paths = await Glob.scan("**/mcp.json", {
    cwd: projectDir,
    absolute: true,
    dot: true,
    ignore: [...Glob.DEFAULT_IGNORE],
  })

  const files = await Promise.all(paths.map((candidate) => resolveProjectDiscoveryFile(projectDir, candidate)))
  return files
    .filter((file): file is ProjectMcpFile => file !== undefined)
    .sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0))
}

export * as DiscoveryFiles from "./discovery-files"
