import os from "os"
import path from "path"
import fs from "fs"
import { spawnSync } from "child_process"

const PLATFORM_MAP: Record<string, string> = { darwin: "darwin", linux: "linux", win32: "windows" }
const ARCH_MAP: Record<string, string> = { x64: "x64", arm64: "arm64", arm: "arm" }

export const CURRENT_PLATFORM = PLATFORM_MAP[os.platform()] ?? os.platform()
export const CURRENT_ARCH = ARCH_MAP[os.arch()] ?? os.arch()
export const CURRENT_PKG_NAME = `@altimateai/altimate-code-${CURRENT_PLATFORM}-${CURRENT_ARCH}`
export const BINARY_NAME = CURRENT_PLATFORM === "windows" ? "altimate-code.exe" : "altimate-code"

const REPO_PKG_DIR = path.resolve(import.meta.dir, "../..")
export const POSTINSTALL_SCRIPT = path.join(REPO_PKG_DIR, "script/postinstall.mjs")
export const BIN_WRAPPER_SCRIPT = path.join(REPO_PKG_DIR, "bin/altimate-code")

export function installTmpdir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "altimate-install-test-"))
  return {
    dir,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

interface MainPackageOpts {
  version?: string
  noBinDir?: boolean
}

export function createMainPackageDir(baseDir: string, opts?: MainPackageOpts) {
  const version = opts?.version ?? "1.0.0-test"

  fs.copyFileSync(POSTINSTALL_SCRIPT, path.join(baseDir, "postinstall.mjs"))

  fs.writeFileSync(
    path.join(baseDir, "package.json"),
    JSON.stringify({ name: "@altimateai/altimate-code", version }, null, 2),
  )

  if (!opts?.noBinDir) {
    fs.mkdirSync(path.join(baseDir, "bin"), { recursive: true })
  }
}

interface BinaryPackageOpts {
  platform?: string
  arch?: string
  noBinaryFile?: boolean
}

export function createBinaryPackage(baseDir: string, opts?: BinaryPackageOpts) {
  const platform = opts?.platform ?? CURRENT_PLATFORM
  const arch = opts?.arch ?? CURRENT_ARCH
  const pkgName = `@altimateai/altimate-code-${platform}-${arch}`
  const binaryName = platform === "windows" ? "altimate-code.exe" : "altimate-code"

  const pkgDir = path.join(baseDir, "node_modules", "@altimateai", `altimate-code-${platform}-${arch}`)
  fs.mkdirSync(pkgDir, { recursive: true })

  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: pkgName, version: "1.0.0-test" }, null, 2))

  if (!opts?.noBinaryFile) {
    const binDir = path.join(pkgDir, "bin")
    fs.mkdirSync(binDir, { recursive: true })
    const binaryPath = path.join(binDir, binaryName)
    fs.writeFileSync(binaryPath, '#!/bin/sh\necho "altimate-code-test-ok"')
    fs.chmodSync(binaryPath, 0o755)
  }

  return pkgDir
}

export function createDummyBinary(dir: string, name?: string): string {
  const binaryPath = path.join(dir, name ?? "altimate-code-dummy")
  fs.writeFileSync(binaryPath, '#!/bin/sh\necho "altimate-code-test-ok"')
  fs.chmodSync(binaryPath, 0o755)
  return binaryPath
}

export function runPostinstall(cwd: string, env?: Record<string, string>) {
  const result = spawnSync("node", ["postinstall.mjs"], {
    cwd,
    encoding: "utf-8",
    timeout: 10_000,
    env: { ...process.env, ...env },
  })
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  }
}

export function runBinWrapper(binPath: string, args: string[] = [], env?: Record<string, string>) {
  const cleanEnv = { ...process.env }
  delete cleanEnv.ALTIMATE_CODE_BIN_PATH

  const result = spawnSync("node", [binPath, ...args], {
    encoding: "utf-8",
    timeout: 10_000,
    env: { ...cleanEnv, ...env },
  })
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  }
}
