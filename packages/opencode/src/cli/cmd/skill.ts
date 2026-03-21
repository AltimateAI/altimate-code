// altimate_change start — top-level `skill` command for managing skills and user tools
import { EOL } from "os"
import path from "path"
import fs from "fs/promises"
import { Skill } from "../../skill"
import { bootstrap } from "../bootstrap"
import { cmd } from "./cmd"
import { Instance } from "../../project/instance"
import { Global } from "@/global"
import { detectToolReferences, skillSource, isToolOnPath } from "./skill-helpers"

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function skillTemplate(name: string, opts: { withTool: boolean }): string {
  const cliSection = opts.withTool
    ? `
## CLI Reference
\`\`\`bash
${name} --help
${name} <subcommand> [options]
\`\`\`

## Workflow
1. Understand what the user needs
2. Run the appropriate CLI command
3. Interpret the output and act on it`
    : `
## Workflow
1. Understand what the user needs
2. Provide guidance based on the instructions below`

  return `---
name: ${name}
description: TODO — describe what this skill does
---

# ${name}

## When to Use
TODO — describe when the agent should invoke this skill.
${cliSection}
`
}

function bashToolTemplate(name: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail
# ${name} — TODO describe what this tool does
# Usage: ${name} <command> [args]

show_help() {
  cat <<EOF
Usage: ${name} <command> [options]

Commands:
  help    Show this help message

Options:
  -h, --help    Show help

Examples:
  ${name} help
EOF
}

case "\${1:-help}" in
  help|--help|-h)
    show_help
    ;;
  *)
    echo "Error: Unknown command '\${1}'" >&2
    echo "Run '${name} help' for usage information." >&2
    exit 1
    ;;
esac
`
}

function pythonToolTemplate(name: string): string {
  return `#!/usr/bin/env python3
"""${name} — TODO describe what this tool does."""
import argparse
import json
import sys


def main():
    parser = argparse.ArgumentParser(
        prog="${name}",
        description="TODO — describe what this tool does",
    )
    subparsers = parser.add_subparsers(dest="command", help="Available commands")

    # Example subcommand
    subparsers.add_parser("help", help="Show help information")

    args = parser.parse_args()

    if not args.command or args.command == "help":
        parser.print_help()
        sys.exit(0)

    # TODO: implement commands
    print(json.dumps({"status": "ok", "command": args.command}))


if __name__ == "__main__":
    main()
`
}

function nodeToolTemplate(name: string): string {
  return `#!/usr/bin/env node
// ${name} — TODO describe what this tool does
// Usage: ${name} <command> [args]

const args = process.argv.slice(2)
const command = args[0] || "help"

function showHelp() {
  console.log(\`Usage: ${name} <command> [options]

Commands:
  help    Show this help message

Examples:
  ${name} help\`)
}

switch (command) {
  case "help":
  case "--help":
  case "-h":
    showHelp()
    break
  default:
    console.error(\`Error: Unknown command '\${command}'\`)
    console.error(\`Run '${name} help' for usage information.\`)
    process.exit(1)
}
`
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

const SkillListCommand = cmd({
  command: "list",
  describe: "list all available skills with their paired tools",
  builder: (yargs) =>
    yargs.option("json", {
      type: "boolean",
      describe: "output as JSON",
      default: false,
    }),
  async handler(args) {
    await bootstrap(process.cwd(), async () => {
      const skills = await Skill.all()
      const cwd = Instance.directory

      // Sort alphabetically for consistent output
      skills.sort((a, b) => a.name.localeCompare(b.name))

      if (args.json) {
        const enriched = await Promise.all(
          skills.map(async (skill) => {
            const tools = detectToolReferences(skill.content)
            const toolStatus = await Promise.all(
              tools.map(async (t) => ({ name: t, available: await isToolOnPath(t, cwd) })),
            )
            return {
              name: skill.name,
              description: skill.description,
              source: skillSource(skill.location),
              location: skill.location,
              tools: toolStatus,
            }
          }),
        )
        process.stdout.write(JSON.stringify(enriched, null, 2) + EOL)
        return
      }

      // Human-readable table output
      if (skills.length === 0) {
        process.stdout.write("No skills found." + EOL)
        process.stdout.write(EOL + `Create one with: altimate-code skill create <name>` + EOL)
        return
      }

      // Calculate column widths
      const nameWidth = Math.max(6, ...skills.map((s) => s.name.length))
      const toolsWidth = 20

      const header = `${"SKILL".padEnd(nameWidth)}  ${"TOOLS".padEnd(toolsWidth)}  DESCRIPTION`
      const separator = "─".repeat(header.length)

      process.stdout.write(EOL)
      process.stdout.write(header + EOL)
      process.stdout.write(separator + EOL)

      for (const skill of skills) {
        const tools = detectToolReferences(skill.content)
        const rawToolStr = tools.length > 0 ? tools.join(", ") : "—"
        const toolStr = rawToolStr.length > toolsWidth ? rawToolStr.slice(0, toolsWidth - 3) + "..." : rawToolStr
        // Truncate on word boundary
        let desc = skill.description
        if (desc.length > 60) {
          desc = desc.slice(0, 60)
          const lastSpace = desc.lastIndexOf(" ")
          if (lastSpace > 40) desc = desc.slice(0, lastSpace)
          desc += "..."
        }

        process.stdout.write(
          `${skill.name.padEnd(nameWidth)}  ${toolStr.padEnd(toolsWidth)}  ${desc}` + EOL,
        )
      }

      process.stdout.write(EOL)
      process.stdout.write(`${skills.length} skill(s) found.` + EOL)
      process.stdout.write(`Create a new skill: altimate-code skill create <name>` + EOL)
    })
  },
})

const SkillCreateCommand = cmd({
  command: "create <name>",
  describe: "scaffold a new skill with a paired CLI tool",
  builder: (yargs) =>
    yargs
      .positional("name", {
        type: "string",
        describe: "name of the skill to create",
        demandOption: true,
      })
      .option("language", {
        alias: "l",
        type: "string",
        describe: "language for the CLI tool stub",
        choices: ["bash", "python", "node"],
        default: "bash",
      })
      .option("skill-only", {
        alias: "s",
        type: "boolean",
        describe: "create only the skill without a CLI tool",
        default: false,
      }),
  async handler(args) {
    const name = args.name as string
    const language = args.language as string
    const noTool = args["skill-only"] as boolean

    // Validate name before bootstrap (fast fail)
    if (!/^[a-z][a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
      process.stderr.write(`Error: Skill name must be lowercase alphanumeric with hyphens, at least 2 chars (e.g., "my-tool")` + EOL)
      process.exit(1)
    }
    if (name.length > 64) {
      process.stderr.write(`Error: Skill name must be 64 characters or fewer` + EOL)
      process.exit(1)
    }

    await bootstrap(process.cwd(), async () => {
      // Use worktree (git root) so skills are always at the project root,
      // even when the command is run from a subdirectory.
      const rootDir = Instance.worktree !== "/" ? Instance.worktree : Instance.directory

      // Create skill directory and SKILL.md
      const skillDir = path.join(rootDir, ".opencode", "skills", name)
      const skillFile = path.join(skillDir, "SKILL.md")

      try {
        await fs.access(skillFile)
        process.stderr.write(`Error: Skill already exists at ${skillFile}` + EOL)
        process.exit(1)
      } catch {
        // File doesn't exist, good
      }

      await fs.mkdir(skillDir, { recursive: true })
      await fs.writeFile(skillFile, skillTemplate(name, { withTool: !noTool }), "utf-8")
      process.stdout.write(`✓ Created skill:  ${path.relative(rootDir, skillFile)}` + EOL)

      // Create CLI tool stub
      if (!noTool) {
        const toolsDir = path.join(rootDir, ".opencode", "tools")
        const toolFile = path.join(toolsDir, name)

        try {
          await fs.access(toolFile)
          process.stderr.write(`Warning: Tool already exists at ${toolFile}, skipping` + EOL)
        } catch {
          await fs.mkdir(toolsDir, { recursive: true })

          let template: string
          switch (language) {
            case "python":
              template = pythonToolTemplate(name)
              break
            case "node":
              template = nodeToolTemplate(name)
              break
            default:
              template = bashToolTemplate(name)
          }

          await fs.writeFile(toolFile, template, { mode: 0o755 })
          process.stdout.write(`✓ Created tool:   ${path.relative(rootDir, toolFile)}` + EOL)
        }
      }

      process.stdout.write(EOL)
      process.stdout.write(`Next steps:` + EOL)
      process.stdout.write(`  1. Edit .opencode/skills/${name}/SKILL.md — teach the agent when and how to use your tool` + EOL)
      if (!noTool) {
        process.stdout.write(`  2. Edit .opencode/tools/${name} — implement your tool's commands` + EOL)
        process.stdout.write(`  3. Test it: altimate-code skill test ${name}` + EOL)
      }
    })
  },
})

const SkillTestCommand = cmd({
  command: "test <name>",
  describe: "validate a skill and its paired CLI tool",
  builder: (yargs) =>
    yargs.positional("name", {
      type: "string",
      describe: "name of the skill to test",
      demandOption: true,
    }),
  async handler(args) {
    const name = args.name as string
    const cwd = process.cwd()
    let hasErrors = false

    const pass = (msg: string) => process.stdout.write(`  ✓ ${msg}` + EOL)
    const fail = (msg: string) => {
      process.stdout.write(`  ✗ ${msg}` + EOL)
      hasErrors = true
    }
    const warn = (msg: string) => process.stdout.write(`  ⚠ ${msg}` + EOL)

    process.stdout.write(EOL + `Testing skill: ${name}` + EOL + EOL)

    // 1. Check SKILL.md exists
    await bootstrap(cwd, async () => {
      const skill = await Skill.get(name)
      if (!skill) {
        fail(`Skill "${name}" not found. Check .opencode/skills/${name}/SKILL.md exists.`)
        process.exitCode = 1
        return
      }
      pass(`SKILL.md found at ${skill.location}`)

      // 2. Check frontmatter
      if (skill.name && skill.description) {
        pass(`Frontmatter valid (name: "${skill.name}", description present)`)
      } else {
        fail(`Frontmatter incomplete — name and description are required`)
      }

      if (skill.description.startsWith("TODO")) {
        warn(`Description starts with "TODO" — update it before sharing`)
      }

      // 3. Check content has substance
      const contentLines = skill.content.split("\n").filter((l) => l.trim()).length
      if (contentLines > 3) {
        pass(`Content has ${contentLines} non-empty lines`)
      } else {
        warn(`Content is minimal (${contentLines} lines) — consider adding more detail`)
      }

      // 4. Detect and check paired tools
      const projectDir = Instance.directory
      const tools = detectToolReferences(skill.content)
      if (tools.length === 0) {
        warn(`No CLI tool references detected in skill content`)
      } else {
        process.stdout.write(EOL + `  Paired tools:` + EOL)
        for (const tool of tools) {
          const available = await isToolOnPath(tool, projectDir)
          if (available) {
            pass(`"${tool}" found on PATH`)

            // Try running --help (with 5s timeout to prevent hangs)
            try {
              const worktreeDir = Instance.worktree !== "/" ? Instance.worktree : projectDir
              const toolEnv = {
                ...process.env,
                PATH: [
                  process.env.ALTIMATE_BIN_DIR,
                  path.join(worktreeDir, ".opencode", "tools"),
                  path.join(projectDir, ".opencode", "tools"),
                  path.join(Global.Path.config, "tools"),
                  process.env.PATH,
                ]
                  .filter(Boolean)
                  .join(process.platform === "win32" ? ";" : ":"),
              }
              const proc = Bun.spawn([tool, "--help"], {
                cwd: projectDir,
                stdout: "pipe",
                stderr: "pipe",
                env: toolEnv,
              })
              const timeout = setTimeout(() => proc.kill(), 5000)
              const exitCode = await proc.exited
              clearTimeout(timeout)
              if (exitCode === 0) {
                pass(`"${tool} --help" exits cleanly`)
              } else if (exitCode === null || exitCode === 137 || exitCode === 143) {
                fail(`"${tool} --help" timed out after 5s`)
              } else {
                fail(`"${tool} --help" exited with code ${exitCode}`)
              }
            } catch {
              fail(`"${tool} --help" failed to execute`)
            }
          } else {
            fail(`"${tool}" not found on PATH`)
          }
        }
      }

      process.stdout.write(EOL)
      if (hasErrors) {
        process.stdout.write(`Result: FAIL — fix the issues above` + EOL)
        process.exitCode = 1
      } else {
        process.stdout.write(`Result: PASS — skill is ready to use!` + EOL)
      }
    })
  },
})

// ---------------------------------------------------------------------------
// Top-level skill command
// ---------------------------------------------------------------------------

export const SkillCommand = cmd({
  command: "skill",
  describe: "manage skills and user CLI tools",
  builder: (yargs) =>
    yargs
      .command(SkillListCommand)
      .command(SkillCreateCommand)
      .command(SkillTestCommand)
      .demandCommand(),
  async handler() {},
})
// altimate_change end
