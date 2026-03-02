import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { UI } from "../ui"

const StatusCommand = cmd({
  command: "status",
  describe: "show engine status (uv, Python, engine versions)",
  handler: async () => {
    const { engineStatus } = await import("../../bridge/engine")
    const status = await engineStatus()
    UI.println(`${UI.Style.TEXT_NORMAL_BOLD}Engine Status${UI.Style.TEXT_NORMAL}`)
    UI.println(`  Path:           ${status.path}`)
    UI.println(`  uv installed:   ${status.uvInstalled ? "yes" : "no"}`)
    UI.println(`  Python version: ${status.pythonVersion ?? "not installed"}`)
    UI.println(`  Engine version: ${status.engineVersion ?? "not installed"}`)
    UI.println(`  CLI version:    ${status.cliVersion ?? "n/a"}`)
    UI.println(`  Installed at:   ${status.installedAt ?? "n/a"}`)
  },
})

const ResetCommand = cmd({
  command: "reset",
  describe: "remove engine directory and reinstall from scratch",
  handler: async () => {
    const { resetEngine } = await import("../../bridge/engine")
    UI.println("Resetting engine...")
    await resetEngine()
    UI.println(`${UI.Style.TEXT_SUCCESS}Engine reset complete${UI.Style.TEXT_NORMAL}`)
  },
})

const PathCommand = cmd({
  command: "path",
  describe: "print engine directory path",
  handler: async () => {
    const { engineDir } = await import("../../bridge/engine")
    console.log(engineDir())
  },
})

export const EngineCommand = cmd({
  command: "engine",
  describe: "manage the Python engine",
  builder: (yargs: Argv) => {
    return yargs.command(StatusCommand).command(ResetCommand).command(PathCommand).demandCommand()
  },
  handler: () => {},
})
