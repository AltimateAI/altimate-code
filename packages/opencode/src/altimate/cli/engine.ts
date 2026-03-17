import type { Argv } from "yargs"
import { cmd } from "../../cli/cmd/cmd"
import { UI } from "../../cli/ui"

const StatusCommand = cmd({
  command: "status",
  describe: "show engine status",
  handler: async () => {
    UI.println(`${UI.Style.TEXT_NORMAL_BOLD}Engine Status${UI.Style.TEXT_NORMAL}`)
    UI.println(`  Mode: native TypeScript (no Python dependency)`)
    UI.println(`  All 73 methods running natively via @altimateai/altimate-core`)
  },
})

const ResetCommand = cmd({
  command: "reset",
  describe: "reset engine state",
  handler: async () => {
    UI.println("No Python engine to reset — all methods run natively in TypeScript.")
  },
})

const PathCommand = cmd({
  command: "path",
  describe: "print engine directory path (deprecated)",
  handler: async () => {
    UI.println("No engine directory — Python bridge has been replaced with native TypeScript.")
  },
})

export const EngineCommand = cmd({
  command: "engine",
  describe: "manage the engine",
  builder: (yargs: Argv) => {
    return yargs.command(StatusCommand).command(ResetCommand).command(PathCommand).demandCommand()
  },
  handler: () => {},
})
