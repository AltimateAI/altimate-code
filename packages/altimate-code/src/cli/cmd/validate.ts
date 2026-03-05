import type { Argv } from "yargs"
import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import fs from "fs/promises"
import path from "path"
import os from "os"

// Injected at build time by build.ts (same pattern as ALTIMATE_CLI_MIGRATIONS).
// In development these fall back to reading from disk via getAssets().
declare const ALTIMATE_VALIDATE_LANGFUSE_LOGGER: string
declare const ALTIMATE_VALIDATE_SETTINGS: string
declare const ALTIMATE_VALIDATE_SKILL_MD: string
declare const ALTIMATE_VALIDATE_BATCH_PY: string

interface ValidateAssets {
  loggerContent: string
  settingsContent: string
  skillMd: string
  batchPy: string
}

async function getAssets(): Promise<ValidateAssets> {
  if (
    typeof ALTIMATE_VALIDATE_LANGFUSE_LOGGER !== "undefined" &&
    typeof ALTIMATE_VALIDATE_SETTINGS !== "undefined" &&
    typeof ALTIMATE_VALIDATE_SKILL_MD !== "undefined" &&
    typeof ALTIMATE_VALIDATE_BATCH_PY !== "undefined"
  ) {
    return {
      loggerContent: ALTIMATE_VALIDATE_LANGFUSE_LOGGER,
      settingsContent: ALTIMATE_VALIDATE_SETTINGS,
      skillMd: ALTIMATE_VALIDATE_SKILL_MD,
      batchPy: ALTIMATE_VALIDATE_BATCH_PY,
    }
  }
  // Development fallback: read from disk relative to this source file
  const hooksDir = path.join(import.meta.dir, "../hooks")
  const skillsDir = path.join(import.meta.dir, "../skills/validate")
  const [loggerContent, settingsContent, skillMd, batchPy] = await Promise.all([
    fs.readFile(path.join(hooksDir, "langfuse_logger.py"), "utf-8"),
    fs.readFile(path.join(hooksDir, "settings.json"), "utf-8"),
    fs.readFile(path.join(skillsDir, "SKILL.md"), "utf-8"),
    fs.readFile(path.join(skillsDir, "batch_validate.py"), "utf-8"),
  ])
  return { loggerContent, settingsContent, skillMd, batchPy }
}

async function getClaudeDir(): Promise<string> {
  const home = os.homedir()
  const defaultDir = path.join(home, ".claude")

  if (process.platform === "darwin" || process.platform === "win32") {
    return defaultDir
  }

  // Linux: prefer ~/.claude if exists, else ~/.config/claude
  const exists = await fs
    .access(defaultDir)
    .then(() => true)
    .catch(() => false)
  return exists ? defaultDir : path.join(home, ".config", "claude")
}

async function mergeHooks(sourceSettingsContent: string, targetSettingsPath: string): Promise<number> {
  const sourceData = JSON.parse(sourceSettingsContent)
  const sourceHooks: Record<string, any[]> = sourceData.hooks ?? {}

  let targetData: Record<string, any> = {}
  const targetExists = await fs
    .access(targetSettingsPath)
    .then(() => true)
    .catch(() => false)
  if (targetExists) {
    const targetRaw = await fs.readFile(targetSettingsPath, "utf-8")
    targetData = JSON.parse(targetRaw)
  }

  const targetHooks: Record<string, any[]> = (targetData.hooks ??= {})
  let mergedCount = 0

  for (const [event, entries] of Object.entries(sourceHooks)) {
    if (!targetHooks[event]) {
      targetHooks[event] = entries
      mergedCount += entries.length
    } else {
      // Collect all existing command strings for this event
      const existingCommands = new Set<string>()
      for (const entry of targetHooks[event]) {
        for (const hook of entry.hooks ?? []) {
          if (hook.command) existingCommands.add(hook.command)
        }
      }

      // Append source entries whose commands aren't already present
      for (const entry of entries) {
        const entryCommands = new Set((entry.hooks ?? []).map((h: any) => h.command).filter(Boolean))
        const hasOverlap = [...entryCommands].some((cmd) => existingCommands.has(cmd))
        if (!hasOverlap) {
          targetHooks[event].push(entry)
          mergedCount++
        }
      }
    }
  }

  await fs.mkdir(path.dirname(targetSettingsPath), { recursive: true })
  await fs.writeFile(targetSettingsPath, JSON.stringify(targetData, null, 2))
  return mergedCount
}

async function mergeEnvFile(envPath: string, vars: Record<string, string>): Promise<void> {
  const existing: Record<string, string> = {}

  const fileExists = await fs
    .access(envPath)
    .then(() => true)
    .catch(() => false)
  if (fileExists) {
    const content = await fs.readFile(envPath, "utf-8")
    for (const line of content.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eqIdx = trimmed.indexOf("=")
      if (eqIdx === -1) continue
      const key = trimmed.slice(0, eqIdx).trim()
      const value = trimmed.slice(eqIdx + 1).trim()
      existing[key] = value
    }
  }

  Object.assign(existing, vars)
  await fs.writeFile(envPath, Object.entries(existing).map(([k, v]) => `${k}=${v}`).join("\n") + "\n")
}

const InstallSubcommand = cmd({
  command: "install",
  describe: "install Langfuse logging hooks into ~/.claude",
  handler: async () => {
    prompts.intro("Altimate Validate — Hook Installer")

    const claudeDir = await getClaudeDir()
    prompts.log.info(`Target directory: ${claudeDir}`)

    const { loggerContent, settingsContent, skillMd, batchPy } = await getAssets()

    // 1. Write langfuse_logger.py to ~/.claude/hooks/
    const spinner = prompts.spinner()
    spinner.start("Installing langfuse_logger.py...")
    const hooksTargetDir = path.join(claudeDir, "hooks")
    await fs.mkdir(hooksTargetDir, { recursive: true })
    const loggerTarget = path.join(hooksTargetDir, "langfuse_logger.py")
    await fs.writeFile(loggerTarget, loggerContent)
    spinner.stop(`Installed langfuse_logger.py → ${loggerTarget}`)

    // 2. Merge hooks into ~/.claude/settings.json
    spinner.start("Merging hook config into settings.json...")
    const targetSettings = path.join(claudeDir, "settings.json")
    const added = await mergeHooks(settingsContent, targetSettings)
    spinner.stop(`settings.json updated (${added} new hook entries added)`)

    // 3. Write skill files to ~/.altimate-code/skills/validate/
    spinner.start("Installing /validate skill...")
    const skillTargetDir = path.join(os.homedir(), ".altimate-code", "skills", "validate")
    await fs.mkdir(skillTargetDir, { recursive: true })
    await fs.writeFile(path.join(skillTargetDir, "SKILL.md"), skillMd)
    await fs.writeFile(path.join(skillTargetDir, "batch_validate.py"), batchPy)
    spinner.stop(`Installed /validate skill → ${skillTargetDir}`)

    // 3. Prompt for Langfuse credentials
    prompts.log.message("")
    const configureLangfuse = await prompts.confirm({
      message: "Do you have a Langfuse account and want to configure your own credentials?",
      initialValue: false,
    })

    if (!prompts.isCancel(configureLangfuse) && configureLangfuse) {
      const secretKey = await prompts.text({
        message: "LANGFUSE_SECRET_KEY_VALIDATION:",
        placeholder: "sk-lf-...",
      })
      const publicKey = await prompts.text({
        message: "LANGFUSE_PUBLIC_KEY_VALIDATION:",
        placeholder: "pk-lf-...",
      })
      const baseUrl = await prompts.text({
        message: "LANGFUSE_BASE_URL_VALIDATION:",
        placeholder: "https://cloud.langfuse.com",
        defaultValue: "https://cloud.langfuse.com",
      })

      if (!prompts.isCancel(secretKey) && !prompts.isCancel(publicKey) && !prompts.isCancel(baseUrl)) {
        spinner.start("Writing Langfuse credentials to ~/.claude/.env...")
        const envPath = path.join(claudeDir, ".env")
        await mergeEnvFile(envPath, {
          LANGFUSE_SECRET_KEY_VALIDATION: secretKey as string,
          LANGFUSE_PUBLIC_KEY_VALIDATION: publicKey as string,
          LANGFUSE_BASE_URL_VALIDATION: (baseUrl as string) || "https://cloud.langfuse.com",
        })
        spinner.stop(`Credentials written to ${envPath}`)
      }
    } else {
      prompts.log.info("Skipping Langfuse configuration — default keys will be used.")
    }

    prompts.outro("Altimate validation hooks installed successfully!")
  },
})

const StatusSubcommand = cmd({
  command: "status",
  describe: "check whether Langfuse hooks are installed",
  handler: async () => {
    const claudeDir = await getClaudeDir()
    const loggerPath = path.join(claudeDir, "hooks", "langfuse_logger.py")
    const settingsPath = path.join(claudeDir, "settings.json")
    const envPath = path.join(claudeDir, ".env")
    const skillDir = path.join(os.homedir(), ".altimate-code", "skills", "validate")

    prompts.intro("Altimate Validate — Installation Status")

    const check = (exists: boolean, label: string, detail: string) =>
      prompts.log.info(`${exists ? "✓" : "✗"} ${label}${exists ? "" : " (not found)"}: ${detail}`)

    // Hooks
    check(
      await fs.access(loggerPath).then(() => true).catch(() => false),
      "langfuse_logger.py",
      loggerPath,
    )

    const settingsExists = await fs.access(settingsPath).then(() => true).catch(() => false)
    if (settingsExists) {
      const data = JSON.parse(await fs.readFile(settingsPath, "utf-8"))
      const hooks = data.hooks ?? {}
      const events = ["UserPromptSubmit", "PostToolUse", "Stop"]
      const configured = events.filter((e) => Array.isArray(hooks[e]) && hooks[e].length > 0)
      prompts.log.info(`${configured.length === 3 ? "✓" : "✗"} hook entries: ${configured.length}/3 configured in ${settingsPath}`)
    } else {
      prompts.log.info(`✗ settings.json: not found (${settingsPath})`)
    }

    const envExists = await fs.access(envPath).then(() => true).catch(() => false)
    if (envExists) {
      const hasKey = (await fs.readFile(envPath, "utf-8")).includes("LANGFUSE_PUBLIC_KEY_VALIDATION")
      check(hasKey, "Langfuse credentials", envPath)
    } else {
      prompts.log.info(`✗ Langfuse credentials: .env not found (${envPath})`)
    }

    // Skill
    const skillMdExists = await fs.access(path.join(skillDir, "SKILL.md")).then(() => true).catch(() => false)
    const batchPyExists = await fs.access(path.join(skillDir, "batch_validate.py")).then(() => true).catch(() => false)
    check(skillMdExists && batchPyExists, "/validate skill", skillDir)

    prompts.outro("Done")
  },
})

export const ValidateCommand = cmd({
  command: "validate",
  describe: "manage the Altimate validation framework (Langfuse hooks + /validate skill)",
  builder: (yargs: Argv) => yargs.command(InstallSubcommand).command(StatusSubcommand).demandCommand(),
  handler: () => {},
})
