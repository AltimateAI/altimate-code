// altimate_change start — #1052 D10 bot-review fix: shared build-input walk.
//
// The build stamp and the smoke-test staleness guard have to agree on exactly
// which files count as a build input. When the walk lived only inside build.ts,
// the guard could rehash the paths the stamp listed but had no way to notice a
// file ADDED after the build — a new module under any walked root left the
// binary stale while the guard stayed silent. Sharing the walk lets the guard
// re-enumerate with identical rules and compare sets, not just hashes.
import fs from "fs"
import path from "path"

/** Directories never part of a build input set. */
export const IGNORED_DIRS = new Set(["node_modules", ".turbo", ".cache", "dist", "target"])

/** Extensions Bun.build can pull into the binary from a walked source tree. */
export const INPUT_EXTENSIONS = /\.(tsx?|json|txt|md)$/

/**
 * Absolute paths of every input file under `root`, applying the shared rules.
 * Missing roots yield an empty list — callers treat that as "nothing to add".
 */
export function walkInputs(root: string): string[] {
  const found: string[] = []
  const walk = (current: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue
      if (IGNORED_DIRS.has(entry.name)) continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!INPUT_EXTENSIONS.test(entry.name)) continue
      found.push(full)
    }
  }
  walk(root)
  return found
}
// altimate_change end
