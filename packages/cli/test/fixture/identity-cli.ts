// altimate: ALT-F01
import { authenticationMethod } from "../../src/acp/service"
import { portInUseError } from "../../src/server-process"
import { remoteWarning } from "../../src/commands/handlers/pair"
import { INTERACTIVE_INPUT_ERROR } from "../../src/mini-host"
import { cliName } from "../../src/identity"

const cause = new Error("EADDRINUSE")
const conflict = portInUseError(55555, "127.0.0.1", cause)
console.log(
  JSON.stringify({
    cliName,
    conflict: conflict.message,
    preservesCause: conflict.cause === cause,
    auth: authenticationMethod({ _meta: { "terminal-auth": true } }),
    standardAuth: authenticationMethod({ auth: { terminal: true } }),
    plainAuth: authenticationMethod(undefined),
    remoteWarning,
    interactiveError: INTERACTIVE_INPUT_ERROR,
  }),
)
