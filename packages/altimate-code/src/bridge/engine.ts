/**
 * Engine bootstrap — downloads uv, creates an isolated Python venv,
 * and installs the altimate-engine package.
 *
 * Directory layout (under Global.Path.data):
 *   engine/
 *     bin/uv              <- uv binary
 *     venv/               <- isolated Python venv
 *       bin/python         <- Python interpreter (unix)
 *       Scripts/python.exe <- Python interpreter (windows)
 *     manifest.json       <- version metadata
 */

import { execFileSync } from "child_process"
import { existsSync } from "fs"
import fs from "fs/promises"
import path from "path"
import { Global } from "../global"
import { UI } from "../cli/ui"

declare const ALTIMATE_ENGINE_VERSION: string
declare const ALTIMATE_CLI_VERSION: string

// Mutex to prevent concurrent ensureEngine/ensureUv calls from corrupting state
let pendingEnsure: Promise<void> | null = null

interface Manifest {
  engine_version: string
  python_version: string
  uv_version: string
  cli_version: string
  installed_at: string
}

/** Returns path to the engine directory */
export function engineDir(): string {
  return path.join(Global.Path.data, "engine")
}

/** Returns path to python binary inside the managed venv */
export function enginePythonPath(): string {
  const dir = engineDir()
  return process.platform === "win32"
    ? path.join(dir, "venv", "Scripts", "python.exe")
    : path.join(dir, "venv", "bin", "python")
}

/** Returns path to the uv binary */
function uvPath(): string {
  const dir = engineDir()
  return process.platform === "win32"
    ? path.join(dir, "bin", "uv.exe")
    : path.join(dir, "bin", "uv")
}

/** Read manifest.json or null */
async function readManifest(): Promise<Manifest | null> {
  const manifestPath = path.join(engineDir(), "manifest.json")
  try {
    const text = await fs.readFile(manifestPath, "utf-8")
    return JSON.parse(text) as Manifest
  } catch {
    return null
  }
}

/** Write manifest.json */
async function writeManifest(manifest: Manifest): Promise<void> {
  const manifestPath = path.join(engineDir(), "manifest.json")
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2))
}

/** Downloads uv binary if not present */
export async function ensureUv(): Promise<void> {
  const uv = uvPath()
  if (existsSync(uv)) return

  // Determine platform-specific download URL
  const platform = process.platform
  const arch = process.arch
  let asset: string
  if (platform === "darwin" && arch === "arm64") asset = "uv-aarch64-apple-darwin.tar.gz"
  else if (platform === "darwin" && arch === "x64") asset = "uv-x86_64-apple-darwin.tar.gz"
  else if (platform === "linux" && arch === "arm64") asset = "uv-aarch64-unknown-linux-gnu.tar.gz"
  else if (platform === "linux" && arch === "x64") asset = "uv-x86_64-unknown-linux-gnu.tar.gz"
  else if (platform === "win32" && arch === "x64") asset = "uv-x86_64-pc-windows-msvc.zip"
  else throw new Error(`Unsupported platform: ${platform}-${arch}`)

  const url = `https://github.com/astral-sh/uv/releases/latest/download/${asset}`

  UI.println(`${UI.Style.TEXT_DIM}Downloading uv...${UI.Style.TEXT_NORMAL}`)

  const dir = engineDir()
  await fs.mkdir(path.join(dir, "bin"), { recursive: true })

  const response = await fetch(url)
  if (!response.ok) throw new Error(`Failed to download uv: ${response.statusText}`)
  const buffer = Buffer.from(await response.arrayBuffer())

  const tmpFile = path.join(dir, "bin", asset)
  await fs.writeFile(tmpFile, buffer)

  // Extract: tar.gz on unix, zip on windows
  if (asset.endsWith(".tar.gz")) {
    // Use tar to extract, the binary is inside a directory named like "uv-aarch64-apple-darwin"
    execFileSync("tar", ["-xzf", tmpFile, "-C", path.join(dir, "bin")])
    // The extracted dir has the same name as the asset minus .tar.gz
    const extractedDir = path.join(dir, "bin", asset.replace(".tar.gz", ""))
    // Move uv binary from extracted dir to engine/bin/uv
    await fs.rename(path.join(extractedDir, "uv"), uv)
    // Cleanup
    await fs.rm(extractedDir, { recursive: true, force: true })
  } else {
    // Windows zip handling
    execFileSync("powershell", [
      "-Command",
      `Expand-Archive -Path '${tmpFile}' -DestinationPath '${path.join(dir, "bin")}' -Force`,
    ])
    const extractedDir = path.join(dir, "bin", asset.replace(".zip", ""))
    await fs.rename(path.join(extractedDir, "uv.exe"), uv)
    await fs.rm(extractedDir, { recursive: true, force: true })
  }

  // Cleanup temp archive
  await fs.rm(tmpFile, { force: true })

  // Make executable on unix
  if (process.platform !== "win32") {
    await fs.chmod(uv, 0o755)
  }

  UI.println(`${UI.Style.TEXT_SUCCESS}uv installed${UI.Style.TEXT_NORMAL}`)
}

/** Creates venv + installs altimate-engine. Upgrades on version mismatch.
 *  Uses a promise-based mutex so concurrent callers coalesce into one operation. */
export async function ensureEngine(): Promise<void> {
  if (pendingEnsure) return pendingEnsure
  pendingEnsure = ensureEngineImpl()
  try {
    await pendingEnsure
  } finally {
    pendingEnsure = null
  }
}

async function ensureEngineImpl(): Promise<void> {
  const manifest = await readManifest()
  if (manifest && manifest.engine_version === ALTIMATE_ENGINE_VERSION) return

  await ensureUv()

  const uv = uvPath()
  const dir = engineDir()
  const venvDir = path.join(dir, "venv")

  // Create venv if it doesn't exist
  if (!existsSync(venvDir)) {
    UI.println(`${UI.Style.TEXT_DIM}Creating Python environment...${UI.Style.TEXT_NORMAL}`)
    execFileSync(uv, ["venv", "--python", "3.12", venvDir])
  }

  // Install/upgrade engine
  const pythonPath = enginePythonPath()
  UI.println(`${UI.Style.TEXT_DIM}Installing altimate-engine ${ALTIMATE_ENGINE_VERSION}...${UI.Style.TEXT_NORMAL}`)
  execFileSync(uv, ["pip", "install", "--python", pythonPath, `altimate-engine==${ALTIMATE_ENGINE_VERSION}`])

  // Get python version
  const pyVersion = execFileSync(pythonPath, ["--version"]).toString().trim()
  // Get uv version
  const uvVersion = execFileSync(uv, ["--version"]).toString().trim()

  await writeManifest({
    engine_version: ALTIMATE_ENGINE_VERSION,
    python_version: pyVersion,
    uv_version: uvVersion,
    cli_version: typeof ALTIMATE_CLI_VERSION === "string" ? ALTIMATE_CLI_VERSION : "local",
    installed_at: new Date().toISOString(),
  })

  UI.println(`${UI.Style.TEXT_SUCCESS}Engine ready${UI.Style.TEXT_NORMAL}`)
}

/** Returns current engine status */
export async function engineStatus(): Promise<{
  path: string
  uvInstalled: boolean
  pythonVersion: string | null
  engineVersion: string | null
  cliVersion: string | null
  installedAt: string | null
}> {
  const dir = engineDir()
  const manifest = await readManifest()
  return {
    path: dir,
    uvInstalled: existsSync(uvPath()),
    pythonVersion: manifest?.python_version ?? null,
    engineVersion: manifest?.engine_version ?? null,
    cliVersion: manifest?.cli_version ?? null,
    installedAt: manifest?.installed_at ?? null,
  }
}

/** Removes and reinstalls everything */
export async function resetEngine(): Promise<void> {
  const dir = engineDir()
  await fs.rm(dir, { recursive: true, force: true })
  await ensureEngine()
}
