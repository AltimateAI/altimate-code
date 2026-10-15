import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// The SDK captures XDG roots at import time; isolate its auxiliary files from the user's installation.
const directory = mkdtempSync(join(tmpdir(), "altimate-sdk-environment-"))
process.env.XDG_DATA_HOME = join(directory, "data")
process.env.XDG_CACHE_HOME = join(directory, "cache")
process.env.XDG_CONFIG_HOME = join(directory, "config")
process.env.XDG_STATE_HOME = join(directory, "state")
process.env.OPENCODE_TEST_HOME = directory

process.once("exit", () => rmSync(directory, { recursive: true, force: true }))
