import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test"
import fs from "fs"
import path from "path"
import os from "os"

describe("showWelcomeBannerIfNeeded", () => {
  let tmpDir: string
  let cleanup: () => void
  let originalStderrWrite: typeof process.stderr.write
  let stderrOutput: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "welcome-test-"))
    const dataDir = path.join(tmpDir, "altimate-code")
    fs.mkdirSync(dataDir, { recursive: true })

    // Set env vars for test isolation
    process.env.OPENCODE_TEST_HOME = tmpDir
    process.env.XDG_DATA_HOME = tmpDir

    // Capture stderr output
    stderrOutput = ""
    originalStderrWrite = process.stderr.write
    process.stderr.write = ((chunk: string | Uint8Array) => {
      if (typeof chunk === "string") stderrOutput += chunk
      return true
    }) as typeof process.stderr.write

    cleanup = () => {
      process.stderr.write = originalStderrWrite
      delete process.env.OPENCODE_TEST_HOME
      delete process.env.XDG_DATA_HOME
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  afterEach(() => {
    cleanup?.()
  })

  test("does nothing when no marker file exists", async () => {
    // Import with fresh module state
    const { showWelcomeBannerIfNeeded } = await import("../../src/cli/welcome")
    showWelcomeBannerIfNeeded()
    expect(stderrOutput).toBe("")
  })

  test("removes marker file after reading", async () => {
    const markerPath = path.join(tmpDir, "altimate-code", ".installed-version")
    fs.writeFileSync(markerPath, "0.2.5")

    const { showWelcomeBannerIfNeeded } = await import("../../src/cli/welcome")
    showWelcomeBannerIfNeeded()
    expect(fs.existsSync(markerPath)).toBe(false)
  })

  test("removes marker file even when version is empty", async () => {
    const markerPath = path.join(tmpDir, "altimate-code", ".installed-version")
    fs.writeFileSync(markerPath, "")

    const { showWelcomeBannerIfNeeded } = await import("../../src/cli/welcome")
    showWelcomeBannerIfNeeded()
    expect(fs.existsSync(markerPath)).toBe(false)
  })

  test("does not crash on filesystem errors", async () => {
    // Point to a non-existent directory — should silently handle the error
    process.env.XDG_DATA_HOME = "/nonexistent/path/that/does/not/exist"

    const { showWelcomeBannerIfNeeded } = await import("../../src/cli/welcome")
    expect(() => showWelcomeBannerIfNeeded()).not.toThrow()
  })
})
