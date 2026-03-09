import { git, conflictedFiles } from "../utils/git"
import { execSync } from "child_process"
import { repoRoot } from "../utils/config"

/**
 * For lock files (bun.lock), accept ours during merge, then regenerate.
 */
export function resolveLockFiles(): string[] {
  const conflicts = conflictedFiles()
  const resolved: string[] = []

  for (const file of conflicts) {
    if (file === "bun.lock" || file.endsWith("/bun.lock")) {
      git(`checkout --ours -- "${file}"`)
      git(`add "${file}"`)
      resolved.push(file)
    }
  }

  return resolved
}

/**
 * Regenerate the lock file after merge is complete.
 */
export function regenerateLockFile(): void {
  console.log("  Regenerating bun.lock...")
  execSync("bun install", {
    cwd: repoRoot(),
    stdio: "inherit",
  })
  git("add bun.lock")
}
