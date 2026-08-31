import os from "node:os"
import path from "node:path"
import fs from "node:fs/promises"

export interface LocalPaths {
  root: string
  bin: string
  models: string
  downloads: string
  certificates: string
  state: string
  pid: string
  log: string
  environment: string
  recipes: string
  recipesMeta: string
}

export function getLocalPaths(
  env: NodeJS.ProcessEnv = process.env,
  home = env.OPENCODE_TEST_HOME || os.homedir(),
): LocalPaths {
  const data = env.XDG_DATA_HOME || path.join(home, ".local", "share")
  const root = path.join(data, "altimate-code", "local")
  return {
    root,
    bin: path.join(root, "bin"),
    models: path.join(root, "models"),
    downloads: path.join(root, "downloads"),
    certificates: path.join(root, "certificates"),
    state: path.join(root, "state.json"),
    pid: path.join(root, "server.pid"),
    log: path.join(root, "server.log"),
    environment: path.join(root, "environment.json"),
    recipes: path.join(root, "recipes.json"),
    recipesMeta: path.join(root, "recipes.meta.json"),
  }
}

export async function ensureLocalDirectories(paths = getLocalPaths()) {
  await Promise.all([
    fs.mkdir(paths.root, { recursive: true }),
    fs.mkdir(paths.bin, { recursive: true }),
    fs.mkdir(paths.models, { recursive: true }),
    fs.mkdir(paths.downloads, { recursive: true }),
    fs.mkdir(paths.certificates, { recursive: true }),
  ])
}
