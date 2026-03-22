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
// altimate_change start — telemetry for skill operations
import { Telemetry } from "@/altimate/telemetry"
// altimate_change end

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
    if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name) || name.length < 2) {
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

      // altimate_change start — telemetry
      try {
        Telemetry.track({
          type: "skill_created",
          timestamp: Date.now(),
          session_id: Telemetry.getContext().sessionId || "",
          skill_name: name,
          language,
          source: "cli",
        })
      } catch {}
      // altimate_change end

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

const SkillShowCommand = cmd({
  command: "show <name>",
  describe: "display the full content of a skill",
  builder: (yargs) =>
    yargs.positional("name", {
      type: "string",
      describe: "name of the skill to show",
      demandOption: true,
    }),
  async handler(args) {
    const name = args.name as string
    await bootstrap(process.cwd(), async () => {
      const skill = await Skill.get(name)
      if (!skill) {
        process.stderr.write(`Error: Skill "${name}" not found.` + EOL)
        process.exit(1)
      }

      const tools = detectToolReferences(skill.content)

      process.stdout.write(EOL)
      process.stdout.write(`  Name:        ${skill.name}` + EOL)
      process.stdout.write(`  Description: ${skill.description}` + EOL)
      process.stdout.write(`  Location:    ${skill.location}` + EOL)
      if (tools.length > 0) {
        process.stdout.write(`  Tools:       ${tools.join(", ")}` + EOL)
      }
      process.stdout.write(EOL + "─".repeat(60) + EOL + EOL)
      process.stdout.write(skill.content + EOL)
    })
  },
})

const SkillInstallCommand = cmd({
  command: "install <source>",
  describe: "install a skill from GitHub or a local path",
  builder: (yargs) =>
    yargs
      .positional("source", {
        type: "string",
        describe: "GitHub repo (owner/repo), URL, or local path",
        demandOption: true,
      })
      .option("global", {
        alias: "g",
        type: "boolean",
        describe: "install globally instead of per-project",
        default: false,
      }),
  async handler(args) {
    let source = (args.source as string).trim().replace(/\.git$/, "")
    const isGlobal = args.global as boolean

    if (!source) {
      process.stderr.write(`Error: Source is required. Use owner/repo, URL, or local path.` + EOL)
      process.exit(1)
    }

    await bootstrap(process.cwd(), async () => {
      const rootDir = Instance.worktree !== "/" ? Instance.worktree : Instance.directory
      const targetDir = isGlobal
        ? path.join(Global.Path.config, "skills")
        : path.join(rootDir, ".opencode", "skills")

      // Determine source type and fetch
      let skillDir: string

      // Normalize GitHub web URLs (e.g. /tree/main/path) to clonable repo URLs
      const ghWebMatch = source.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\/(?:tree|blob)\/.*)?$/)
      if (ghWebMatch) {
        source = `https://github.com/${ghWebMatch[1]}.git`
      }

      if (source.startsWith("http://") || source.startsWith("https://")) {
        // URL: clone the repo
        process.stdout.write(`Fetching from ${source}...` + EOL)
        const tmpDir = path.join(Global.Path.cache, "skill-install-" + Date.now())
        const proc = Bun.spawnSync(["git", "clone", "--depth", "1", source, tmpDir], {
          stdout: "pipe",
          stderr: "pipe",
        })
        if (proc.exitCode !== 0) {
          process.stderr.write(`Error: Failed to clone ${source}` + EOL)
          process.stderr.write(proc.stderr.toString() + EOL)
          process.exit(1)
        }
        skillDir = tmpDir
      } else if (source.match(/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+$/)) {
        // GitHub shorthand: owner/repo
        const url = `https://github.com/${source}.git`
        process.stdout.write(`Fetching from github.com/${source}...` + EOL)
        const tmpDir = path.join(Global.Path.cache, "skill-install-" + Date.now())
        const proc = Bun.spawnSync(["git", "clone", "--depth", "1", url, tmpDir], {
          stdout: "pipe",
          stderr: "pipe",
        })
        if (proc.exitCode !== 0) {
          process.stderr.write(`Error: Failed to clone ${url}` + EOL)
          process.stderr.write(proc.stderr.toString() + EOL)
          process.exit(1)
        }
        skillDir = tmpDir
      } else {
        // Local path
        const resolved = path.isAbsolute(source) ? source : path.resolve(source)
        try {
          await fs.access(resolved)
        } catch {
          process.stderr.write(`Error: Path not found: ${resolved}` + EOL)
          process.exit(1)
        }
        skillDir = resolved
      }

      // Find all SKILL.md files in the source
      const { Glob: BunGlob } = globalThis.Bun
      const glob = new BunGlob("**/SKILL.md")
      const matches: string[] = []
      for await (const match of glob.scan({ cwd: skillDir, absolute: true })) {
        // Skip .git directory
        if (!match.includes("/.git/")) matches.push(match)
      }

      if (matches.length === 0) {
        process.stderr.write(`Error: No SKILL.md files found in ${source}` + EOL)
        // Clean up tmp if cloned
        if (skillDir.startsWith(Global.Path.cache)) {
          await fs.rm(skillDir, { recursive: true, force: true })
        }
        process.exit(1)
      }

      let installed = 0
      const installedNames: string[] = []
      for (const skillFile of matches) {
        const skillParent = path.dirname(skillFile)
        const skillName = path.basename(skillParent)
        const dest = path.join(targetDir, skillName)

        // Check if already installed
        try {
          await fs.access(dest)
          process.stdout.write(`  ⚠ Skipping "${skillName}" — already exists` + EOL)
          continue
        } catch {
          // Not installed, proceed
        }

        // Copy the entire skill directory (SKILL.md + any supporting files)
        // Use lstat to skip symlinks (security: prevents file disclosure from malicious repos)
        await fs.mkdir(dest, { recursive: true })
        const files = await fs.readdir(skillParent)
        for (const file of files) {
          const src = path.join(skillParent, file)
          const dst = path.join(dest, file)
          const stat = await fs.lstat(src)
          if (stat.isSymbolicLink()) continue
          if (stat.isFile()) {
            await fs.copyFile(src, dst)
          } else if (stat.isDirectory()) {
            await fs.cp(src, dst, { recursive: true, dereference: false })
          }
        }
        process.stdout.write(`  ✓ Installed "${skillName}" → ${path.relative(rootDir, dest)}` + EOL)
        installedNames.push(skillName)
        installed++
      }

      // Clean up tmp if cloned
      if (skillDir.startsWith(Global.Path.cache)) {
        await fs.rm(skillDir, { recursive: true, force: true })
      }

      process.stdout.write(EOL)
      if (installed > 0) {
        process.stdout.write(`${installed} skill(s) installed${isGlobal ? " globally" : ""}.` + EOL)
        // altimate_change start — telemetry
        try {
          Telemetry.track({
            type: "skill_installed",
            timestamp: Date.now(),
            session_id: Telemetry.getContext().sessionId || "",
            install_source: source,
            skill_count: installed,
            skill_names: installedNames,
            source: "cli",
          })
        } catch {}
        // altimate_change end
      } else {
        process.stdout.write(`No new skills installed.` + EOL)
      }
    })
  },
})

const SkillRemoveCommand = cmd({
  command: "remove <name>",
  describe: "remove an installed skill and its paired CLI tool",
  builder: (yargs) =>
    yargs.positional("name", {
      type: "string",
      describe: "name of the skill to remove",
      demandOption: true,
    }),
  async handler(args) {
    const name = args.name as string
    await bootstrap(process.cwd(), async () => {
      const skill = await Skill.get(name)
      if (!skill) {
        process.stderr.write(`Error: Skill "${name}" not found.` + EOL)
        process.exit(1)
      }

      if (skill.location.startsWith("builtin:")) {
        process.stderr.write(`Error: Cannot remove built-in skill "${name}".` + EOL)
        process.exit(1)
      }

      // Check if skill is tracked by git (part of the repo, not user-installed)
      const skillDir = path.dirname(skill.location)
      const gitCheck = Bun.spawnSync(["git", "ls-files", "--error-unmatch", skill.location], {
        cwd: path.dirname(skillDir),
        stdout: "pipe",
        stderr: "pipe",
      })
      if (gitCheck.exitCode === 0) {
        process.stderr.write(`Error: Cannot remove "${name}" — it is tracked by git.` + EOL)
        process.stderr.write(`This skill is part of the repository, not user-installed.` + EOL)
        process.exit(1)
      }

      // Remove skill directory
      await fs.rm(skillDir, { recursive: true, force: true })
      process.stdout.write(`  ✓ Removed skill: ${skillDir}` + EOL)

      // Remove paired CLI tool if it exists
      const rootDir = Instance.worktree !== "/" ? Instance.worktree : Instance.directory
      const toolFile = path.join(rootDir, ".opencode", "tools", name)
      try {
        await fs.access(toolFile)
        await fs.rm(toolFile, { force: true })
        process.stdout.write(`  ✓ Removed tool:  ${toolFile}` + EOL)
      } catch {
        // No paired tool, that's fine
      }

      // altimate_change start — telemetry
      try {
        Telemetry.track({
          type: "skill_removed",
          timestamp: Date.now(),
          session_id: Telemetry.getContext().sessionId || "",
          skill_name: name,
          source: "cli",
        })
      } catch {}
      // altimate_change end

      process.stdout.write(EOL + `Skill "${name}" removed.` + EOL)
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
      .command(SkillShowCommand)
      .command(SkillInstallCommand)
      .command(SkillRemoveCommand)
      .demandCommand(),
  async handler() {},
})
// altimate_change end
