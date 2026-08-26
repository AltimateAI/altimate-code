import fs from "node:fs"
import fsPromises from "node:fs/promises"

import { ensureLocalDirectories, getLocalPaths, type LocalPaths } from "./paths"

interface LocalEnvironment {
  schema: 1
  tool_retrieval: boolean
  // Whether the last `altimate local` setup wired the web-tool egress guard.
  // Absent on files written before the guard existed.
  egress_guard?: boolean
}

export function applyLocalEnvironment(env: NodeJS.ProcessEnv = process.env, paths = getLocalPaths(env)) {
  try {
    const settings = JSON.parse(fs.readFileSync(paths.environment, "utf8")) as LocalEnvironment
    if (settings.schema === 1 && settings.tool_retrieval && env.ALTIMATE_TOOL_RETRIEVAL === undefined) {
      env.ALTIMATE_TOOL_RETRIEVAL = "1"
    }
  } catch {
    // A missing or malformed optional local environment file must not affect
    // unrelated CLI commands. `altimate local` rewrites it during setup.
  }
}

// Read-only view of the environment file written by the LAST `altimate local`
// setup, used to tell whether a prior wiring actually applied the egress guard
// (as opposed to a value the user set some other way) before removing it.
export async function readLocalEnvironment(paths: LocalPaths): Promise<LocalEnvironment | undefined> {
  try {
    return JSON.parse(await fsPromises.readFile(paths.environment, "utf8")) as LocalEnvironment
  } catch {
    return undefined
  }
}

export async function writeLocalEnvironment(toolRetrieval: boolean, paths: LocalPaths, egressGuard?: boolean) {
  await ensureLocalDirectories(paths)
  const temp = `${paths.environment}.${process.pid}.tmp`
  const settings: LocalEnvironment = { schema: 1, tool_retrieval: toolRetrieval, egress_guard: egressGuard }
  await fsPromises.writeFile(temp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 })
  await fsPromises.rename(temp, paths.environment)
}
