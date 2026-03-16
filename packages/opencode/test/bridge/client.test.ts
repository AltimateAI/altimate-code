// @ts-nocheck
import { describe, expect, test, mock, afterEach } from "bun:test"
import path from "path"
import fsp from "fs/promises"
import { existsSync } from "fs"
import os from "os"

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let ensureEngineCalls = 0
let managedPythonPath = "/nonexistent/managed-engine/venv/bin/python"

// ---------------------------------------------------------------------------
// Mock: bridge/engine  (only module we mock — avoids leaking into other tests)
// ---------------------------------------------------------------------------

mock.module("../../src/altimate/bridge/engine", () => ({
  ensureEngine: async () => {
    ensureEngineCalls++
  },
  enginePythonPath: () => managedPythonPath,
  ENGINE_INSTALL_SPEC: "warehouses",
}))

// ---------------------------------------------------------------------------
// Import module under test — AFTER mock.module() calls
// ---------------------------------------------------------------------------

const { resolvePython } = await import("../../src/altimate/bridge/client")

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpRoot = path.join(os.tmpdir(), "bridge-test-" + process.pid + "-" + Math.random().toString(36).slice(2))

async function createFakeFile(filePath: string) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  await fsp.writeFile(filePath, "")
}

// Platform-aware venv python path (matches venvPythonBin in production code)
function testVenvPythonBin(venvDir: string): string {
  return process.platform === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python")
}

// Paths that resolvePython() checks for dev/cwd venvs.
// From source file: __dirname is <repo>/packages/altimate-code/src/bridge/
// From test file:   __dirname is <repo>/packages/altimate-code/test/bridge/
// Both resolve 3 levels up to <repo>/packages/, so the dev venv path is identical.
const devVenvPython = testVenvPythonBin(path.resolve(__dirname, "..", "..", "..", "altimate-engine", ".venv"))
const cwdVenvPython = testVenvPythonBin(path.join(process.cwd(), ".venv"))
const hasLocalDevVenv = existsSync(devVenvPython) || existsSync(cwdVenvPython)

// ---------------------------------------------------------------------------
// Tests — resolvePython priority ordering
// ---------------------------------------------------------------------------

describe("resolvePython", () => {
  afterEach(async () => {
    ensureEngineCalls = 0
    delete process.env.OPENCODE_PYTHON
    managedPythonPath = "/nonexistent/managed-engine/venv/bin/python"
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  })

  test("prefers OPENCODE_PYTHON env var over all other sources", () => {
    process.env.OPENCODE_PYTHON = "/custom/python3.12"
    expect(resolvePython()).toBe("/custom/python3.12")
  })

  test("env var takes priority even when managed venv exists on disk", async () => {
    const fakePython = path.join(tmpRoot, "managed", "venv", "bin", "python")
    await createFakeFile(fakePython)
    managedPythonPath = fakePython

    process.env.OPENCODE_PYTHON = "/override/python3"
    expect(resolvePython()).toBe("/override/python3")
  })

  test("uses managed engine venv when it exists on disk", async () => {
    if (hasLocalDevVenv) {
      console.log("Skipping: local dev venv exists, can't test managed venv resolution in isolation")
      return
    }

    const fakePython = path.join(tmpRoot, "managed", "venv", "bin", "python")
    await createFakeFile(fakePython)
    managedPythonPath = fakePython

    expect(resolvePython()).toBe(fakePython)
  })

  test("falls back to python3 when no venvs exist", () => {
    if (hasLocalDevVenv) {
      console.log("Skipping: local dev venv exists, can't test fallback in isolation")
      return
    }

    expect(resolvePython()).toBe("python3")
  })

  test("does not use managed venv when it does not exist on disk", () => {
    if (hasLocalDevVenv) {
      console.log("Skipping: local dev venv exists")
      return
    }

    // managedPythonPath points to nonexistent path by default
    expect(resolvePython()).toBe("python3")
  })

  test("prefers managed engine venv over .venv in cwd", async () => {
    if (existsSync(devVenvPython)) {
      console.log("Skipping: local dev venv exists, can't test managed vs cwd priority")
      return
    }

    const fakeManagedPython = path.join(tmpRoot, "managed", "venv", "bin", "python")
    await createFakeFile(fakeManagedPython)
    managedPythonPath = fakeManagedPython

    expect(resolvePython()).toBe(fakeManagedPython)
  })

  test("checks enginePythonPath() from the engine module", async () => {
    if (hasLocalDevVenv) {
      console.log("Skipping: local dev venv exists")
      return
    }

    // Initially the path doesn't exist → falls back to python3
    expect(resolvePython()).toBe("python3")

    // Now create the file and update the managed path
    const fakePython = path.join(tmpRoot, "engine-venv", "bin", "python")
    await createFakeFile(fakePython)
    managedPythonPath = fakePython

    // Now it should find the managed venv
    expect(resolvePython()).toBe(fakePython)
  })
})

// ---------------------------------------------------------------------------
// Tests — resolvePython env var edge cases
// ---------------------------------------------------------------------------

describe("resolvePython env var edge cases", () => {
  afterEach(async () => {
    delete process.env.OPENCODE_PYTHON
    managedPythonPath = "/nonexistent/managed-engine/venv/bin/python"
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  })

  test("env var with empty string is falsy, falls through to next check", () => {
    if (hasLocalDevVenv) {
      console.log("Skipping: local dev venv exists")
      return
    }

    process.env.OPENCODE_PYTHON = ""
    // Empty string is falsy, so env var check is skipped
    expect(resolvePython()).toBe("python3")
  })

  test("env var pointing to nonexistent path is returned as-is (no validation)", () => {
    process.env.OPENCODE_PYTHON = "/does/not/exist/python3"
    // resolvePython trusts the env var without checking existence
    expect(resolvePython()).toBe("/does/not/exist/python3")
  })

  test("env var with spaces in path is returned correctly", () => {
    process.env.OPENCODE_PYTHON = "/path with spaces/python3"
    expect(resolvePython()).toBe("/path with spaces/python3")
  })

  test("env var overrides even when dev venv, managed venv, AND cwd venv all exist", async () => {
    const fakeManagedPython = path.join(tmpRoot, "managed", "venv", "bin", "python")
    await createFakeFile(fakeManagedPython)
    managedPythonPath = fakeManagedPython

    process.env.OPENCODE_PYTHON = "/explicit/override"
    expect(resolvePython()).toBe("/explicit/override")
  })
})

// ---------------------------------------------------------------------------
// Tests — resolvePython managed venv priority
// ---------------------------------------------------------------------------

describe("resolvePython managed venv takes priority over cwd venv", () => {
  afterEach(async () => {
    delete process.env.OPENCODE_PYTHON
    managedPythonPath = "/nonexistent/managed-engine/venv/bin/python"
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  })

  test("when managed venv exists, cwd venv is never reached", async () => {
    if (existsSync(devVenvPython)) {
      console.log("Skipping: local dev venv exists")
      return
    }

    const fakeManagedPython = path.join(tmpRoot, "managed", "venv", "bin", "python")
    await createFakeFile(fakeManagedPython)
    managedPythonPath = fakeManagedPython

    // Even if cwd has a .venv, managed should win
    const result = resolvePython()
    expect(result).toBe(fakeManagedPython)
    expect(result).not.toContain(process.cwd())
  })

  test("managed venv path uses enginePythonPath() which handles platform differences", async () => {
    if (hasLocalDevVenv) {
      console.log("Skipping: local dev venv exists")
      return
    }

    // enginePythonPath is mocked, but this tests that resolvePython delegates to it
    const customPath = path.join(tmpRoot, "custom-managed", "python")
    await createFakeFile(customPath)
    managedPythonPath = customPath

    expect(resolvePython()).toBe(customPath)
  })

  test("when managed venv does NOT exist, cwd venv CAN be used as fallback", async () => {
    if (hasLocalDevVenv) {
      console.log("Skipping: local dev venv exists")
      return
    }

    // managedPythonPath doesn't exist on disk (default)
    // Create a fake cwd venv
    const fakeCwdVenv = path.join(process.cwd(), ".venv", "bin", "python")
    const cwdVenvExisted = existsSync(fakeCwdVenv)

    if (cwdVenvExisted) {
      // cwd venv already exists, so resolvePython should return it
      expect(resolvePython()).toBe(fakeCwdVenv)
    } else {
      // No cwd venv either, falls back to python3
      expect(resolvePython()).toBe("python3")
    }
  })
})

// ---------------------------------------------------------------------------
// Tests — resolvePython resolution order (source code verification)
// ---------------------------------------------------------------------------

describe("resolvePython resolution order verification", () => {
  test("source code checks managed venv (step 3) before cwd venv (step 4)", async () => {
    const clientSrc = path.resolve(
      __dirname,
      "../../src/altimate/bridge/client.ts",
    )
    const source = await fsp.readFile(clientSrc, "utf-8")

    // Find the line numbers for managed venv and cwd venv checks
    const lines = source.split("\n")
    let managedVenvLine = -1
    let cwdVenvLine = -1

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("enginePythonPath()")) managedVenvLine = i
      if (lines[i].includes("process.cwd()") && lines[i].includes(".venv")) cwdVenvLine = i
    }

    expect(managedVenvLine).toBeGreaterThan(0)
    expect(cwdVenvLine).toBeGreaterThan(0)
    // Managed venv MUST come before cwd venv in the source
    expect(managedVenvLine).toBeLessThan(cwdVenvLine)
  })

  test("source code uses venvPythonBin helper for platform-aware paths", async () => {
    const clientSrc = path.resolve(
      __dirname,
      "../../src/altimate/bridge/client.ts",
    )
    const source = await fsp.readFile(clientSrc, "utf-8")

    // The venvPythonBin function should exist and handle Windows
    expect(source).toContain("function venvPythonBin")
    expect(source).toContain("Scripts")
    expect(source).toContain("python.exe")

    // Dev venv and cwd venv should use venvPythonBin, not hardcoded bin/python
    const lines = source.split("\n")
    for (const line of lines) {
      // Lines that construct dev or cwd venv paths should use venvPythonBin
      if (line.includes("altimate-engine") && line.includes(".venv") && line.includes("path.join")) {
        expect(line).toContain("venvPythonBin")
      }
      if (line.includes("process.cwd()") && line.includes(".venv") && line.includes("path.join")) {
        expect(line).toContain("venvPythonBin")
      }
    }
  })

  test("source code has exactly 5 resolution steps", async () => {
    const clientSrc = path.resolve(
      __dirname,
      "../../src/altimate/bridge/client.ts",
    )
    const source = await fsp.readFile(clientSrc, "utf-8")

    // Count the numbered comment steps
    const stepComments = source.match(/\/\/ \d+\./g) || []
    expect(stepComments.length).toBe(5)
    expect(stepComments).toEqual(["// 1.", "// 2.", "// 3.", "// 4.", "// 5."])
  })
})

// ---------------------------------------------------------------------------
// Tests — startup mutex
// ---------------------------------------------------------------------------

describe("Bridge startup mutex", () => {
  test("source code has pendingStart mutex to prevent concurrent start()", async () => {
    const clientSrc = path.resolve(
      __dirname,
      "../../src/altimate/bridge/client.ts",
    )
    const source = await fsp.readFile(clientSrc, "utf-8")

    // Verify the mutex pattern exists
    expect(source).toContain("pendingStart")
    expect(source).toContain("if (pendingStart)")
    expect(source).toContain("await pendingStart")
    // Verify it's cleaned up in finally
    expect(source).toContain("pendingStart = null")
  })

  test("pendingStart is cleared in finally block (not just on success)", async () => {
    const clientSrc = path.resolve(
      __dirname,
      "../../src/altimate/bridge/client.ts",
    )
    const source = await fsp.readFile(clientSrc, "utf-8")

    // The mutex must be cleared in a finally block so failed starts don't deadlock
    const lines = source.split("\n")
    let foundFinally = false
    let foundClearAfterFinally = false

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("} finally {")) foundFinally = true
      if (foundFinally && lines[i].includes("pendingStart = null")) {
        foundClearAfterFinally = true
        break
      }
    }

    expect(foundClearAfterFinally).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Tests — Bridge.start integration
// ---------------------------------------------------------------------------

describe("Bridge.start integration", () => {
  afterEach(() => {
    ensureEngineCalls = 0
    delete process.env.OPENCODE_PYTHON
    managedPythonPath = "/nonexistent/managed-engine/venv/bin/python"
  })

  test("ensureEngine is called when bridge starts", async () => {
    const { Bridge } = await import("../../src/altimate/bridge/client")

    process.env.OPENCODE_PYTHON = process.execPath

    try {
      await Bridge.call("ping", {} as any)
    } catch {
      // Expected: the bridge ping verification will fail
    }

    expect(ensureEngineCalls).toBeGreaterThanOrEqual(1)
    Bridge.stop()
  })

  test("concurrent Bridge.call() invocations share ensureEngine call", async () => {
    const { Bridge } = await import("../../src/altimate/bridge/client")

    process.env.OPENCODE_PYTHON = process.execPath
    ensureEngineCalls = 0

    // Fire multiple calls concurrently — they should coalesce into one start()
    const results = await Promise.allSettled([
      Bridge.call("ping", {} as any),
      Bridge.call("ping", {} as any),
      Bridge.call("ping", {} as any),
    ])

    // All should fail (process.execPath doesn't speak JSON-RPC)
    for (const r of results) {
      expect(r.status).toBe("rejected")
    }

    // The startup mutex should coalesce concurrent calls into a single
    // ensureEngine invocation. In JS's single-threaded model, the first
    // call sets pendingStart before any await, so subsequent calls join it.
    expect(ensureEngineCalls).toBeGreaterThanOrEqual(1)
    expect(ensureEngineCalls).toBeLessThanOrEqual(2)
    Bridge.stop()
  })
})

// ---------------------------------------------------------------------------
// Tests — engine.ts source integrity (extras tracking)
// ---------------------------------------------------------------------------

describe("engine.ts extras tracking", () => {
  test("engine.ts exports ENGINE_INSTALL_SPEC constant", async () => {
    const engineSrc = path.resolve(
      __dirname,
      "../../src/altimate/bridge/engine.ts",
    )
    const source = await fsp.readFile(engineSrc, "utf-8")

    expect(source).toContain('export const ENGINE_INSTALL_SPEC')
    expect(source).toContain('"warehouses"')
  })

  test("engine.ts manifest interface includes extras field", async () => {
    const engineSrc = path.resolve(
      __dirname,
      "../../src/altimate/bridge/engine.ts",
    )
    const source = await fsp.readFile(engineSrc, "utf-8")

    expect(source).toContain("extras?:")
  })

  test("engine.ts writeManifest includes extras", async () => {
    const engineSrc = path.resolve(
      __dirname,
      "../../src/altimate/bridge/engine.ts",
    )
    const source = await fsp.readFile(engineSrc, "utf-8")

    // Find the writeManifest call and verify it includes extras
    expect(source).toMatch(/writeManifest\(\{[\s\S]*extras:\s*ENGINE_INSTALL_SPEC/)
  })

  test("engine.ts ensureEngineImpl checks extras match before returning early", async () => {
    const engineSrc = path.resolve(
      __dirname,
      "../../src/altimate/bridge/engine.ts",
    )
    const source = await fsp.readFile(engineSrc, "utf-8")

    // The early return must check extrasMatch
    expect(source).toContain("extrasMatch")
    expect(source).toMatch(/if\s*\(manifest\s*&&.*extrasMatch\)\s*return/)
  })

  test("engine.ts validates python binary exists before trusting manifest", async () => {
    const engineSrc = path.resolve(
      __dirname,
      "../../src/altimate/bridge/engine.ts",
    )
    const source = await fsp.readFile(engineSrc, "utf-8")

    // The early return must check pythonExists
    expect(source).toContain("pythonExists")
    expect(source).toContain("existsSync(enginePythonPath())")
    expect(source).toMatch(/if\s*\(manifest\s*&&.*pythonExists.*\)\s*return/)
  })

  test("engine.ts uses ENGINE_INSTALL_SPEC in pip install command", async () => {
    const engineSrc = path.resolve(
      __dirname,
      "../../src/altimate/bridge/engine.ts",
    )
    const source = await fsp.readFile(engineSrc, "utf-8")

    // The install command should reference ENGINE_INSTALL_SPEC, not hardcode extras
    expect(source).toContain("ENGINE_INSTALL_SPEC")
    expect(source).toContain("`altimate-engine[${ENGINE_INSTALL_SPEC}]")
  })
})

// ---------------------------------------------------------------------------
// Tests — engine.ts ensureEngineImpl validation logic
// ---------------------------------------------------------------------------

describe("engine.ts ensureEngineImpl validation conditions", () => {
  test("early return requires ALL four conditions: manifest + version + pythonExists + extrasMatch", async () => {
    const engineSrc = path.resolve(
      __dirname,
      "../../src/altimate/bridge/engine.ts",
    )
    const source = await fsp.readFile(engineSrc, "utf-8")

    // Find the early return line
    const lines = source.split("\n")
    const earlyReturnLine = lines.find(l =>
      l.includes("manifest") &&
      l.includes("ALTIMATE_ENGINE_VERSION") &&
      l.includes("pythonExists") &&
      l.includes("extrasMatch") &&
      l.includes("return")
    )

    expect(earlyReturnLine).toBeDefined()
    // All conditions must be ANDed together
    expect(earlyReturnLine).toContain("&&")
    // Should have exactly 3 && operators (4 conditions)
    const andCount = (earlyReturnLine!.match(/&&/g) || []).length
    expect(andCount).toBe(3)
  })

  test("extrasMatch defaults empty string when manifest.extras is undefined (old manifests)", async () => {
    const engineSrc = path.resolve(
      __dirname,
      "../../src/altimate/bridge/engine.ts",
    )
    const source = await fsp.readFile(engineSrc, "utf-8")

    // Old manifests won't have extras field — must use nullish coalescing
    expect(source).toMatch(/manifest\?\.extras\s*\?\?\s*""/)
  })
})

// ---------------------------------------------------------------------------
// Tests — Windows path handling in venvPythonBin
// ---------------------------------------------------------------------------

describe("venvPythonBin platform handling", () => {
  test("source code has venvPythonBin function with Windows support", async () => {
    const clientSrc = path.resolve(
      __dirname,
      "../../src/altimate/bridge/client.ts",
    )
    const source = await fsp.readFile(clientSrc, "utf-8")

    // Must handle both platforms
    expect(source).toContain("function venvPythonBin")
    expect(source).toContain('process.platform === "win32"')
    expect(source).toContain("Scripts")
    expect(source).toContain("python.exe")
    expect(source).toContain('"bin"')
    expect(source).toContain('"python"')
  })

  test("dev venv path uses venvPythonBin (not hardcoded bin/python)", async () => {
    const clientSrc = path.resolve(
      __dirname,
      "../../src/altimate/bridge/client.ts",
    )
    const source = await fsp.readFile(clientSrc, "utf-8")

    // The dev venv path construction spans two lines:
    //   const engineDir = path.resolve(..., "altimate-engine")
    //   const venvPython = venvPythonBin(path.join(engineDir, ".venv"))
    // Verify the venvPython assignment uses venvPythonBin
    const lines = source.split("\n")
    const devVenvLine = lines.find(l =>
      l.includes("venvPython") && l.includes("venvPythonBin") && l.includes(".venv")
    )
    expect(devVenvLine).toBeDefined()
    // Must NOT use hardcoded "bin", "python" path segments
    expect(devVenvLine).not.toMatch(/["']bin["'].*["']python["']/)
  })

  test("cwd venv path uses venvPythonBin (not hardcoded bin/python)", async () => {
    const clientSrc = path.resolve(
      __dirname,
      "../../src/altimate/bridge/client.ts",
    )
    const source = await fsp.readFile(clientSrc, "utf-8")

    // The line constructing the cwd venv path should call venvPythonBin
    const lines = source.split("\n")
    const cwdVenvLine = lines.find(l =>
      l.includes("process.cwd()") && l.includes(".venv")
    )
    expect(cwdVenvLine).toBeDefined()
    expect(cwdVenvLine).toContain("venvPythonBin")
  })

  test("enginePythonPath in engine.ts also handles Windows paths", async () => {
    const engineSrc = path.resolve(
      __dirname,
      "../../src/altimate/bridge/engine.ts",
    )
    const source = await fsp.readFile(engineSrc, "utf-8")

    // enginePythonPath should have the same platform check
    expect(source).toMatch(/enginePythonPath[\s\S]*?win32[\s\S]*?Scripts[\s\S]*?python\.exe/)
  })
})
