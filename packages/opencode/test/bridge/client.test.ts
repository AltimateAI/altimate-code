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

// Paths that resolvePython() checks for dev/cwd venvs.
// From source file: __dirname is <repo>/packages/altimate-code/src/bridge/
// From test file:   __dirname is <repo>/packages/altimate-code/test/bridge/
// Both resolve 3 levels up to <repo>/packages/, so the dev venv path is identical.
const devVenvPython = path.resolve(__dirname, "..", "..", "..", "altimate-engine", ".venv", "bin", "python")
const cwdVenvPython = path.join(process.cwd(), ".venv", "bin", "python")
const hasLocalDevVenv = existsSync(devVenvPython) || existsSync(cwdVenvPython)

// ---------------------------------------------------------------------------
// Tests
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

describe("Bridge.start integration", () => {
  // These tests verify that ensureEngine() is called by observing the
  // ensureEngineCalls counter. We don't mock child_process, so start()
  // will attempt a real spawn — we use /bin/echo which exists but
  // won't speak JSON-RPC, causing the bridge ping to fail.

  afterEach(() => {
    ensureEngineCalls = 0
    delete process.env.OPENCODE_PYTHON
    managedPythonPath = "/nonexistent/managed-engine/venv/bin/python"
  })

  test("ensureEngine is called when bridge starts", async () => {
    const { Bridge } = await import("../../src/altimate/bridge/client")

    // process.execPath (the current Bun/Node binary) exists on all platforms.
    // When spawned as a Python replacement it exits quickly without speaking
    // JSON-RPC, so start() fails on the ping verification as expected.
    process.env.OPENCODE_PYTHON = process.execPath

    try {
      await Bridge.call("ping", {} as any)
    } catch {
      // Expected: the bridge ping verification will fail
    }

    // Even though the ping failed, ensureEngine was called before the spawn attempt
    expect(ensureEngineCalls).toBeGreaterThanOrEqual(1)
    Bridge.stop()
  })
})
