import { Plugin } from "@opencode/plugin"
import { Env } from "@opencode/util/env"
import { Identity } from "@opencode/util/identity"
import { Schema } from "effect"
import { realpath } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

const Options = Schema.Struct({
  home: Schema.optional(Schema.String),
  configDirectory: Schema.optional(Schema.String),
  project: Schema.optional(Schema.Boolean),
  global: Schema.optional(Schema.Boolean),
  disableClaudeCodePrompt: Schema.optional(Schema.Boolean),
})

export type InstructionOptions = typeof Options.Type

// Explicit options bridge SDK hosts whose effective config directory/policy is
// not exposed by the public plugin context. Installed plugins can use options.instructions.
export function claudeInstructions(options: InstructionOptions = {}) {
  return Plugin.define({
    id: "altimate.claude-instructions",
    async setup(ctx) {
      const policy = { ...Schema.decodeUnknownSync(Options)(ctx.options.instructions ?? {}), ...options }
      const home = policy.home ?? Env.get("OPENCODE_TEST_HOME") ?? homedir()
      const configDirectory =
        policy.configDirectory ??
        Env.get("OPENCODE_CONFIG_DIR") ??
        path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), Identity.app)
      const project = policy.project ?? !enabled(Env.get("OPENCODE_DISABLE_PROJECT_CONFIG"))
      const global = policy.global !== false
      const disableClaudeCodePrompt =
        policy.disableClaudeCodePrompt ??
        (enabled(Env.get("OPENCODE_DISABLE_CLAUDE_CODE")) || enabled(Env.get("OPENCODE_DISABLE_CLAUDE_CODE_PROMPT")))
      const directories = project
        ? ancestors(await realpath(ctx.location.directory), await realpath(ctx.location.project.directory))
        : []

      await ctx.session.hook("context", async (event) => {
        // Global and project selection are independent in v1. A global AGENTS
        // does not suppress project CLAUDE, nor project AGENTS the global fallback.
        const globalFile =
          global && !disableClaudeCodePrompt && !(await Bun.file(path.join(configDirectory, "AGENTS.md")).exists())
            ? path.resolve(home, ".claude", "CLAUDE.md")
            : undefined
        // Try an entire filename walk before the next filename: root AGENTS
        // wins even when a nearer directory contains CLAUDE.
        const agents = await Promise.all(
          directories.map((directory) => Bun.file(path.join(directory, "AGENTS.md")).exists()),
        )
        const projectFiles = agents.some(Boolean)
          ? []
          : directories.map((directory) => path.join(directory, "CLAUDE.md"))
        const files = [...new Set([...(globalFile ? [globalFile] : []), ...projectFiles])]
        const content = await Promise.all(
          files.map((file) =>
            Bun.file(file)
              .text()
              .catch(() => ""),
          ),
        )
        files.forEach((file, index) => {
          const header = `Instructions from: ${file}\n`
          if (!content[index] || event.system.some((part) => part.text.includes(header))) return
          const part = { type: "text" as const, text: `${header}${content[index]}` }
          // Core AGENTS is already in event.system. Preserve v1's global-before-
          // project order even when the project instructions came from core.
          const before =
            file === globalFile ? event.system.findIndex((part) => part.text.includes("Instructions from: ")) : -1
          if (before >= 0) {
            event.system.splice(before, 0, part)
            return
          }
          event.system.push(part)
        })
      })
    },
  })
}

export const ClaudeInstructions = claudeInstructions()

function ancestors(start: string, root: string): string[] {
  const relative = path.relative(root, start)
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return []
  if (!relative) return [start]
  return [start, ...ancestors(path.dirname(start), root)]
}

function enabled(value: string | undefined) {
  return value !== undefined && ["true", "yes", "on", "1"].includes(value.toLowerCase())
}
