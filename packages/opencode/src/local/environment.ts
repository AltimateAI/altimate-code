import fs from "node:fs"
import fsPromises from "node:fs/promises"

import { ensureLocalDirectories, getLocalPaths, type LocalPaths } from "./paths"

interface LocalEnvironment {
  schema: 1
  tool_retrieval: boolean
  // Whether the last `altimate local` setup wired the web-tool egress guard.
  // Absent on files written before the guard existed.
  egress_guard?: boolean
  // Exact permission keys THIS wiring added under the egress guard (not
  // merely "guard was on"). Lets --no-egress-guard remove only what it
  // actually added instead of guessing from the boolean alone, which would
  // otherwise delete a user-set "ask" rule the guard skipped adding (see
  // wireLocalProvider in wire.ts). Absent on files written before this field
  // existed — callers fall back to the coarser boolean heuristic for those.
  guarded_permissions?: string[]
}

// Basic shape validation for a file this subsystem is the only writer of,
// but which could still be corrupted, hand-edited, or (in principle) shared
// with an unrelated tool that happens to produce JSON with an
// `egress_guard: true` field. Trusting an unvalidated object here would let
// that field silently grant guard-removal ownership it never earned.
function isLocalEnvironment(value: unknown): value is LocalEnvironment {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  if (v.schema !== 1) return false
  if (typeof v.tool_retrieval !== "boolean") return false
  if (v.egress_guard !== undefined && typeof v.egress_guard !== "boolean") return false
  if (v.guarded_permissions !== undefined) {
    if (!Array.isArray(v.guarded_permissions) || !v.guarded_permissions.every((k) => typeof k === "string"))
      return false
  }
  return true
}

export function applyLocalEnvironment(env: NodeJS.ProcessEnv = process.env, paths = getLocalPaths(env)) {
  try {
    const settings = JSON.parse(fs.readFileSync(paths.environment, "utf8")) as unknown
    if (isLocalEnvironment(settings) && settings.tool_retrieval === true && env.ALTIMATE_TOOL_RETRIEVAL === undefined) {
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
    const parsed = JSON.parse(await fsPromises.readFile(paths.environment, "utf8")) as unknown
    return isLocalEnvironment(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export async function writeLocalEnvironment(
  toolRetrieval: boolean,
  paths: LocalPaths,
  egressGuard?: boolean,
  guardedPermissions?: string[],
) {
  await ensureLocalDirectories(paths)
  const temp = `${paths.environment}.${process.pid}.tmp`
  const settings: LocalEnvironment = {
    schema: 1,
    tool_retrieval: toolRetrieval,
    egress_guard: egressGuard,
    guarded_permissions: guardedPermissions,
  }
  await fsPromises.writeFile(temp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 })
  await fsPromises.rename(temp, paths.environment)
}
