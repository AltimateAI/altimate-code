// altimate_change - new file
import { cmd } from "./cmd"
import { UI } from "../ui"

/** What a workspace command says when `ALTIMATE_DISABLE_WORKSPACE` is set. Registered hidden in its
 * place: unregistered, `altimate-code link` fell through to the default command, which read
 * "link" as a project directory and failed with "Failed to change directory to …/link". */
export const WORKSPACE_PILOT_OFF_MESSAGE =
  "Workspaces are turned off because ALTIMATE_DISABLE_WORKSPACE is set. Unset it to use this command."

export function pilotOffCommand(command: string) {
  return cmd({
    command,
    describe: false,
    builder: (yargs) => yargs.strict(false),
    handler: () => {
      UI.error(WORKSPACE_PILOT_OFF_MESSAGE)
      process.exitCode = 1
    },
  })
}
