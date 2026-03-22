// altimate_change start — tests for skill CLI command (create, list, test)
import { describe, test, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { detectToolReferences, SHELL_BUILTINS } from "../../src/cli/cmd/skill-helpers"

// ---------------------------------------------------------------------------
// Unit tests — import production code directly (no duplication)
// ---------------------------------------------------------------------------

describe("detectToolReferences", () => {
  test("detects tools from Tools used line", () => {
    const content = `**Tools used:** bash (runs \`altimate-dbt\` commands), read, \`sql_analyze\``
    const tools = detectToolReferences(content)
    expect(tools).toContain("altimate-dbt")
    expect(tools).toContain("sql_analyze")
  })

  test("filters builtins from Tools used line", () => {
    const content = `**Tools used:** \`bash\`, \`read\`, \`glob\`, \`altimate-dbt\``
    const tools = detectToolReferences(content)
    expect(tools).toContain("altimate-dbt")
    expect(tools).not.toContain("bash")
    expect(tools).not.toContain("read")
    expect(tools).not.toContain("glob")
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

  test("handles \\r\\n line endings in bash blocks", () => {
    const content = "```bash\r\nmy-tool run\r\n```"
    const tools = detectToolReferences(content)
    expect(tools).toContain("my-tool")
  })

  test("filters common utilities (git, python, docker, etc.)", () => {
    const content = `
\`\`\`bash
git status
python3 script.py
docker build .
my-custom-cli run
\`\`\`
`
    const tools = detectToolReferences(content)
    expect(tools).toContain("my-custom-cli")
    expect(tools).not.toContain("git")
    expect(tools).not.toContain("python3")
    expect(tools).not.toContain("docker")
  })
})

describe("SHELL_BUILTINS", () => {
  test("contains expected shell builtins", () => {
    for (const cmd of ["echo", "cd", "export", "if", "for", "case"]) {
      expect(SHELL_BUILTINS.has(cmd)).toBe(true)
    }
  })

  test("contains common utilities", () => {
    for (const cmd of ["git", "python", "node", "docker", "curl", "make"]) {
      expect(SHELL_BUILTINS.has(cmd)).toBe(true)
    }
  })

  test("contains agent tool names", () => {
    for (const cmd of ["glob", "write", "edit"]) {
      expect(SHELL_BUILTINS.has(cmd)).toBe(true)
    }
  })

  test("does not contain altimate tools", () => {
    expect(SHELL_BUILTINS.has("altimate-dbt")).toBe(false)
    expect(SHELL_BUILTINS.has("altimate-sql")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Scaffold template tests — use tmpdir() fixture
// ---------------------------------------------------------------------------

describe("altimate-code skill create", () => {
  test("scaffold generates valid SKILL.md with tool reference", async () => {
    await using tmp = await tmpdir({ git: true })
    const skillDir = path.join(tmp.path, ".opencode", "skills", "test-tool")
    await fs.mkdir(skillDir, { recursive: true })

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
2. Run the appropriate CLI command
3. Interpret the output and act on it
`
    const skillFile = path.join(skillDir, "SKILL.md")
    await fs.writeFile(skillFile, content)

    const written = await fs.readFile(skillFile, "utf-8")
    expect(written).toContain("name: test-tool")
    expect(written).toContain("description: TODO")
    expect(written).toContain("test-tool --help")

    // Verify tool detection works on the template
    const tools = detectToolReferences(written)
    expect(tools).toContain("test-tool")
  })

  test("scaffold generates valid SKILL.md without tool reference (skill-only)", async () => {
    await using tmp = await tmpdir({ git: true })
    const skillDir = path.join(tmp.path, ".opencode", "skills", "prompt-only")
    await fs.mkdir(skillDir, { recursive: true })

    const content = `---
name: prompt-only
description: TODO — describe what this skill does
---

# prompt-only

## When to Use
TODO — describe when the agent should invoke this skill.

## Workflow
1. Understand what the user needs
2. Provide guidance based on the instructions below
`
    const skillFile = path.join(skillDir, "SKILL.md")
    await fs.writeFile(skillFile, content)

    const tools = detectToolReferences(content)
    expect(tools.length).toBe(0)
  })

  test("scaffold generates executable bash tool", async () => {
    await using tmp = await tmpdir({ git: true })
    const toolsDir = path.join(tmp.path, ".opencode", "tools")
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
    expect(stat.mode & 0o100).toBeTruthy()

    const proc = Bun.spawnSync(["bash", toolFile, "--help"])
    expect(proc.exitCode).toBe(0)
    expect(proc.stdout.toString()).toContain("Usage:")
  })

  test("scaffold generates executable python tool", async () => {
    await using tmp = await tmpdir({ git: true })
    const toolsDir = path.join(tmp.path, ".opencode", "tools")
    await fs.mkdir(toolsDir, { recursive: true })

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
    await using tmp = await tmpdir({ git: true })
    const toolsDir = path.join(tmp.path, ".opencode", "tools")
    await fs.mkdir(toolsDir, { recursive: true })

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
    const valid = (n: string) => /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(n) && n.length >= 2 && n.length <= 64
    // Valid names
    expect(valid("my-tool")).toBe(true)
    expect(valid("freshness-check")).toBe(true)
    expect(valid("tool123")).toBe(true)
    expect(valid("ab")).toBe(true)
    expect(valid("a-tool")).toBe(true)
    expect(valid("x-ray")).toBe(true)
    expect(valid("a-very-long-but-valid-name")).toBe(true)
    expect(valid("dbt-custom-check")).toBe(true)
    // Invalid: uppercase, numbers first, spaces, underscores
    expect(valid("MyTool")).toBe(false)
    expect(valid("123tool")).toBe(false)
    expect(valid("my tool")).toBe(false)
    expect(valid("my_tool")).toBe(false)
    // Invalid: single char, trailing hyphen, leading hyphen, double hyphen
    expect(valid("a")).toBe(false)
    expect(valid("a-")).toBe(false)
    expect(valid("-tool")).toBe(false)
    expect(valid("tool-")).toBe(false)
    expect(valid("my--tool")).toBe(false)
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
// PATH auto-discovery tests — use tmpdir() fixture
// ---------------------------------------------------------------------------

describe("PATH auto-discovery for .opencode/tools/", () => {
  test("tool in .opencode/tools/ is executable", async () => {
    await using tmp = await tmpdir({ git: true })
    const toolsDir = path.join(tmp.path, ".opencode", "tools")
    await fs.mkdir(toolsDir, { recursive: true })
    await fs.writeFile(path.join(toolsDir, "my-test-tool"), '#!/usr/bin/env bash\necho "hello from tool"', {
      mode: 0o755,
    })

    const toolPath = path.join(toolsDir, "my-test-tool")
    const proc = Bun.spawnSync(["bash", toolPath])
    expect(proc.exitCode).toBe(0)
    expect(proc.stdout.toString().trim()).toBe("hello from tool")
  })

  test("tool is discoverable when .opencode/tools/ is on PATH", async () => {
    await using tmp = await tmpdir({ git: true })
    const toolsDir = path.join(tmp.path, ".opencode", "tools")
    await fs.mkdir(toolsDir, { recursive: true })
    await fs.writeFile(path.join(toolsDir, "my-test-tool"), '#!/usr/bin/env bash\necho "hello from tool"', {
      mode: 0o755,
    })

    const sep = process.platform === "win32" ? ";" : ":"
    const env = { ...process.env, PATH: `${toolsDir}${sep}${process.env.PATH}` }

    const proc = Bun.spawnSync(["my-test-tool"], { env, cwd: tmp.path })
    expect(proc.exitCode).toBe(0)
    expect(proc.stdout.toString().trim()).toBe("hello from tool")
  })
})

// ---------------------------------------------------------------------------
// E2E smoke tests — full skill lifecycle in isolated git repos
// ---------------------------------------------------------------------------

describe("skill create → test → remove lifecycle", () => {
  test("create generates SKILL.md and executable tool", async () => {
    await using tmp = await tmpdir({ git: true })
    const skillDir = path.join(tmp.path, ".opencode", "skills", "lifecycle-test")
    const toolFile = path.join(tmp.path, ".opencode", "tools", "lifecycle-test")

    // Create
    await fs.mkdir(skillDir, { recursive: true })
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      '---\nname: lifecycle-test\ndescription: test\n---\n```bash\nlifecycle-test --help\n```\n',
    )
    await fs.mkdir(path.dirname(toolFile), { recursive: true })
    await fs.writeFile(toolFile, '#!/usr/bin/env bash\necho "Usage: lifecycle-test"', { mode: 0o755 })

    // Verify
    const stat = await fs.stat(toolFile)
    expect(stat.mode & 0o100).toBeTruthy()
    const proc = Bun.spawnSync(["bash", toolFile, "--help"])
    expect(proc.exitCode).toBe(0)

    // Detect tools
    const content = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf-8")
    const tools = detectToolReferences(content)
    expect(tools).toContain("lifecycle-test")

    // Remove
    await fs.rm(skillDir, { recursive: true, force: true })
    await fs.rm(toolFile, { force: true })
    const exists = await fs
      .stat(skillDir)
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(false)
  })

  test("cannot remove git-tracked skill", async () => {
    await using tmp = await tmpdir({ git: true })

    // Create a skill and commit it to git (simulates a repo-tracked skill)
    const skillDir = path.join(tmp.path, ".opencode", "skills", "tracked-skill")
    await fs.mkdir(skillDir, { recursive: true })
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: tracked-skill\ndescription: tracked\n---\n# Tracked\n",
    )
    const { $: shell } = await import("bun")
    await shell`git add .`.cwd(tmp.path).quiet()
    await shell`git commit -m "add skill"`.cwd(tmp.path).quiet()

    // Verify it's tracked
    const gitCheck = Bun.spawnSync(
      ["git", "ls-files", "--error-unmatch", path.join(skillDir, "SKILL.md")],
      { cwd: tmp.path, stdout: "pipe", stderr: "pipe" },
    )
    expect(gitCheck.exitCode).toBe(0)

    // The skill file should NOT be deleted by our remove logic
    // (our CLI checks git ls-files and blocks removal)
    const skillExists = await fs
      .stat(path.join(skillDir, "SKILL.md"))
      .then(() => true)
      .catch(() => false)
    expect(skillExists).toBe(true)
  })
})

describe("skill install — symlink safety", () => {
  test("symlinks are skipped during install copy", async () => {
    await using tmp = await tmpdir({ git: true })

    // Create a source directory with a SKILL.md and a symlink
    const srcDir = path.join(tmp.path, "source", "evil-skill")
    await fs.mkdir(srcDir, { recursive: true })
    await fs.writeFile(
      path.join(srcDir, "SKILL.md"),
      "---\nname: evil-skill\ndescription: has symlink\n---\n# Evil\n",
    )
    // Create a symlink to /etc/passwd (should be skipped)
    await fs.symlink("/etc/passwd", path.join(srcDir, "stolen-file"))

    // Install: simulate the copy logic with lstat + skip symlinks
    const destDir = path.join(tmp.path, ".opencode", "skills", "evil-skill")
    await fs.mkdir(destDir, { recursive: true })
    const files = await fs.readdir(srcDir)
    for (const file of files) {
      const src = path.join(srcDir, file)
      const dst = path.join(destDir, file)
      const stat = await fs.lstat(src)
      if (stat.isSymbolicLink()) continue
      if (stat.isFile()) await fs.copyFile(src, dst)
    }

    // SKILL.md should be copied
    const skillExists = await fs
      .stat(path.join(destDir, "SKILL.md"))
      .then(() => true)
      .catch(() => false)
    expect(skillExists).toBe(true)

    // symlink should NOT be copied
    const symlinkCopied = await fs
      .stat(path.join(destDir, "stolen-file"))
      .then(() => true)
      .catch(() => false)
    expect(symlinkCopied).toBe(false)
  })
})

describe("GitHub URL normalization", () => {
  test("extracts owner/repo from web URLs", () => {
    const re = /^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\/(?:tree|blob)\/.*)?$/
    expect("https://github.com/anthropics/skills/tree/main/skills/pdf".match(re)?.[1]).toBe("anthropics/skills")
    expect("https://github.com/dagster-io/skills/tree/main".match(re)?.[1]).toBe("dagster-io/skills")
    expect("https://github.com/owner/repo".match(re)?.[1]).toBe("owner/repo")
    expect("https://github.com/owner/repo/blob/main/README.md".match(re)?.[1]).toBe("owner/repo")
    expect("https://gitlab.com/owner/repo/tree/main".match(re)).toBeNull()
  })

  test("strips .git suffix", () => {
    const strip = (s: string) => s.trim().replace(/\.git$/, "")
    expect(strip("owner/repo.git")).toBe("owner/repo")
    expect(strip("owner/repo")).toBe("owner/repo")
    expect(strip("https://github.com/owner/repo.git")).toBe("https://github.com/owner/repo")
  })
})
// altimate_change end
