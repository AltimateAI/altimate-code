import { homedir } from "os"
import { join } from "path"
import { readFile, writeFile, mkdir } from "fs/promises"
import { existsSync } from "fs"

type Config = {
  projectRoot: string
  pythonPath: string
  dbtIntegration: string
  queryLimit: number
}

function configDir() {
  return join(process.env.HOME || homedir(), ".altimate-code")
}

function configPath() {
  return join(configDir(), "dbt.json")
}

async function read(): Promise<Config | null> {
  const p = configPath()
  if (!existsSync(p)) return null
  const raw = await readFile(p, "utf-8")
  return JSON.parse(raw) as Config
}

async function write(cfg: Config) {
  const d = configDir()
  await mkdir(d, { recursive: true })
  await writeFile(join(d, "dbt.json"), JSON.stringify(cfg, null, 2))
}

export { read, write, configPath as path, type Config }
