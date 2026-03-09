import { minimatch } from "minimatch"
import { git, conflictedFiles } from "../utils/git"
import { loadConfig } from "../utils/config"

/**
 * For conflicted files matching skipFiles patterns, resolve by accepting upstream's version.
 * These are upstream packages we don't modify — we keep them to avoid merge friction.
 */
export function resolveSkipFiles(): { resolved: string[]; skipped: string[] } {
  const config = loadConfig()
  const conflicts = conflictedFiles()
  const resolved: string[] = []
  const skipped: string[] = []

  for (const file of conflicts) {
    const shouldSkip = config.skipFiles.some((pattern) => minimatch(file, pattern))
    if (shouldSkip) {
      // Accept upstream's version — we don't modify these files
      git(`checkout --theirs "${file}"`)
      git(`add "${file}"`)
      resolved.push(file)
    } else {
      skipped.push(file)
    }
  }

  return { resolved, skipped }
}
