import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { createResource, createMemo } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "@tui/context/sdk"
// altimate_change start — import helpers for tool detection, keybind support, and prompt dialog
import { detectToolReferences } from "../../skill-helpers"
import { Keybind } from "@/util/keybind"
import { useToast } from "@tui/ui/toast"
import { spawn } from "child_process"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import os from "os"
import path from "path"
import fs from "fs/promises"
// altimate_change end

export type DialogSkillProps = {
  onSelect: (skill: string) => void
}

// altimate_change start — categorize skills by domain for cleaner grouping
const SKILL_CATEGORIES: Record<string, string> = {
  "dbt-develop": "dbt",
  "dbt-test": "dbt",
  "dbt-docs": "dbt",
  "dbt-analyze": "dbt",
  "dbt-troubleshoot": "dbt",
  "sql-review": "SQL",
  "sql-translate": "SQL",
  "query-optimize": "SQL",
  "schema-migration": "Schema",
  "pii-audit": "Schema",
  "cost-report": "FinOps",
  "lineage-diff": "Lineage",
  "data-viz": "Visualization",
  "train": "Training",
  "teach": "Training",
  "training-status": "Training",
  "altimate-setup": "Setup",
}

// Cache dir for temporary git clones
function cacheDir(): string {
  return path.join(os.homedir(), ".cache", "altimate-code")
}

/** Resolve git worktree root from a directory, falling back to the directory itself. */
function gitRoot(dir: string): string {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    })
    if (proc.exitCode === 0) {
      const root = new TextDecoder().decode(proc.stdout).trim()
      if (root) return root
    }
  } catch {}
  return dir
}
// altimate_change end

// altimate_change start — inline skill operations (no subprocess spawning)

/** Create a skill + tool pair directly via fs operations. */
async function createSkillDirect(name: string, rootDir: string): Promise<{ ok: boolean; message: string }> {
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name) || name.length < 2 || name.length > 64) {
    return { ok: false, message: "Name must be lowercase alphanumeric with hyphens, 2-64 chars" }
  }
  const skillDir = path.join(rootDir, ".opencode", "skills", name)
  const skillFile = path.join(skillDir, "SKILL.md")
  try {
    await fs.access(skillFile)
    return { ok: false, message: `Skill "${name}" already exists` }
  } catch {
    // doesn't exist, good
  }
  await fs.mkdir(skillDir, { recursive: true })
  await fs.writeFile(
    skillFile,
    `---\nname: ${name}\ndescription: TODO — describe what this skill does\n---\n\n# ${name}\n\n## When to Use\nTODO\n\n## CLI Reference\n\`\`\`bash\n${name} --help\n\`\`\`\n\n## Workflow\n1. Understand what the user needs\n2. Run the appropriate CLI command\n3. Interpret the output\n`,
  )
  // Create tool stub (skip if tool already exists)
  const toolsDir = path.join(rootDir, ".opencode", "tools")
  await fs.mkdir(toolsDir, { recursive: true })
  const toolFile = path.join(toolsDir, name)
  try {
    await fs.access(toolFile)
    // Tool already exists, don't overwrite
  } catch {
    await fs.writeFile(
      toolFile,
      `#!/usr/bin/env bash\nset -euo pipefail\ncase "\${1:-help}" in\n  help|--help|-h) echo "Usage: ${name} <command>" ;;\n  *) echo "Unknown: \${1}" >&2; exit 1 ;;\nesac\n`,
      { mode: 0o755 },
    )
  }
  return { ok: true, message: `Created skill + tool at .opencode/skills/${name}/` }
}

/** Progress callback for live status updates. */
type ProgressFn = (status: string) => void

/** Install skills from a GitHub repo or local path directly. */
async function installSkillDirect(
  source: string,
  rootDir: string,
  onProgress?: ProgressFn,
): Promise<{ ok: boolean; message: string; installedNames?: string[] }> {
  const trimmed = source.trim()
  if (!trimmed) return { ok: false, message: "Source is required" }
  const targetDir = path.join(rootDir, ".opencode", "skills")
  let skillDir: string
  let isTmp = false

  // Normalize GitHub web URLs (e.g. https://github.com/owner/repo/tree/main/path)
  // to clonable repo URLs (https://github.com/owner/repo.git)
  let normalized = trimmed
  const ghWebMatch = trimmed.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\/(?:tree|blob)\/.*)?$/)
  if (ghWebMatch) {
    normalized = `https://github.com/${ghWebMatch[1]}.git`
  }

  if (normalized.startsWith("http://") || normalized.startsWith("https://") || normalized.match(/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+$/)) {
    const url = normalized.startsWith("http") ? normalized : `https://github.com/${normalized}.git`
    const label = url.replace(/https?:\/\/github\.com\//, "").replace(/\.git$/, "")
    onProgress?.(`Cloning ${label}...`)
    const cache = cacheDir()
    await fs.mkdir(cache, { recursive: true })
    const tmpDir = path.join(cache, "skill-install-" + Date.now())
    isTmp = true
    const proc = Bun.spawn(["git", "clone", "--depth", "1", url, tmpDir], {
      stdout: "pipe",
      stderr: "pipe",
    })
    await proc.exited
    if (proc.exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text()
      return { ok: false, message: `Failed to clone: ${stderr.trim().slice(0, 150)}` }
    }
    onProgress?.(`Cloned. Scanning for skills...`)
    skillDir = tmpDir
  } else {
    const resolved = path.isAbsolute(trimmed) ? trimmed : path.resolve(trimmed)
    try {
      await fs.access(resolved)
    } catch {
      return { ok: false, message: `Path not found: ${resolved}` }
    }
    onProgress?.(`Scanning ${resolved}...`)
    skillDir = resolved
  }

  // Find SKILL.md files
  const glob = new Bun.Glob("**/SKILL.md")
  const matches: string[] = []
  for await (const match of glob.scan({ cwd: skillDir, absolute: true })) {
    if (!match.includes("/.git/")) matches.push(match)
  }
  if (matches.length === 0) {
    if (isTmp) await fs.rm(skillDir, { recursive: true, force: true })
    return { ok: false, message: `No SKILL.md files found in ${source}` }
  }

  onProgress?.(`Found ${matches.length} skill(s). Installing...`)

  let installed = 0
  const names: string[] = []
  for (const skillFile of matches) {
    const skillParent = path.dirname(skillFile)
    const skillName = path.basename(skillParent)
    const dest = path.join(targetDir, skillName)
    try {
      await fs.access(dest)
      continue // already exists, skip
    } catch {
      // not installed
    }
    await fs.mkdir(dest, { recursive: true })
    const files = await fs.readdir(skillParent)
    for (const file of files) {
      const src = path.join(skillParent, file)
      const dst = path.join(dest, file)
      const stat = await fs.lstat(src)
      if (stat.isSymbolicLink()) continue
      if (stat.isFile()) await fs.copyFile(src, dst)
      else if (stat.isDirectory()) await fs.cp(src, dst, { recursive: true, dereference: false })
    }
    names.push(skillName)
    installed++
    onProgress?.(`Installed ${installed}/${matches.length}: ${skillName}`)
  }

  if (isTmp) {
    onProgress?.(`Cleaning up...`)
    await fs.rm(skillDir, { recursive: true, force: true })
  }
  if (installed === 0) return { ok: true, message: "No new skills installed (all already exist)" }
  return { ok: true, message: `Installed ${installed} skill(s): ${names.join(", ")}`, installedNames: names }
}

/** Test a skill by checking its tool responds to --help. */
async function testSkillDirect(skillName: string, content: string, rootDir: string): Promise<{ ok: boolean; message: string }> {
  const tools = detectToolReferences(content)
  if (tools.length === 0) return { ok: true, message: `${skillName}: PASS (no CLI tools)` }

  const sep = process.platform === "win32" ? ";" : ":"
  const toolPath = [
    process.env.ALTIMATE_BIN_DIR,
    path.join(rootDir, ".opencode", "tools"),
    path.join(os.homedir(), ".config", "altimate-code", "tools"),
    process.env.PATH,
  ]
    .filter(Boolean)
    .join(sep)

  for (const tool of tools) {
    try {
      const proc = Bun.spawn([tool, "--help"], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PATH: toolPath },
      })
      const timeout = setTimeout(() => proc.kill(), 5000)
      const exitCode = await proc.exited
      clearTimeout(timeout)
      if (exitCode !== 0) {
        return { ok: false, message: `${skillName}: FAIL — "${tool} --help" exited with code ${exitCode}` }
      }
    } catch {
      return { ok: false, message: `${skillName}: FAIL — "${tool}" not found or failed to execute` }
    }
  }
  return { ok: true, message: `${skillName}: PASS` }
}
// altimate_change end

// altimate_change start — sub-dialogs for create and install

/** Reload skills on the server and verify new skills are visible. */
async function reloadAndVerify(sdk: ReturnType<typeof useSDK>, expectedNames: string[]): Promise<string[]> {
  try {
    const resp = await sdk.fetch(`${sdk.url}/skill?reload=true`)
    const skills = (await resp.json()) as Array<{ name: string; description: string }>
    return expectedNames.filter((n) => skills.some((s) => s.name === n))
  } catch {
    return []
  }
}

function DialogSkillCreate() {
  const dialog = useDialog()
  const toast = useToast()
  const sdk = useSDK()

  return (
    <DialogPrompt
      title="Create Skill"
      placeholder="my-tool"
      onConfirm={async (rawName) => {
        const name = rawName.trim()
        dialog.clear()
        if (!name) {
          toast.show({ message: "No name provided.", variant: "error", duration: 4000 })
          return
        }
        toast.show({ message: `Creating "${name}"...`, variant: "info", duration: 30000 })
        try {
          const result = await createSkillDirect(name, gitRoot(sdk.directory ?? process.cwd()))
          if (!result.ok) {
            toast.show({ message: `Create failed: ${result.message}`, variant: "error", duration: 6000 })
            return
          }
          const verified = await reloadAndVerify(sdk, [name])
          if (verified.length > 0) {
            toast.show({
              message: `✓ Created "${name}"\n\nSkill + CLI tool at .opencode/skills/${name}/\nType /${name} in the prompt to use it.`,
              variant: "success",
              duration: 8000,
            })
          } else {
            toast.show({
              message: `✓ Created "${name}" files.\nReopen /skills to see it.`,
              variant: "success",
              duration: 6000,
            })
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          toast.show({ message: `Create error: ${msg.slice(0, 200)}`, variant: "error", duration: 8000 })
        }
      }}
      onCancel={() => dialog.clear()}
    />
  )
}

function DialogSkillInstall() {
  const dialog = useDialog()
  const toast = useToast()
  const sdk = useSDK()

  return (
    <DialogPrompt
      title="Install Skill (owner/repo, URL, or path)"
      placeholder="anthropics/skills"
      onConfirm={async (rawSource) => {
        // Strip trailing dots, whitespace, and .git suffix that users might paste
        const source = rawSource.trim().replace(/\.+$/, "").replace(/\.git$/, "")
        dialog.clear()
        if (!source) {
          toast.show({ message: "No source provided.", variant: "error", duration: 4000 })
          return
        }
        const progress = (status: string) => {
          toast.show({ message: `Installing from ${source}\n\n${status}`, variant: "info", duration: 600000 })
        }
        progress("Preparing...")
        try {
          const result = await installSkillDirect(source, gitRoot(sdk.directory ?? process.cwd()), progress)
          if (!result.ok) {
            toast.show({ message: `Install failed: ${result.message}`, variant: "error", duration: 6000 })
            return
          }
          if (result.message.includes("all already exist")) {
            toast.show({ message: "All skills from this source are already installed.", variant: "info", duration: 4000 })
            return
          }
          const names = result.installedNames ?? []
          progress("Verifying skills loaded...")
          const verified = await reloadAndVerify(sdk, names)
          const lines = [
            `✓ Installed ${verified.length} skill(s)`,
            "",
            ...verified.map((n) => `  • ${n}`),
            "",
            "Open /skills to browse, or type /<name> to use.",
          ]
          toast.show({ message: lines.join("\n"), variant: "success", duration: 8000 })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          toast.show({ message: `Install error: ${msg.slice(0, 200)}`, variant: "error", duration: 8000 })
        }
      }}
      onCancel={() => dialog.clear()}
    />
  )
}
// altimate_change end

export function DialogSkill(props: DialogSkillProps) {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  dialog.setSize("large")

  const [skills, { refetch }] = createResource(async () => {
    const result = await sdk.client.app.skills()
    return result.data ?? []
  })

  // altimate_change start — build lookups from skill name → location/content for actions
  const skillMap = createMemo(() => {
    const map = new Map<string, { location: string; content: string; description: string }>()
    for (const skill of skills() ?? []) {
      map.set(skill.name, { location: skill.location, content: skill.content, description: skill.description })
    }
    return map
  })
  // altimate_change end

  // altimate_change start — enrich skill list with domain categories and tool info
  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const list = skills() ?? []
    const maxWidth = Math.max(0, ...list.map((s) => s.name.length))
    return list.map((skill) => {
      const tools = detectToolReferences(skill.content)
      const category = SKILL_CATEGORIES[skill.name] ?? "Other"
      const desc = skill.description?.replace(/\s+/g, " ").trim()
      const shortDesc = desc && desc.length > 80 ? desc.slice(0, 77) + "..." : desc
      return {
        title: skill.name.padEnd(maxWidth),
        description: shortDesc,
        footer: tools.length > 0 ? `⚡ ${tools.slice(0, 2).join(", ")}` : undefined,
        value: skill.name,
        category,
        onSelect: () => {
          props.onSelect(skill.name)
          dialog.clear()
        },
      }
    })
  })

  // Re-open the main skills dialog (used after an action completes)
  function reopenSkillList() {
    dialog.replace(() => (
      <DialogSkill onSelect={props.onSelect} />
    ))
  }

  // Single keybind opens action picker for the selected skill
  function openActionPicker(skillName: string) {
    const info = skillMap().get(skillName)
    const isBuiltin = !info || info.location.startsWith("builtin:")
    const isRemovable = (() => {
      if (isBuiltin) return false
      const gitCheck = Bun.spawnSync(["git", "ls-files", "--error-unmatch", info!.location], {
        cwd: path.dirname(path.dirname(info!.location)),
        stdout: "pipe",
        stderr: "pipe",
      })
      return gitCheck.exitCode !== 0 // only removable if NOT git-tracked
    })()

    const actions: DialogSelectOption<string>[] = [
      {
        title: "Show details",
        value: "show",
        description: "View skill info, tools, and location",
      },
      {
        title: "Edit",
        value: "edit",
        description: "Open SKILL.md in your default editor",
        disabled: isBuiltin, // allow editing git-tracked skills, only block builtin
      },
      {
        title: "Test",
        value: "test",
        description: "Validate the paired CLI tool works",
      },
      {
        title: "Remove",
        value: "remove",
        description: "Delete this skill and its paired tool",
        disabled: !isRemovable,
      },
    ].filter((a) => !a.disabled)

    dialog.replace(
      () => (
        <DialogSelect
          title={`Actions: ${skillName}`}
          options={actions}
          onSelect={async (action) => {
            switch (action.value) {
            case "show": {
              if (!info) return
              const tools = detectToolReferences(info.content)
              const lines = [
                `${skillName}: ${info.description}`,
                tools.length > 0 ? `Tools: ${tools.join(", ")}` : null,
                `Location: ${info.location}`,
              ]
                .filter((l) => l !== null)
                .join("\n")
              toast.show({ message: lines, variant: "info", duration: 8000 })
              reopenSkillList()
              break
            }
            case "edit": {
              if (!info) return
              // Open in system editor (new window, doesn't conflict with TUI)
              const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
              spawn(openCmd, [info.location], { stdio: "ignore", detached: true }).unref()
              toast.show({
                message: `Opening ${skillName}/SKILL.md in your editor.\n\nFile: ${info.location}`,
                variant: "info",
                duration: 5000,
              })
              reopenSkillList()
              break
            }
            case "test": {
              if (!info) return
              toast.show({ message: `Testing ${skillName}...`, variant: "info", duration: 600000 })
              const result = await testSkillDirect(skillName, info.content, gitRoot(sdk.directory ?? process.cwd()))
              toast.show({
                message: result.ok ? `✓ ${result.message}` : `✗ ${result.message}`,
                variant: result.ok ? "success" : "error",
                duration: 4000,
              })
              reopenSkillList()
              break
            }
            case "remove": {
              if (!info) return
              try {
                const skillDir = path.dirname(info.location)
                await fs.rm(skillDir, { recursive: true, force: true })
                const root = gitRoot(sdk.directory ?? process.cwd())
                const toolFile = path.join(root, ".opencode", "tools", skillName)
                await fs.rm(toolFile, { force: true }).catch(() => {})
                await reloadAndVerify(sdk, [])
                toast.show({ message: `Removed "${skillName}".`, variant: "success", duration: 4000 })
                reopenSkillList()
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err)
                toast.show({ message: `Remove failed: ${msg.slice(0, 150)}`, variant: "error", duration: 5000 })
              }
              break
            }
          }
        }}
      />
      ),
      // When Esc is pressed on the action picker, go back to skill list
      () => setTimeout(() => reopenSkillList(), 0),
    )
  }

  const keybinds = createMemo(() => [
    {
      keybind: Keybind.parse("ctrl+a")[0],
      title: "actions",
      onTrigger: async (option: DialogSelectOption<string>) => {
        openActionPicker(option.value)
      },
    },
    {
      keybind: Keybind.parse("ctrl+n")[0],
      title: "new",
      onTrigger: async () => {
        dialog.replace(() => <DialogSkillCreate />)
      },
    },
    {
      keybind: Keybind.parse("ctrl+i")[0],
      title: "install",
      onTrigger: async () => {
        dialog.replace(() => <DialogSkillInstall />)
      },
    },
  ])
  // altimate_change end

  return (
    <DialogSelect
      title="Skills"
      placeholder="Search skills..."
      options={options()}
      keybind={keybinds()}
    />
  )
}
