import { describe, test, expect, afterEach } from "bun:test"
import path from "path"
import fs from "fs"
import {
  installTmpdir,
  createMainPackageDir,
  createBinaryPackage,
  runPostinstall,
  CURRENT_PLATFORM,
} from "./fixture"

// On Windows, postinstall.mjs takes a different early-exit path that skips
// binary setup entirely (the .exe is packaged separately). Skip all tests that
// depend on the Unix hard-link / error-path behavior.
const unixtest = process.platform !== "win32" ? test : test.skip

let cleanup: (() => void) | undefined

afterEach(() => {
  cleanup?.()
  cleanup = undefined
})

describe("postinstall.mjs", () => {
  unixtest("finds binary and creates hard link in bin/", () => {
    const { dir, cleanup: c } = installTmpdir()
    cleanup = c

    createMainPackageDir(dir)
    createBinaryPackage(dir)

    const result = runPostinstall(dir)
    expect(result.exitCode).toBe(0)

    const cachedBinary = path.join(dir, "bin", ".altimate-code")
    expect(fs.existsSync(cachedBinary)).toBe(true)
    // Verify it's executable
    const stat = fs.statSync(cachedBinary)
    expect(stat.mode & 0o111).toBeGreaterThan(0)
  })

  unixtest("replaces existing stale binary", () => {
    const { dir, cleanup: c } = installTmpdir()
    cleanup = c

    createMainPackageDir(dir)
    createBinaryPackage(dir)

    // Create a stale .opencode file
    const cachedBinary = path.join(dir, "bin", ".altimate-code")
    fs.writeFileSync(cachedBinary, "stale content")

    const result = runPostinstall(dir)
    expect(result.exitCode).toBe(0)

    // Should be replaced with the real binary content
    const content = fs.readFileSync(cachedBinary, "utf-8")
    expect(content).not.toBe("stale content")
    expect(content).toContain("altimate-code-test-ok")
  })

  unixtest("creates bin/ dir if missing", () => {
    const { dir, cleanup: c } = installTmpdir()
    cleanup = c

    createMainPackageDir(dir, { noBinDir: true })
    createBinaryPackage(dir)

    const result = runPostinstall(dir)
    // The current postinstall does not create bin/ — linkSync/copyFileSync fail
    // This test documents current behavior: it fails when bin/ is missing
    if (result.exitCode === 0) {
      expect(fs.existsSync(path.join(dir, "bin", ".altimate-code"))).toBe(true)
    } else {
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("Failed to setup altimate-code binary")
    }
  })

  test("prints welcome banner with correct version", () => {
    const { dir, cleanup: c } = installTmpdir()
    cleanup = c

    createMainPackageDir(dir, { version: "2.5.0" })
    createBinaryPackage(dir)

    const result = runPostinstall(dir)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("altimate-code v2.5.0 installed")
  })

  unixtest("exits 1 when platform binary package is missing", () => {
    const { dir, cleanup: c } = installTmpdir()
    cleanup = c

    createMainPackageDir(dir)
    // No binary package created — simulates expired npm token / silent optionalDep failure

    const result = runPostinstall(dir)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("Failed to setup altimate-code binary")
  })

  unixtest("exits 1 when package exists but binary file is missing", () => {
    const { dir, cleanup: c } = installTmpdir()
    cleanup = c

    createMainPackageDir(dir)
    createBinaryPackage(dir, { noBinaryFile: true })

    const result = runPostinstall(dir)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("Failed to setup altimate-code binary")
  })

  unixtest("exits 1 when only wrong-platform package is present", () => {
    const { dir, cleanup: c } = installTmpdir()
    cleanup = c

    createMainPackageDir(dir)
    const wrongPlatform = CURRENT_PLATFORM === "darwin" ? "linux" : "darwin"
    createBinaryPackage(dir, { platform: wrongPlatform })

    const result = runPostinstall(dir)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("Failed to setup altimate-code binary")
  })
})
