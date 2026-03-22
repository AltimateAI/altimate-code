// altimate_change start — shared helpers for skill CLI commands
import path from "path"
import fs from "fs/promises"
import { Global } from "@/global"
import { Instance } from "../../project/instance"

/** Shell builtins, common utilities, and agent tool names to filter when detecting CLI tool references. */
export const SHELL_BUILTINS = new Set([
  // Shell builtins
  "echo", "cd", "export", "set", "if", "then", "else", "fi", "for", "do", "done",
  "case", "esac", "printf", "source", "alias", "read", "local", "return", "exit",
  "break", "continue", "shift", "trap", "type", "command", "builtin", "eval", "exec",
  "test", "true", "false",
  // Common CLI utilities (not user tools)
  "cat", "grep", "awk", "sed", "rm", "cp", "mv", "mkdir", "ls", "chmod", "which",
  "curl", "wget", "pwd", "touch", "head", "tail", "sort", "uniq", "wc", "tee",
  "xargs", "find", "tar", "gzip", "unzip", "git", "npm", "yarn", "bun", "pip",
  "python", "python3", "node", "bash", "sh", "zsh", "docker", "make",
  // System utilities unlikely to be user tools
  "sudo", "kill", "ps", "env", "whoami", "id", "date", "sleep", "diff", "less", "more",
  // Agent tool names that appear in skill content but aren't CLI tools
  "glob", "write", "edit",
])

/** Detect CLI tool references inside a skill's content (bash code blocks mentioning executables). */
export function detectToolReferences(content: string): string[] {
  const tools = new Set<string>()

  // Match "Tools used: bash (runs `altimate-dbt` commands), ..."
  const toolsUsedMatch = content.match(/Tools used:\s*(.+)/i)
  if (toolsUsedMatch) {
    const refs = toolsUsedMatch[1].matchAll(/`([a-z][\w-]*)`/gi)
    for (const m of refs) {
      if (!SHELL_BUILTINS.has(m[1])) tools.add(m[1])
    }
  }

  // Match executable names in bash code blocks: lines starting with an executable name
  const bashBlocks = content.matchAll(/```(?:bash|sh)\r?\n([\s\S]*?)```/g)
  for (const block of bashBlocks) {
    const lines = block[1].split("\n")
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      // Extract the first word (the command)
      const cmdMatch = trimmed.match(/^(?:\$\s+)?([a-z][\w.-]*(?:-[\w]+)*)/i)
      if (cmdMatch) {
        const cmd = cmdMatch[1]
        if (!SHELL_BUILTINS.has(cmd)) {
          tools.add(cmd)
        }
      }
    }
  }

  return Array.from(tools)
}

/** Determine the source label for a skill based on its location. */
export function skillSource(location: string): string {
  if (location.startsWith("builtin:")) return "builtin"
  const home = Global.Path.home
  // Builtin skills shipped with altimate-code
  if (location.startsWith(path.join(home, ".altimate", "builtin"))) return "builtin"
  // Global user skills (~/.claude/skills/, ~/.agents/skills/, ~/.config/altimate-code/skills/)
  const globalDirs = [
    path.join(home, ".claude", "skills"),
    path.join(home, ".agents", "skills"),
    path.join(home, ".altimate-code", "skills"),
    path.join(Global.Path.config, "skills"),
  ]
  if (globalDirs.some((dir) => location.startsWith(dir))) return "global"
  // Everything else is project-level
  return "project"
}

/** Check if a tool is available on the current PATH (including .opencode/tools/). */
export async function isToolOnPath(toolName: string, cwd: string): Promise<boolean> {
  // Check .opencode/tools/ in both cwd and worktree (they may differ in monorepos)
  const dirsToCheck = new Set([
    path.join(cwd, ".opencode", "tools"),
    path.join(Instance.worktree !== "/" ? Instance.worktree : cwd, ".opencode", "tools"),
    path.join(Global.Path.config, "tools"),
  ])

  for (const dir of dirsToCheck) {
    try {
      await fs.access(path.join(dir, toolName), fs.constants.X_OK)
      return true
    } catch {}
  }

  // Check system PATH
  const sep = process.platform === "win32" ? ";" : ":"
  const binDir = process.env.ALTIMATE_BIN_DIR
  const pathDirs = (process.env.PATH ?? "").split(sep).filter(Boolean)
  if (binDir) pathDirs.unshift(binDir)

  for (const dir of pathDirs) {
    try {
      await fs.access(path.join(dir, toolName), fs.constants.X_OK)
      return true
    } catch {}
  }

  return false
}
// altimate_change end
