import type { Argv } from "yargs"
import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import fs from "fs/promises"
import path from "path"
import os from "os"

// Injected at build time by build.ts (same pattern as ALTIMATE_CLI_MIGRATIONS).
// In development these fall back to reading from disk via getAssets().
declare const ALTIMATE_VALIDATE_SKILL_MD: string
declare const ALTIMATE_VALIDATE_BATCH_PY: string

interface ValidateAssets {
  skillMd: string
  batchPy: string
}

async function getAssets(): Promise<ValidateAssets> {
  if (
    typeof ALTIMATE_VALIDATE_SKILL_MD !== "undefined" &&
    typeof ALTIMATE_VALIDATE_BATCH_PY !== "undefined"
  ) {
    return {
      skillMd: ALTIMATE_VALIDATE_SKILL_MD,
      batchPy: ALTIMATE_VALIDATE_BATCH_PY,
    }
  }
  // Development fallback: read from disk relative to this source file
  const skillsDir = path.join(import.meta.dir, "../../skills/validate")
  const [skillMd, batchPy] = await Promise.all([
    fs.readFile(path.join(skillsDir, "SKILL.md"), "utf-8"),
    fs.readFile(path.join(skillsDir, "batch_validate.py"), "utf-8"),
  ])
  return { skillMd, batchPy }
}



const InstallSubcommand = cmd({
  command: "install",
  describe: "install the /validate skill into ~/.altimate-code",
  handler: async () => {
    prompts.intro("Altimate Validate — Installer")

    const { skillMd, batchPy } = await getAssets()

    const spinner = prompts.spinner()
    spinner.start("Installing /validate skill...")
    const skillTargetDir = path.join(os.homedir(), ".altimate-code", "skills", "validate")
    await fs.mkdir(skillTargetDir, { recursive: true })
    await fs.writeFile(path.join(skillTargetDir, "SKILL.md"), skillMd)
    await fs.writeFile(path.join(skillTargetDir, "batch_validate.py"), batchPy)
    spinner.stop(`Installed /validate skill → ${skillTargetDir}`)

    prompts.outro("Altimate validation skill installed successfully!")
  },
})

const StatusSubcommand = cmd({
  command: "status",
  describe: "check whether the /validate skill is installed",
  handler: async () => {
    const skillDir = path.join(os.homedir(), ".altimate-code", "skills", "validate")

    prompts.intro("Altimate Validate — Installation Status")

    const check = (exists: boolean, label: string, detail: string) =>
      prompts.log.info(`${exists ? "✓" : "✗"} ${label}${exists ? "" : " (not found)"}: ${detail}`)

    const skillMdExists = await fs.access(path.join(skillDir, "SKILL.md")).then(() => true).catch(() => false)
    const batchPyExists = await fs.access(path.join(skillDir, "batch_validate.py")).then(() => true).catch(() => false)
    check(skillMdExists && batchPyExists, "/validate skill", skillDir)

    prompts.outro("Done")
  },
})

export const ValidateCommand = cmd({
  command: "validate",
  describe: "manage the Altimate validation framework (/validate skill)",
  builder: (yargs: Argv) => yargs.command(InstallSubcommand).command(StatusSubcommand).demandCommand(),
  handler: () => {},
})
