// altimate: ALT-F01
import { defaults, Identity } from "@opencode/util/identity"

declare const OPENCODE_CLI_NAME: string | undefined

// Stock builds can retain their build-time executable alias; branded descriptors own their executable name.
export const cliName = Identity === defaults && typeof OPENCODE_CLI_NAME === "string" ? OPENCODE_CLI_NAME : Identity.app
