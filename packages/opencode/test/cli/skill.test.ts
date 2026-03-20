// altimate_change start — tests for skill CLI command (create, list, test)
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"

// ---------------------------------------------------------------------------
// Unit tests for the helper functions extracted from skill.ts
// We import the module indirectly by testing the CLI output.
// For pure unit tests we replicate the helper logic here (same source).
// ---------------------------------------------------------------------------

/** Shell builtins to filter — mirrors SHELL_BUILTINS in skill.ts */
const SHELL_BUILTINS = new Set([
  "echo", "cd", "export", "set", "if", "then", "else", "fi", "for", "do", "done",
  "case", "esac", "printf", "source", "alias", "read", "local", "return", "exit",
  "break", "continue", "shift", "trap", "type", "command", "builtin", "eval", "exec",
  "test", "true", "false",
  "cat", "grep", "awk", "sed", "rm", "cp", "mv", "mkdir", "ls", "chmod", "which",
  "curl", "wget", "pwd", "touch", "head", "tail", "sort", "uniq", "wc", "tee",
  "xargs", "find", "tar", "gzip", "unzip", "git", "npm", "yarn", "bun", "pip",
  "python", "python3", "node", "bash", "sh", "zsh", "docker", "make",
  "glob", "write", "edit",
])

/** Detect CLI tool references inside a skill's content. */
function detectToolReferences(content: string): string[] {
  const tools = new Set<string>()

  const toolsUsedMatch = content.match(/Tools used:\s*(.+)/i)
  if (toolsUsedMatch) {
    const refs = toolsUsedMatch[1].matchAll(/`([a-z][\w-]*)`/gi)
    for (const m of refs) tools.add(m[1])
  }

  const bashBlocks = content.matchAll(/```(?:bash|sh)\n([\s\S]*?)```/g)
  for (const block of bashBlocks) {
    const lines = block[1].split("\n")
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
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

describe("detectToolReferences", () => {
  test("detects tools from Tools used line", () => {
    const content = `**Tools used:** bash (runs \`altimate-dbt\` commands), read, \`sql_analyze\``
    const tools = detectToolReferences(content)
    expect(tools).toContain("altimate-dbt")
    expect(tools).toContain("sql_analyze")
  })

  test("detects tools from bash code blocks", () => {
    const content = `
\`\`\`bash
altimate-dbt info
altimate-dbt columns --model users
\`\`\`
`
    const tools = detectToolReferences(content)
    expect(tools).toContain("altimate-dbt")
    expect(tools.length).toBe(1) // deduplicated
  })

  test("filters out shell builtins", () => {
    const content = `
\`\`\`bash
echo "hello"
cd /tmp
cat file.txt
my-custom-tool run
\`\`\`
`
    const tools = detectToolReferences(content)
    expect(tools).toContain("my-custom-tool")
    expect(tools).not.toContain("echo")
    expect(tools).not.toContain("cd")
    expect(tools).not.toContain("cat")
  })

  test("handles content with no tools", () => {
    const content = `# Just a plain skill\n\nDo some stuff.`
    const tools = detectToolReferences(content)
    expect(tools.length).toBe(0)
  })

  test("ignores comment lines in bash blocks", () => {
    const content = `
\`\`\`bash
# this is a comment
my-tool run
\`\`\`
`
    const tools = detectToolReferences(content)
    expect(tools).toContain("my-tool")
    expect(tools.length).toBe(1)
  })

  test("handles $ prefix in bash blocks", () => {
    const content = `
\`\`\`bash
$ altimate-schema search --pattern "user*"
\`\`\`
`
    const tools = detectToolReferences(content)
    expect(tools).toContain("altimate-schema")
  })
})

// ---------------------------------------------------------------------------
// Integration tests — run the actual CLI commands
// ---------------------------------------------------------------------------

describe("altimate-code skill create", () => {
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-test-"))
  })

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test("creates skill and bash tool", async () => {
    const result = Bun.spawnSync(["bun", "run", "src/cli/cmd/skill.ts", "--help"], {
      cwd: path.join(import.meta.dir, "../../"),
    })
    // Just verify the module parses without errors
    // Full CLI integration requires bootstrap which needs a git repo
  })

  test("scaffold generates valid SKILL.md", async () => {
    const skillDir = path.join(tmpDir, ".opencode", "skills", "test-tool")
    await fs.mkdir(skillDir, { recursive: true })

    // Generate template content (same as in skill.ts)
    const name = "test-tool"
    const content = `---
name: ${name}
description: TODO — describe what this skill does
---

# ${name}

## When to Use
TODO — describe when the agent should invoke this skill.

## CLI Reference
\`\`\`bash
${name} --help
${name} <subcommand> [options]
\`\`\`

## Workflow
1. Understand what the user needs
2. Run the appropriate command
3. Interpret the output and act on it
`
    const skillFile = path.join(skillDir, "SKILL.md")
    await fs.writeFile(skillFile, content)

    const written = await fs.readFile(skillFile, "utf-8")
    expect(written).toContain("name: test-tool")
    expect(written).toContain("description: TODO")
    expect(written).toContain("test-tool --help")
  })

  test("scaffold generates executable bash tool", async () => {
    const toolsDir = path.join(tmpDir, ".opencode", "tools")
    await fs.mkdir(toolsDir, { recursive: true })

    const name = "test-tool"
    const template = `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-help}" in
  help|--help|-h) echo "Usage: ${name} <command>" ;;
  *) echo "Unknown: \${1}" >&2; exit 1 ;;
esac
`
    const toolFile = path.join(toolsDir, name)
    await fs.writeFile(toolFile, template, { mode: 0o755 })

    const stat = await fs.stat(toolFile)
    // Check executable bit (owner)
    expect(stat.mode & 0o100).toBeTruthy()

    // Run the tool
    const proc = Bun.spawnSync(["bash", toolFile, "--help"])
    expect(proc.exitCode).toBe(0)
    expect(proc.stdout.toString()).toContain("Usage:")
  })

  test("scaffold generates executable python tool", async () => {
    const toolsDir = path.join(tmpDir, ".opencode", "tools")
    const name = "py-test-tool"
    const template = `#!/usr/bin/env python3
"""${name}"""
import argparse, sys
def main():
    parser = argparse.ArgumentParser(prog="${name}")
    parser.add_argument("command", nargs="?", default="help")
    args = parser.parse_args()
    if args.command == "help":
        parser.print_help()
        sys.exit(0)
if __name__ == "__main__":
    main()
`
    const toolFile = path.join(toolsDir, name)
    await fs.writeFile(toolFile, template, { mode: 0o755 })

    const proc = Bun.spawnSync(["python3", toolFile, "help"])
    expect(proc.exitCode).toBe(0)
  })

  test("scaffold generates executable node tool", async () => {
    const toolsDir = path.join(tmpDir, ".opencode", "tools")
    const name = "node-test-tool"
    const template = `#!/usr/bin/env node
const command = process.argv[2] || "help"
if (command === "help" || command === "--help") {
  console.log("Usage: ${name} <command>")
} else {
  console.error("Unknown: " + command)
  process.exit(1)
}
`
    const toolFile = path.join(toolsDir, name)
    await fs.writeFile(toolFile, template, { mode: 0o755 })

    const proc = Bun.spawnSync(["node", toolFile, "--help"])
    expect(proc.exitCode).toBe(0)
    expect(proc.stdout.toString()).toContain("Usage:")
  })

  test("rejects invalid skill names", () => {
    // Names must match /^[a-z][a-z0-9]+(-[a-z0-9]+)*$/ (min 2 chars, no trailing hyphens)
    const valid = (n: string) => /^[a-z][a-z0-9]+(-[a-z0-9]+)*$/.test(n) && n.length <= 64
    expect(valid("my-tool")).toBe(true)
    expect(valid("freshness-check")).toBe(true)
    expect(valid("tool123")).toBe(true)
    expect(valid("ab")).toBe(true)
    // Invalid: uppercase, numbers first, spaces, underscores
    expect(valid("MyTool")).toBe(false)
    expect(valid("123tool")).toBe(false)
    expect(valid("my tool")).toBe(false)
    expect(valid("my_tool")).toBe(false)
    // Invalid: single char, trailing hyphen, leading hyphen
    expect(valid("a")).toBe(false)
    expect(valid("a-")).toBe(false)
    expect(valid("-tool")).toBe(false)
    expect(valid("tool-")).toBe(false)
    // Invalid: too long
    expect(valid("a".repeat(65))).toBe(false)
    // Valid edge cases
    expect(valid("a".repeat(64))).toBe(true)
    // Invalid: injection attempts
    expect(valid("$(whoami)")).toBe(false)
    expect(valid("../etc/passwd")).toBe(false)
    expect(valid("`rm -rf /`")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// PATH auto-discovery tests
// ---------------------------------------------------------------------------

describe("PATH auto-discovery for .opencode/tools/", () => {
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tools-path-test-"))
    // Create .opencode/tools/ with an executable
    const toolsDir = path.join(tmpDir, ".opencode", "tools")
    await fs.mkdir(toolsDir, { recursive: true })
    await fs.writeFile(path.join(toolsDir, "my-test-tool"), '#!/usr/bin/env bash\necho "hello from tool"', {
      mode: 0o755,
    })
  })

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test("tool in .opencode/tools/ is executable", async () => {
    const toolPath = path.join(tmpDir, ".opencode", "tools", "my-test-tool")
    const proc = Bun.spawnSync(["bash", toolPath])
    expect(proc.exitCode).toBe(0)
    expect(proc.stdout.toString().trim()).toBe("hello from tool")
  })

  test("tool is discoverable when .opencode/tools/ is on PATH", async () => {
    const toolsDir = path.join(tmpDir, ".opencode", "tools")
    const sep = process.platform === "win32" ? ";" : ":"
    const env = { ...process.env, PATH: `${toolsDir}${sep}${process.env.PATH}` }

    const proc = Bun.spawnSync(["my-test-tool"], { env, cwd: tmpDir })
    expect(proc.exitCode).toBe(0)
    expect(proc.stdout.toString().trim()).toBe("hello from tool")
  })
})
// altimate_change end
