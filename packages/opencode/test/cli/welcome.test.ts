import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test"
import fs from "fs"
import path from "path"
import os from "os"
import { Telemetry } from "@/altimate/telemetry"

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

  // altimate_change start — first_launch is the only install metric, and after AI-8448 the curl and
  // PowerShell installers feed it too. These assert the two fields the install dashboard reads.
  describe("first_launch event", () => {
    const dataFiles = (version = "1.2.3", source?: string) => {
      const dir = path.join(tmpDir, "altimate-code")
      fs.writeFileSync(path.join(dir, ".installed-version"), version)
      if (source !== undefined) fs.writeFileSync(path.join(dir, ".install-source"), source)
      return dir
    }

    /**
     * The machine-id probe reads os.homedir(), which must be stubbed rather than
     * driven through $HOME: Bun resolves homedir() once at startup and ignores
     * later mutation of process.env.HOME. Without this the result depends on
     * whether the developer running the suite has ever launched the CLI.
     */
    function withHome<T>(home: string, fn: () => T): T {
      const spy = spyOn(os, "homedir").mockImplementation(() => home)
      try {
        return fn()
      } finally {
        spy.mockRestore()
      }
    }

    function captureEvents() {
      const events: Telemetry.Event[] = []
      spyOn(Telemetry, "track").mockImplementation((e: Telemetry.Event) => {
        events.push(e)
      })
      return events
    }

    afterEach(() => mock.restore())

    test("a machine with no prior identity reports is_upgrade false — the brand-new-install signal", async () => {
      dataFiles()
      const events = captureEvents()
      const cleanHome = fs.mkdtempSync(path.join(os.tmpdir(), "welcome-home-"))

      const { showWelcomeBannerIfNeeded } = await import("../../src/cli/welcome")
      withHome(cleanHome, () => showWelcomeBannerIfNeeded())

      const e = events[0] as any
      expect(e.type).toBe("first_launch")
      expect(e.is_upgrade).toBe(false)
      expect(e.version).toBe("1.2.3")
      fs.rmSync(cleanHome, { recursive: true, force: true })
    })

    test("a pre-existing machine-id reports is_upgrade true", async () => {
      dataFiles()
      const events = captureEvents()
      const usedHome = fs.mkdtempSync(path.join(os.tmpdir(), "welcome-home-"))
      fs.mkdirSync(path.join(usedHome, ".altimate"), { recursive: true })
      fs.writeFileSync(path.join(usedHome, ".altimate", "machine-id"), "8f1c0c4e-0a5e-4f4e-9c1a-2b3c4d5e6f70")

      const { showWelcomeBannerIfNeeded } = await import("../../src/cli/welcome")
      withHome(usedHome, () => showWelcomeBannerIfNeeded())

      expect((events[0] as any).is_upgrade).toBe(true)
      fs.rmSync(usedHome, { recursive: true, force: true })
    })

    test("attributes the installer that wrote the marker and consumes the source file", async () => {
      const dir = dataFiles("1.2.3", "curl")
      const events = captureEvents()
      const cleanHome = fs.mkdtempSync(path.join(os.tmpdir(), "welcome-home-"))

      const { showWelcomeBannerIfNeeded } = await import("../../src/cli/welcome")
      withHome(cleanHome, () => showWelcomeBannerIfNeeded())

      expect((events[0] as any).install_method).toBe("curl")
      // Left behind, it would be attributed to the next install whose installer wrote none.
      expect(fs.existsSync(path.join(dir, ".install-source"))).toBe(false)
      fs.rmSync(cleanHome, { recursive: true, force: true })
    })

    test("attributes the VS Code extension's native installer", async () => {
      // Highest-volume installer: it pulls from GitHub releases directly, so without
      // this value its installs would report "unknown" and be indistinguishable from
      // pre-field markers.
      dataFiles("1.2.3", "vscode-extension")
      const events = captureEvents()
      const cleanHome = fs.mkdtempSync(path.join(os.tmpdir(), "welcome-home-"))

      const { showWelcomeBannerIfNeeded } = await import("../../src/cli/welcome")
      withHome(cleanHome, () => showWelcomeBannerIfNeeded())

      expect((events[0] as any).install_method).toBe("vscode-extension")
      fs.rmSync(cleanHome, { recursive: true, force: true })
    })

    test("an absent source file reports unknown rather than dropping the event", async () => {
      dataFiles("1.2.3")
      const events = captureEvents()
      const cleanHome = fs.mkdtempSync(path.join(os.tmpdir(), "welcome-home-"))

      const { showWelcomeBannerIfNeeded } = await import("../../src/cli/welcome")
      withHome(cleanHome, () => showWelcomeBannerIfNeeded())

      // Upgrades from a version whose installer predates the source file land here.
      expect((events[0] as any).install_method).toBe("unknown")
      fs.rmSync(cleanHome, { recursive: true, force: true })
    })

    test("an unrecognised source value cannot mint a new dimension", async () => {
      dataFiles("1.2.3", "hand-edited-nonsense")
      const events = captureEvents()
      const cleanHome = fs.mkdtempSync(path.join(os.tmpdir(), "welcome-home-"))

      const { showWelcomeBannerIfNeeded } = await import("../../src/cli/welcome")
      withHome(cleanHome, () => showWelcomeBannerIfNeeded())

      expect((events[0] as any).install_method).toBe("unknown")
      fs.rmSync(cleanHome, { recursive: true, force: true })
    })

    test("clears a directory-shaped source file rather than leaving it forever", async () => {
      // unlinkSync throws EPERM/EISDIR on a directory. If it were used here, a
      // directory-shaped .install-source would survive every launch and pin
      // install_method to "unknown" permanently.
      const dir = path.join(tmpDir, "altimate-code")
      fs.writeFileSync(path.join(dir, ".installed-version"), "1.2.3")
      fs.mkdirSync(path.join(dir, ".install-source"), { recursive: true })
      const events = captureEvents()
      const cleanHome = fs.mkdtempSync(path.join(os.tmpdir(), "welcome-home-"))
      try {
        const { showWelcomeBannerIfNeeded } = await import("../../src/cli/welcome")
        withHome(cleanHome, () => showWelcomeBannerIfNeeded())

        expect((events[0] as any).install_method).toBe("unknown")
        expect(fs.existsSync(path.join(dir, ".install-source"))).toBe(false)
      } finally {
        fs.rmSync(cleanHome, { recursive: true, force: true })
      }
    })

    test("an empty marker emits nothing and clears the orphaned source file", async () => {
      const dir = dataFiles("", "curl")
      const events = captureEvents()
      const cleanHome = fs.mkdtempSync(path.join(os.tmpdir(), "welcome-home-"))

      const { showWelcomeBannerIfNeeded } = await import("../../src/cli/welcome")
      withHome(cleanHome, () => showWelcomeBannerIfNeeded())

      expect(events).toHaveLength(0)
      expect(fs.existsSync(path.join(dir, ".install-source"))).toBe(false)
      fs.rmSync(cleanHome, { recursive: true, force: true })
    })
  })
  // altimate_change end
})
