import z from "zod"
import fs from "fs"
import path from "path"
import { parse as parseJsonc, type ParseError } from "jsonc-parser"
import { Tool } from "../../tool/tool"
import { resolveEnvVars, resolveProfilesPath } from "../native/connections/dbt-profiles"

// The Power User setting this tool reads: `dbt.deferConfigPerProject`, keyed by the dbt project's path
// relative to its workspace folder.
const SETTING = "dbt.deferConfigPerProject"

export interface DeferSetting {
  deferToProduction?: boolean
  favorState?: boolean
  manifestPathForDeferral?: string
  manifestPathType?: string
  dbtCoreIntegrationId?: string | number
}

export interface DeferStateResult {
  enabled: boolean
  favorState: boolean
  /** "local" | "remote" | "none" (no entry for this project, or a manifest type this tool does not know) */
  mode: "local" | "remote" | "none"
  /** Directory holding the manifest to defer to; set whenever the configured local one can be used, also while defer is off. */
  stateDir?: string
  /** Why the configured defer cannot be used: no usable state directory, remote mode, an unknown manifest type. */
  reason?: string
  /** The settings key that matched, relative to the workspace folder. */
  settingsKey?: string
  settingsFile?: string
  profile?: string
  defaultTarget?: string
  targets: string[]
}

/** Expand `${env:NAME}` and `${workspaceFolder}`; an unset variable is left as written. */
function expandVariables(value: string, workspaceFolder: string): string {
  return value
    .replace(/\$\{env:(.*?)\}/g, (match, name: string) => process.env[name] ?? match)
    .replace(/\$\{workspaceFolder\}/g, () => workspaceFolder)
}

function readSettings(file: string): Record<string, unknown> | undefined {
  let text: string
  try {
    text = fs.readFileSync(file, "utf-8")
  } catch {
    return undefined
  }
  const errors: ParseError[] = []
  // .vscode/settings.json allows comments and trailing commas.
  const parsed = parseJsonc(text, errors, { allowTrailingComma: true })
  // A file that does not parse cannot be trusted to say defer is on.
  if (errors.length > 0) return undefined
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  return parsed as Record<string, unknown>
}

/**
 * Find the entry for the project. The workspace folder is the nearest ancestor of the project (or the
 * project itself) whose `.vscode/settings.json` has an entry under the project's relative path.
 */
export function findDeferSetting(projectDir: string, workspaceDir?: string) {
  const start = path.resolve(projectDir)
  const candidates: string[] = []
  if (workspaceDir) candidates.push(path.resolve(workspaceDir))
  else {
    for (let dir = start; ; dir = path.dirname(dir)) {
      candidates.push(dir)
      if (path.dirname(dir) === dir) break
    }
  }
  for (const folder of candidates) {
    const file = path.join(folder, ".vscode", "settings.json")
    const settings = readSettings(file)
    const perProject = settings?.[SETTING]
    if (!perProject || typeof perProject !== "object") continue
    const key = path.relative(folder, start)
    const entry = (perProject as Record<string, unknown>)[key]
    if (entry && typeof entry === "object") {
      return { entry: entry as DeferSetting, key, file, folder }
    }
  }
  return undefined
}

function profilesFile(projectDir: string): string | undefined {
  const file = resolveProfilesPath(undefined, projectDir)
  return fs.existsSync(file) ? file : undefined
}

async function parseYaml(text: string): Promise<any> {
  const mod = await import("yaml")
  return (mod.default ?? mod).parse(text)
}

/** The project's profile name, that profile's default `target` and its output names. */
export async function readProfileTargets(projectDir: string) {
  const out: { profile?: string; defaultTarget?: string; targets: string[] } = { targets: [] }
  try {
    const project = await parseYaml(fs.readFileSync(path.join(projectDir, "dbt_project.yml"), "utf-8"))
    const profile = resolveEnvVars(project?.profile)
    if (typeof profile === "string" && profile !== "") out.profile = profile
  } catch {
    return out
  }
  if (!out.profile) return out
  const file = profilesFile(projectDir)
  if (!file) return out
  try {
    const profiles = await parseYaml(fs.readFileSync(file, "utf-8"))
    const profile = profiles?.[out.profile]
    if (profile && typeof profile === "object") {
      const target = resolveEnvVars(profile.target)
      if (typeof target === "string" && target !== "") out.defaultTarget = target
      if (profile.outputs && typeof profile.outputs === "object") out.targets = Object.keys(profile.outputs)
    }
  } catch {
    // An unreadable profiles.yml leaves the target unknown.
  }
  return out
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

export async function resolveDeferState(projectDir: string, workspaceDir?: string): Promise<DeferStateResult> {
  const root = path.resolve(projectDir)
  const targets = await readProfileTargets(root)
  const base: DeferStateResult = { enabled: false, favorState: false, mode: "none", ...targets }
  const found = findDeferSetting(root, workspaceDir)
  if (!found) return base

  const { entry } = found
  const result: DeferStateResult = {
    ...base,
    settingsKey: found.key,
    settingsFile: found.file,
    favorState: entry.favorState === true,
  }
  const wanted = entry.deferToProduction === true

  // Power User writes "local" or "remote"; an entry without a type is local. Anything else is not understood.
  const type = entry.manifestPathType
  if (type !== undefined && type !== "" && type !== "local" && type !== "remote") {
    return { ...result, reason: `Unknown manifestPathType "${String(type)}": expected "local" or "remote".` }
  }
  if (type === "remote") {
    // The request that downloads the manifest is not implemented, so remote mode cannot supply a state dir.
    return { ...result, mode: "remote", reason: "Remote defer mode is not supported yet: download the manifest and use a local path." }
  }
  result.mode = "local"

  // The directory is resolved whether or not defer is on, so a session can still switch it on.
  const raw = entry.manifestPathForDeferral
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ...result, reason: "manifestPathForDeferral is not set." }
  }
  const expanded = expandVariables(raw, found.folder)
  const stateDir = path.isAbsolute(expanded) ? expanded : path.resolve(root, expanded)
  if (!isDirectory(stateDir)) {
    return { ...result, reason: `manifestPathForDeferral is not a directory: ${stateDir}` }
  }
  if (!fs.existsSync(path.join(stateDir, "manifest.json"))) {
    return { ...result, reason: `No manifest.json in manifestPathForDeferral: ${stateDir}` }
  }
  return { ...result, enabled: wanted, stateDir }
}

export const DbtDeferStateTool = Tool.define("dbt_defer_state", {
  description:
    "Read the dbt Power User defer setting for a dbt project (`dbt.deferConfigPerProject` in .vscode/settings.json) and the project's profile target. Returns whether defer is on, whether to favor state, the state directory to pass as `dbt --defer --state <dir>` (use it only when `enabled` is true), and the profile's default target and target names. Read-only.",
  parameters: z.object({
    project_dir: z.string().describe("The dbt project directory (the folder holding dbt_project.yml)"),
    workspace_dir: z
      .string()
      .optional()
      .describe("The workspace folder that holds .vscode/settings.json (default: the nearest ancestor of project_dir whose settings have an entry for the project)"),
  }),
  async execute(args) {
    try {
      const result = await resolveDeferState(args.project_dir, args.workspace_dir)
      const lines = [
        `defer: ${result.enabled ? "on" : "off"}${result.favorState ? " (favor state)" : ""}`,
        `mode: ${result.mode}`,
      ]
      if (result.stateDir) lines.push(`state dir${result.enabled ? "" : " (not used: defer is off)"}: ${result.stateDir}`)
      if (result.reason) lines.push(`note: ${result.reason}`)
      if (result.defaultTarget) lines.push(`default target: ${result.defaultTarget}`)
      if (result.targets.length) lines.push(`targets: ${result.targets.join(", ")}`)
      return {
        title: `dbt Defer: ${result.enabled ? "on" : "off"}`,
        metadata: { success: true, error: undefined as string | undefined, ...result },
        output: lines.join("\n"),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "dbt Defer: ERROR",
        metadata: { success: false, error: msg as string | undefined, enabled: false },
        output: `Failed: ${msg}`,
      }
    }
  },
})
