// altimate_change start — fork TUI feature: inline skill management (list + create/install/test).
//
// Re-homed from the pre-merge inline `altimate_change` blocks in
// packages/opencode/src/cli/cmd/tui/component/dialog-skill.tsx (see
// docs/internal/2026-06-23-tui-fork-features-as-plugins-adr.md, re-home plan item 2).
//
// This is an opencode-side, fork-owned plugin: it imports opencode-package code
// (`detectToolReferences` from @/cli/cmd/skill-helpers) directly — the point of the ADR — and
// renders/acts through the TuiPluginApi (api.ui.DialogSelect / DialogPrompt / dialog, api.client,
// api.theme, api.toast, api.keymap) so upstream packages/tui stays byte-for-byte upstream.
//
// What it does:
//   - Lists skills (from `api.client.app.skills()`), categorized by domain (SKILL_CATEGORIES),
//     with tool footers from detectToolReferences.
//   - Per-skill actions (show / edit / test / remove) via an action picker.
//   - Create a new skill+tool pair, and install skills from a GitHub repo / URL / local path,
//     done inline via opencode-side fs ops (no subprocess for the orchestration).
//
// Keybind port: the pre-merge DialogSelect `keybind` prop (ctrl+a/ctrl+n/ctrl+i) no longer exists.
// Those are ported to a keymap layer (commands + explicit bindings) registered while the skill
// dialog is open and disposed when it closes:
//   ctrl+a -> altimate.skill.actions  (action picker for the highlighted skill)
//   ctrl+n -> altimate.skill.create   (create skill dialog)
//   ctrl+i -> altimate.skill.install  (install skill dialog)
// A "Skills" palette command (altimate.skill.list) opens the list.
import type { TuiPlugin, TuiPluginApi, TuiDialogSelectOption } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "@opencode-ai/tui/builtins"
import { createMemo, createResource, createSignal, Show } from "solid-js"
import { detectToolReferences } from "@/cli/cmd/skill-helpers"
import { spawn } from "child_process"
import os from "os"
import path from "path"
import fs from "fs/promises"

const id = "altimate:skill-ops"

// altimate_change start — single classifier shared by installSkillDirect and the skill-list
// dialog's "Install <query>" affordance. Extracted so the UI's install-preview and the
// installer can't drift (an earlier `looksInstallable` that only checked `q.includes("/")`
// surfaced the Install option for shapes the installer then rejected as "Path not found",
// e.g. `owner/repo/subpath`). A clean two-segment `owner/repo` is intentionally treated
// as GitHub shorthand — indistinguishable from a two-token search without a network call,
// and skill names cannot contain a slash so no real search result is hijacked. Returns
// null for shapes the installer wouldn't accept without ambiguity — three-segment paths,
// relative paths, `~`, bare identifiers — so we only surface the synthetic Install row
// when Enter will actually try to install.
export type InstallSourceKind = "github-url" | "owner-repo" | "absolute-path"
const OWNER_REPO_REGEX = /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+$/

// Strip the surface variation the classifier tolerates — whitespace, trailing dots,
// and a `.git` suffix — before comparing. Exported so callers that consume the
// classified string (e.g. installSkillDirect building a clone URL) can use the exact
// same shape as the classifier, avoiding double-suffix bugs like `owner/repo.git.git`.
export function normalizeInstallSource(source: string): string {
  return source.trim().replace(/\.+$/, "").replace(/\.git$/, "")
}

export function classifyInstallSource(source: string): InstallSourceKind | null {
  const trimmed = normalizeInstallSource(source)
  if (trimmed.length < 3) return null
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return "github-url"
  if (OWNER_REPO_REGEX.test(trimmed)) return "owner-repo"
  if (trimmed.startsWith("/")) return "absolute-path"
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return "absolute-path"
  return null
}

// Sentinel value for the synthetic top-of-list "Install <query>" option. Namespaced so it
// can't collide with any skill name (skill names match `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`).
// Module-scope so it's stable across renders and reachable by every function that needs
// to check whether an item.value is the sentinel (onSelect, onMove, showActions).
const INSTALL_ACTION_VALUE = "__altimate:skill:install-from-query__"
// altimate_change end

// Categorize skills by domain for cleaner grouping in the list.
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
  train: "Training",
  teach: "Training",
  "training-status": "Training",
  "altimate-setup": "Setup",
}

type SkillInfo = { name: string; description?: string; location: string; content: string }

// Cache dir for temporary git clones.
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

/** Working directory for fs ops — driven by the TUI's known worktree/directory. */
function workdir(api: TuiPluginApi): string {
  return gitRoot(api.state.path.worktree || api.state.path.directory || process.cwd())
}

// ── Inline skill operations (no subprocess spawning for orchestration) ──────────────────────────

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

  // Classify the source. Anything the classifier recognises (github-url / owner-repo /
  // absolute-path) takes the corresponding branch. Anything it doesn't (relative path,
  // `~`, bare identifier) falls through to the path branch below and is resolved against
  // cwd — that's the historical behaviour, preserved as a fallback for callers that
  // reach the installer without going through the UI's install-preview.
  const kind = classifyInstallSource(normalized)
  if (kind === "github-url" || kind === "owner-repo") {
    // Branch on the already-computed `kind`, not on a `startsWith("http")` probe of the
    // normalized string. Two bugs are avoided that way:
    //   1. An owner whose name literally starts with `http` (e.g. `httpie/httpie`,
    //      `http-party/http-server`) classifies as `owner-repo` but its normalized form
    //      also starts with `http` — a raw prefix test would treat it as an "already a
    //      URL" and try to `git clone httpie/httpie`, which fails.
    //   2. `normalizeInstallSource` strips a trailing `.git`; for owner-repo we want that
    //      (so `owner/repo.git` doesn't produce `owner/repo.git.git`), but for an explicit
    //      `github-url` we want to preserve whatever the user typed — self-hosted git
    //      servers require the exact suffix form.
    const url =
      kind === "github-url"
        ? normalized.trim().replace(/\.+$/, "")
        : `https://github.com/${normalizeInstallSource(normalized)}.git`
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
async function testSkillDirect(
  skillName: string,
  content: string,
  rootDir: string,
): Promise<{ ok: boolean; message: string }> {
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

type RawSdkClient = {
  get(options: { url: string; query?: Record<string, unknown> }): Promise<{ data?: unknown; error?: unknown }>
}

/**
 * Re-fetch the skill list with server-side cache invalidation.
 *
 * The generated SDK method does not expose `/skill?reload=true`, but the generated client is still
 * present at runtime. Use it narrowly here instead of regenerating the SDK during the bridge merge.
 */
async function reloadSkills(api: TuiPluginApi): Promise<SkillInfo[]> {
  const raw = (api.client as unknown as { client?: RawSdkClient }).client
  if (raw) {
    const result = await raw.get({ url: "/skill", query: { reload: "true" } })
    return (result.data ?? []) as SkillInfo[]
  }
  const result = await api.client.app.skills()
  return (result.data ?? []) as SkillInfo[]
}

async function reloadAndVerify(api: TuiPluginApi, expectedNames: string[]): Promise<string[]> {
  try {
    const skills = await reloadSkills(api)
    return expectedNames.filter((n) => skills.some((s) => s.name === n))
  } catch {
    return []
  }
}

// ── Sub-dialogs ─────────────────────────────────────────────────────────────────────────────────

function DialogSkillCreate(props: { api: TuiPluginApi; initialValue?: string }) {
  const { api } = props
  const theme = () => api.theme.current
  const [busy, setBusy] = createSignal(false)
  return (
    <api.ui.DialogPrompt
      title="Create Skill"
      placeholder="my-tool"
      value={props.initialValue}
      busy={busy()}
      busyText="Creating skill..."
      description={() => (
        <text fg={theme().textMuted}>lowercase, hyphenated, 2-64 chars (e.g. my-tool)</text>
      )}
      onConfirm={async (rawName) => {
        if (busy()) return
        const name = rawName.trim()
        if (!name) {
          api.ui.dialog.clear()
          api.ui.toast({ message: "No name provided.", variant: "error", duration: 4000 })
          return
        }
        setBusy(true)
        try {
          const result = await createSkillDirect(name, workdir(api))
          if (!result.ok) {
            api.ui.toast({ message: `Create failed: ${result.message}`, variant: "error", duration: 6000 })
            return
          }
          const verified = await reloadAndVerify(api, [name])
          if (verified.length > 0) {
            api.ui.toast({
              message: `Created "${name}"\n\nSkill + CLI tool at .opencode/skills/${name}/\nType /${name} in the prompt to use it.`,
              variant: "success",
              duration: 8000,
            })
          } else {
            api.ui.toast({
              message: `Created "${name}" files, but failed to refresh the skill list.`,
              variant: "error",
              duration: 8000,
            })
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          api.ui.toast({ message: `Create error: ${msg.slice(0, 200)}`, variant: "error", duration: 8000 })
        } finally {
          setBusy(false)
          api.ui.dialog.clear()
        }
      }}
      onCancel={() => api.ui.dialog.clear()}
    />
  )
}

function DialogSkillInstall(props: { api: TuiPluginApi; initialValue?: string }) {
  const { api } = props
  const theme = () => api.theme.current
  const [busy, setBusy] = createSignal(false)
  const [status, setStatus] = createSignal<string>("")
  return (
    <api.ui.DialogPrompt
      title="Install Skill (owner/repo, URL, or path)"
      placeholder="anthropics/skills"
      value={props.initialValue}
      busy={busy()}
      busyText="Installing skill..."
      description={() => (
        <box gap={1}>
          <text fg={theme().textMuted}>From a GitHub repo (owner/repo), a URL, or a local path.</text>
          <Show when={busy() && status()}>
            <text fg={theme().text}>{status()}</text>
          </Show>
        </box>
      )}
      onConfirm={async (rawSource) => {
        if (busy()) return
        // Strip trailing dots, whitespace, and .git suffix that users might paste
        const source = rawSource.trim().replace(/\.+$/, "").replace(/\.git$/, "")
        if (!source) {
          api.ui.dialog.clear()
          api.ui.toast({ message: "No source provided.", variant: "error", duration: 4000 })
          return
        }
        setBusy(true)
        const progress = (s: string) => setStatus(s)
        progress("Preparing...")
        try {
          const result = await installSkillDirect(source, workdir(api), progress)
          if (!result.ok) {
            api.ui.toast({ message: `Install failed: ${result.message}`, variant: "error", duration: 6000 })
            return
          }
          if (result.message.includes("all already exist")) {
            api.ui.toast({
              message: "All skills from this source are already installed.",
              variant: "info",
              duration: 4000,
            })
            return
          }
          const names = result.installedNames ?? []
          progress("Verifying skills loaded...")
          const verified = await reloadAndVerify(api, names)
          if (verified.length !== names.length) {
            const missing = names.filter((name) => !verified.includes(name))
            api.ui.toast({
              message: `Installed files, but failed to refresh ${missing.length} skill(s): ${missing.join(", ")}`,
              variant: "error",
              duration: 8000,
            })
            return
          }
          const shown = verified
          const lines = [
            `Installed ${shown.length} skill(s)`,
            "",
            ...shown.map((n) => `  • ${n}`),
            "",
            "Open /skills to browse, or type /<name> to use.",
          ]
          api.ui.toast({ message: lines.join("\n"), variant: "success", duration: 8000 })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          api.ui.toast({ message: `Install error: ${msg.slice(0, 200)}`, variant: "error", duration: 8000 })
        } finally {
          setBusy(false)
          api.ui.dialog.clear()
        }
      }}
      onCancel={() => api.ui.dialog.clear()}
    />
  )
}

// ── Action picker (per-skill: show / edit / test / remove) ───────────────────────────────────────

function isRemovable(info: SkillInfo): boolean {
  // altimate_change start — built-ins (e.g. `customize-opencode`, location "<built-in>") are not
  // real filesystem paths; removing them would `path.dirname` to "." and rm -rf the cwd. Only
  // skills with an absolute filesystem location are removable.
  if (info.location.startsWith("builtin:") || !path.isAbsolute(info.location)) return false
  // altimate_change end
  const gitCheck = Bun.spawnSync(["git", "ls-files", "--error-unmatch", info.location], {
    cwd: path.dirname(path.dirname(info.location)),
    stdout: "pipe",
    stderr: "pipe",
  })
  return gitCheck.exitCode !== 0 // only removable if NOT git-tracked
}

function openActionPicker(api: TuiPluginApi, info: SkillInfo | undefined, skillName: string, reopen: () => void) {
  const isBuiltin = !info || info.location.startsWith("builtin:") || !path.isAbsolute(info.location)
  const removable = !!info && isRemovable(info)

  const actions: TuiDialogSelectOption<string>[] = (
    [
      { title: "Show details", value: "show", description: "View skill info, tools, and location" },
      { title: "Edit", value: "edit", description: "Open SKILL.md in your default editor", disabled: isBuiltin },
      { title: "Test", value: "test", description: "Validate the paired CLI tool works" },
      { title: "Remove", value: "remove", description: "Delete this skill and its paired tool", disabled: !removable },
    ] as TuiDialogSelectOption<string>[]
  ).filter((a) => !a.disabled)

  api.ui.dialog.replace(
    () => (
      <api.ui.DialogSelect
        title={`Actions: ${skillName}`}
        options={actions}
        onSelect={async (action) => {
          switch (action.value) {
            case "show": {
              if (!info) return
              const tools = detectToolReferences(info.content)
              const lines = [
                `${skillName}: ${info.description ?? ""}`.trim(),
                tools.length > 0 ? `Tools: ${tools.join(", ")}` : null,
                `Location: ${info.location}`,
              ]
                .filter((l): l is string => l !== null)
                .join("\n")
              api.ui.toast({ message: lines, variant: "info", duration: 8000 })
              reopen()
              break
            }
            case "edit": {
              if (!info) return
              const openCmd =
                process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
              spawn(openCmd, [info.location], { stdio: "ignore", detached: true }).unref()
              api.ui.toast({
                message: `Opening ${skillName}/SKILL.md in your editor.\n\nFile: ${info.location}`,
                variant: "info",
                duration: 5000,
              })
              reopen()
              break
            }
            case "test": {
              if (!info) return
              api.ui.toast({ message: `Testing ${skillName}...`, variant: "info", duration: 600000 })
              const result = await testSkillDirect(skillName, info.content, workdir(api))
              api.ui.toast({
                message: result.ok ? result.message : result.message,
                variant: result.ok ? "success" : "error",
                duration: 4000,
              })
              reopen()
              break
            }
            case "remove": {
              if (!info) return
              try {
                const skillDir = path.dirname(info.location)
                await fs.rm(skillDir, { recursive: true, force: true })
                const root = workdir(api)
                const toolFile = path.join(root, ".opencode", "tools", skillName)
                await fs.rm(toolFile, { force: true }).catch(() => {})
                await reloadAndVerify(api, [])
                api.ui.toast({ message: `Removed "${skillName}".`, variant: "success", duration: 4000 })
                reopen()
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err)
                api.ui.toast({ message: `Remove failed: ${msg.slice(0, 150)}`, variant: "error", duration: 5000 })
              }
              break
            }
          }
        }}
      />
    ),
    // Esc on the action picker returns to the skill list.
    () => setTimeout(reopen, 0),
  )
}

// ── Main skill list ───────────────────────────────────────────────────────────────────────────--

function DialogSkillList(props: { api: TuiPluginApi; onCurrent: (skill: string | undefined) => void }) {
  const { api } = props

  const [skills] = createResource(async () => {
    try {
      const result = await api.client.app.skills()
      return (result.data ?? []) as SkillInfo[]
    } catch {
      return [] as SkillInfo[]
    }
  })

  const skillMap = createMemo(() => {
    const map = new Map<string, SkillInfo>()
    for (const skill of skills() ?? []) map.set(skill.name, skill)
    return map
  })
  // Expose the lookup to the keymap-layer commands (ctrl+a/test/etc).
  registerLookup(api, skillMap)

  // altimate_change start — capture the current filter text so an install/create
  // action triggered from inside the list can prefill the sub-dialog with what the user typed
  // (e.g. a GitHub URL typed into the search box), instead of dropping it on the floor.
  const [filter, setFilter] = createSignal("")
  currentFilter = filter
  // altimate_change end

  // Base list — depends only on `skills()`. Kept separate from the `options` memo below
  // so that per-keystroke filter changes don't re-run `detectToolReferences` (regex parse
  // per skill) across the whole list. On projects with many installed skills the previous
  // fused memo produced noticeable typing lag.
  const baseOptions = createMemo<TuiDialogSelectOption<string>[]>(() => {
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
        footer: tools.length > 0 ? `${tools.slice(0, 2).join(", ")}` : undefined,
        value: skill.name,
        category,
      } satisfies TuiDialogSelectOption<string>
    })
  })

  const options = createMemo<TuiDialogSelectOption<string>[]>(() => {
    const items = baseOptions()
    // altimate_change start — when the filter looks like a shape installSkillDirect will
    // accept (github URL, `owner/repo` shorthand, or absolute path), prepend a synthetic
    // "Install <query>" top option. Selecting it (Enter) routes to installSkillDirect.
    // Non-mutating build (spread instead of unshift) so this stays a pure memo — Solid
    // dev-mode double-eval would otherwise double-prepend.
    // ctrl+i on the wire is byte 0x09 = Tab, so we can't offer a reliable ctrl+i binding
    // on default terminals; Enter on this synthetic row is the discoverable substitute.
    const q = filter().trim()
    if (classifyInstallSource(q) !== null) {
      const installOption: TuiDialogSelectOption<string> = {
        title: `Install ${q}`,
        description: "Press Enter to install from this GitHub repo, URL, or path",
        footer: undefined,
        value: INSTALL_ACTION_VALUE,
        category: "Install",
      }
      return [installOption, ...items]
    }
    // altimate_change end
    return items
  })

  return (
    <api.ui.DialogSelect
      title="Skills"
      placeholder="Search skills, or type a repo/URL and press Enter to install..."
      options={options()}
      onFilter={(q) => setFilter(q)}
      // altimate_change start — filter the sentinel out of onCurrent so highlighting
      // the synthetic Install row doesn't set `currentSkill` to the sentinel string
      // (which would trip ctrl+a's showActions into opening a degenerate action picker
      // on a non-existent skill named INSTALL_ACTION_VALUE).
      onMove={(item) => props.onCurrent(item.value === INSTALL_ACTION_VALUE ? undefined : item.value)}
      // altimate_change end
      onSelect={(item) => {
        // altimate_change start — synthetic install option routes to installer.
        if (item.value === INSTALL_ACTION_VALUE) {
          showInstall(api, filter().trim() || undefined)
          return
        }
        // altimate_change end
        props.onCurrent(item.value)
        // Selecting a skill opens its action picker (the pre-merge default action was the picker).
        openActionPicker(api, skillMap().get(item.value), item.value, () => showList(api))
      }}
    />
  )
}

// The keymap-layer commands need the current skill name + the lookup of the *open* list dialog.
// Both are module-level so the layer (registered once at plugin init) can reach the live values.
let currentSkill: string | undefined
let currentLookup: () => Map<string, SkillInfo> = () => new Map()
// altimate_change start — expose the current list dialog's filter text so the outer
// keymap-layer install/create commands (ctrl+i/ctrl+n) can prefill the sub-dialog with whatever
// the user has typed into the search box. Reset to a no-op after the list closes so a fresh
// keybind press from an unrelated context doesn't leak stale text.
let currentFilter: () => string = () => ""
// altimate_change end

function registerLookup(_api: TuiPluginApi, lookup: () => Map<string, SkillInfo>) {
  currentLookup = lookup
}

function showList(api: TuiPluginApi) {
  api.ui.dialog.replace(
    () => <DialogSkillList api={api} onCurrent={(skill) => (currentSkill = skill)} />,
    () => {
      currentFilter = () => ""
    },
  )
}

function showCreate(api: TuiPluginApi, initialValue?: string) {
  api.ui.dialog.replace(
    () => <DialogSkillCreate api={api} initialValue={initialValue} />,
    () => setTimeout(() => showList(api), 0),
  )
}

function showInstall(api: TuiPluginApi, initialValue?: string) {
  api.ui.dialog.replace(
    () => <DialogSkillInstall api={api} initialValue={initialValue} />,
    () => setTimeout(() => showList(api), 0),
  )
}

function showActions(api: TuiPluginApi) {
  // Belt-and-braces against the synthetic Install row leaking into `currentSkill` via a
  // future refactor that forgets the DialogSkillList `onMove` filter — refuse to open a
  // per-skill action picker unless we can resolve a real skill entry from the lookup.
  if (!currentSkill || currentSkill === INSTALL_ACTION_VALUE) return
  const info = currentLookup().get(currentSkill)
  if (!info) return
  openActionPicker(api, info, currentSkill, () => showList(api))
}

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: "altimate.skill.list",
        title: "Skills",
        desc: "Browse, create, install, and test skills",
        category: "Altimate",
        namespace: "palette",
        slashName: "skills",
        run() {
          showList(api)
        },
      },
      {
        name: "altimate.skill.actions",
        title: "Skill actions",
        desc: "Show / edit / test / remove the highlighted skill",
        category: "Altimate",
        run() {
          showActions(api)
        },
      },
      {
        name: "altimate.skill.create",
        title: "Create skill",
        desc: "Create a new skill + CLI tool pair",
        category: "Altimate",
        namespace: "palette",
        run() {
          showCreate(api, currentFilter().trim() || undefined)
        },
      },
      {
        name: "altimate.skill.install",
        title: "Install skill",
        desc: "Install skills from a GitHub repo, URL, or local path",
        category: "Altimate",
        namespace: "palette",
        run() {
          showInstall(api, currentFilter().trim() || undefined)
        },
      },
    ],
    // Pre-merge keybinds (the old DialogSelect `keybind` prop) ported to explicit bindings:
    //   ctrl+a -> actions · ctrl+n -> create · ctrl+i -> install.
    // altimate_change start — restore a default key to OPEN the skills list (pre-merge skill_list
    // was ctrl+i, which now collides with tab/agent-cycle; use a collision-free <leader>k instead).
    bindings: [
      { key: "<leader>k", cmd: "altimate.skill.list" },
      { key: "ctrl+a", cmd: "altimate.skill.actions" },
      { key: "ctrl+n", cmd: "altimate.skill.create" },
      { key: "ctrl+i", cmd: "altimate.skill.install" },
    ],
    // altimate_change end
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin

// DEFERRED (cannot map to the plugin api without fabricating methods / unsafe context):
//   1. Pre-merge `keybind` prop scoping. The old keybinds were attached to the DialogSelect
//      instance, so they were active only while the list was visible. The plugin-api DialogSelect
//      has no per-instance keybind prop, so ctrl+a/n/i are registered as a keymap layer at plugin
//      init and are globally active. `altimate.skill.actions` no-ops when no skill is highlighted
//      (currentSkill undefined); create/install open standalone dialogs, matching the pre-merge
//      intent. If strict list-only scoping is required, register/dispose the layer around the list
//      lifecycle once the plugin api exposes a dialog-scoped binding hook.
// altimate_change end
