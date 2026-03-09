import { minimatch } from "minimatch"
import { git, conflictedFiles } from "../utils/git"
import { loadConfig } from "../utils/config"

/**
 * For conflicted files matching keepOurs patterns, resolve by keeping our version.
 * These are files entirely written by us (e.g., src/altimate/**, packages/altimate-engine/**).
 */
export function resolveKeepOurs(): { resolved: string[]; skipped: string[] } {
  const config = loadConfig()
  const conflicts = conflictedFiles()
  const resolved: string[] = []
  const skipped: string[] = []

  for (const file of conflicts) {
    const shouldKeep = config.keepOurs.some((pattern) => minimatch(file, pattern))
    if (shouldKeep) {
      git(`checkout --ours -- "${file}"`)
      git(`add "${file}"`)
      resolved.push(file)
    } else {
      skipped.push(file)
    }
  }

  return { resolved, skipped }
}
