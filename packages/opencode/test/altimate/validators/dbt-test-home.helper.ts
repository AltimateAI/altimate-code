import { afterEach, beforeEach, expect } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

function fingerprint(path: string) {
  const stat = statSync(path, { throwIfNoEntry: false, bigint: true })
  if (!stat) return undefined
  return { mtime: stat.mtimeNs, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") }
}

// Register the guard independently of project setup so it catches a missing
// isolation call as well as a child process that ignores the supplied HOME.
export function useDbtTestHome() {
  const keys = ["HOME", "XDG_CONFIG_HOME", "DBT_PROFILES_DIR"] as const
  let original: typeof process.env
  let configPath: string
  let config: ReturnType<typeof fingerprint>

  beforeEach(() => {
    original = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
    configPath = join(homedir(), ".altimate-code", "dbt.json")
    config = fingerprint(configPath)
  })

  afterEach(() => {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key]
      else process.env[key] = original[key]
    }
    expect(fingerprint(configPath)).toEqual(config)
  })

  return (dir: string) => {
    const home = join(dir, "home")
    const configHome = join(home, ".config")
    mkdirSync(configHome, { recursive: true })
    process.env.HOME = home
    process.env.XDG_CONFIG_HOME = configHome
  }
}
