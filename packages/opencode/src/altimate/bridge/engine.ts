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
import { Global } from "../../global"
import { Log } from "../../util/log"
import { Telemetry } from "@/telemetry"

declare const ALTIMATE_ENGINE_VERSION: string
declare const OPENCODE_VERSION: string

// Mutex to prevent concurrent ensureEngine/ensureUv calls from corrupting state
let pendingEnsure: Promise<void> | null = null

/** Pip extras spec for altimate-engine (e.g. "warehouses" → altimate-engine[warehouses]).
 *  Used in ensureEngine install command and recorded in manifest for upgrade detection. */
export const ENGINE_INSTALL_SPEC = "warehouses"

interface Manifest {
  engine_version: string
  python_version: string
  uv_version: string
  cli_version: string
  installed_at: string
  /** Comma-separated extras that were installed (e.g. "warehouses") */
  extras?: string
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

  Log.Default.info("downloading uv")

  const dir = engineDir()
  await fs.mkdir(path.join(dir, "bin"), { recursive: true })

  const response = await fetch(url)
  if (!response.ok) {
    const errMsg = `Failed to download uv: ${response.statusText}`
    Telemetry.track({
      type: "engine_error",
      timestamp: Date.now(),
      session_id: Telemetry.getContext().sessionId,
      phase: "uv_download",
      error_message: errMsg.slice(0, 500),
    })
    throw new Error(errMsg)
  }
  const buffer = Buffer.from(await response.arrayBuffer())

  const tmpFile = path.join(dir, "bin", asset)
  await fs.writeFile(tmpFile, buffer)

  // Extract: tar.gz on unix, zip on windows
  if (asset.endsWith(".tar.gz")) {
    // Use tar to extract, the binary is inside a directory named like "uv-aarch64-apple-darwin"
    execFileSync("tar", ["-xzf", tmpFile, "-C", path.join(dir, "bin")], { stdio: "pipe" })
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
    ], { stdio: "pipe" })
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

  Log.Default.info("uv installed")
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
  const isUpgrade = manifest !== null

  // Validate both version AND filesystem state — a matching version in the
  // manifest is not enough if the venv or Python binary was deleted.
  const pythonExists = existsSync(enginePythonPath())
  const extrasMatch = (manifest?.extras ?? "") === ENGINE_INSTALL_SPEC
  if (manifest && manifest.engine_version === ALTIMATE_ENGINE_VERSION && pythonExists && extrasMatch) return

  const startTime = Date.now()

  await ensureUv()

  const uv = uvPath()
  const dir = engineDir()
  const venvDir = path.join(dir, "venv")

  // Create venv if it doesn't exist, or recreate if the Python binary is missing
  // (e.g. user deleted the binary but left the venv directory intact)
  if (!existsSync(venvDir) || !pythonExists) {
    Log.Default.info("creating python environment")
    try {
      execFileSync(uv, ["venv", "--python", "3.12", venvDir], { stdio: "pipe" })
    } catch (e: any) {
      Telemetry.track({
        type: "engine_error",
        timestamp: Date.now(),
        session_id: Telemetry.getContext().sessionId,
        phase: "venv_create",
        error_message: (e?.stderr?.toString() || (e?.message ? e.message : String(e))).slice(0, 500),
      })
      throw e
    }
  }

  // Install/upgrade engine
  const pythonPath = enginePythonPath()
  Log.Default.info("installing altimate-engine", { version: ALTIMATE_ENGINE_VERSION })
  try {
    const spec = `altimate-engine[${ENGINE_INSTALL_SPEC}]==${ALTIMATE_ENGINE_VERSION}`
    execFileSync(uv, ["pip", "install", "--python", pythonPath, spec], { stdio: "pipe" })
  } catch (e: any) {
    Telemetry.track({
      type: "engine_error",
      timestamp: Date.now(),
      session_id: Telemetry.getContext().sessionId,
      phase: "pip_install",
      error_message: (e?.stderr?.toString() || (e?.message ? e.message : String(e))).slice(0, 500),
    })
    throw e
  }

  // Get python version
  const pyVersion = execFileSync(pythonPath, ["--version"], { stdio: "pipe" }).toString().trim()
  // Get uv version
  const uvVersion = execFileSync(uv, ["--version"], { stdio: "pipe" }).toString().trim()

  await writeManifest({
    engine_version: ALTIMATE_ENGINE_VERSION,
    python_version: pyVersion,
    uv_version: uvVersion,
    cli_version: typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local",
    installed_at: new Date().toISOString(),
    extras: ENGINE_INSTALL_SPEC,
  })

  Telemetry.track({
    type: "engine_started",
    timestamp: Date.now(),
    session_id: Telemetry.getContext().sessionId,
    engine_version: ALTIMATE_ENGINE_VERSION,
    python_version: pyVersion,
    extras: ENGINE_INSTALL_SPEC,
    status: isUpgrade ? "upgraded" : "started",
    duration_ms: Date.now() - startTime,
  })

  Log.Default.info("engine ready", { version: ALTIMATE_ENGINE_VERSION })
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
