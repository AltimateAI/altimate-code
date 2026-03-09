import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export interface MergeConfig {
  keepOurs: string[]
  skipFiles: string[]
  packageMappings: Record<string, string>
  changeMarker: string
  upstreamRemote: string
  upstreamBranch: string
}

let _config: MergeConfig | null = null

export function loadConfig(): MergeConfig {
  if (_config) return _config
  const configPath = path.join(__dirname, "..", "merge-config.json")
  _config = JSON.parse(fs.readFileSync(configPath, "utf-8"))
  return _config!
}

export function repoRoot(): string {
  // Walk up from script/upstream/utils/ to repo root
  return path.resolve(__dirname, "..", "..", "..")
}
