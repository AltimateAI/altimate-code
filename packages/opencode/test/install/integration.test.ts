import { describe, test, expect, afterEach } from "bun:test"
import path from "path"
import fs from "fs"
import {
  installTmpdir,
  createMainPackageDir,
  createBinaryPackage,
  runPostinstall,
  runBinWrapper,
  BIN_WRAPPER_SCRIPT,
  CURRENT_PLATFORM,
} from "./fixture"

let cleanup: (() => void) | undefined

afterEach(() => {
  cleanup?.()
  cleanup = undefined
})

describe("install pipeline integration", () => {
  test("full flow: layout -> postinstall -> bin wrapper executes dummy binary", () => {
    const { dir, cleanup: c } = installTmpdir()
    cleanup = c

    // 1. Build npm-like package layout
    createMainPackageDir(dir)
    createBinaryPackage(dir)

    // 2. Postinstall creates .opencode hard link
    const postResult = runPostinstall(dir)
    expect(postResult.exitCode).toBe(0)

    const cachedBin = path.join(dir, "bin", ".altimate-code")
    expect(fs.existsSync(cachedBin)).toBe(true)

    // 3. Place bin wrapper in the same bin/ directory
    const wrapperPath = path.join(dir, "bin", "altimate-code")
    fs.copyFileSync(BIN_WRAPPER_SCRIPT, wrapperPath)

    // 4. Wrapper finds cached .opencode and executes it
    const wrapperResult = runBinWrapper(wrapperPath)
    expect(wrapperResult.exitCode).toBe(0)
    expect(wrapperResult.stdout).toContain("altimate-code-test-ok")
  })

  test("missing optional dep: postinstall fails, bin wrapper also fails gracefully", () => {
    const { dir, cleanup: c } = installTmpdir()
    cleanup = c

    // Layout WITHOUT binary package — simulates expired npm token / silent optionalDep failure
    createMainPackageDir(dir)

    // 1. Postinstall fails because platform binary package is missing
    const postResult = runPostinstall(dir)
    expect(postResult.exitCode).toBe(1)
    expect(postResult.stderr).toContain("Failed to setup altimate-code binary")

    // 2. No cached binary was created
    expect(fs.existsSync(path.join(dir, "bin", ".altimate-code"))).toBe(false)

    // 3. Bin wrapper also fails with helpful error when invoked directly
    const wrapperPkgBin = path.join(dir, "node_modules", "@altimateai", "altimate-code", "bin")
    fs.mkdirSync(wrapperPkgBin, { recursive: true })
    const wrapperPath = path.join(wrapperPkgBin, "altimate-code")
    fs.copyFileSync(BIN_WRAPPER_SCRIPT, wrapperPath)

    const wrapperResult = runBinWrapper(wrapperPath)
    expect(wrapperResult.exitCode).toBe(1)
    expect(wrapperResult.stderr).toContain("package manager failed to install")
  })

  test("wrong-platform-only install: both scripts fail with clear errors", () => {
    const { dir, cleanup: c } = installTmpdir()
    cleanup = c

    createMainPackageDir(dir)
    const wrongPlatform = CURRENT_PLATFORM === "darwin" ? "linux" : "darwin"
    createBinaryPackage(dir, { platform: wrongPlatform })

    // 1. Postinstall fails — can't find binary for current platform
    const postResult = runPostinstall(dir)
    expect(postResult.exitCode).toBe(1)

    // 2. Bin wrapper also fails — wrong-platform package doesn't match
    const wrapperPkgBin = path.join(dir, "node_modules", "@altimateai", "altimate-code", "bin")
    fs.mkdirSync(wrapperPkgBin, { recursive: true })
    const wrapperPath = path.join(wrapperPkgBin, "altimate-code")
    fs.copyFileSync(BIN_WRAPPER_SCRIPT, wrapperPath)

    const wrapperResult = runBinWrapper(wrapperPath)
    expect(wrapperResult.exitCode).toBe(1)
    expect(wrapperResult.stderr).toContain("package manager failed to install")
  })
})
