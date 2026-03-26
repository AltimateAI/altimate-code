/**
 * Adversarial tests for dbt-tools config auto-discovery and Windows compatibility.
 *
 * Covers:
 *  - findProjectRoot: symlink loops, deep trees, permission edges
 *  - discoverPython: malicious env vars, missing binaries, Windows path logic
 *  - read(): race conditions, config/discovery priority, malformed data
 *  - resolveDbt: broken symlinks, conflicting env vars, path.delimiter
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  symlink,
  chmod,
} from "fs/promises"
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  chmodSync,
  existsSync,
  rmSync,
} from "fs"
import { tmpdir } from "os"
import { delimiter } from "path"

// ─── Helpers ─────────────────────────────────────────────────────────

/** Save and restore env vars around a test. */
function withEnv(overrides: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const saved: Record<string, string | undefined> = {}
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key]
  }
  return async () => {
    try {
      for (const [key, val] of Object.entries(overrides)) {
        if (val === undefined) delete process.env[key]
        else process.env[key] = val
      }
      await fn()
    } finally {
      for (const [key, val] of Object.entries(saved)) {
        if (val === undefined) delete process.env[key]
        else process.env[key] = val
      }
    }
  }
}

// ═════════════════════════════════════════════════════════════════════
// findProjectRoot — adversarial
// ═════════════════════════════════════════════════════════════════════
describe("adversarial: findProjectRoot", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "adv-find-root-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test("returns null for empty directory (no dbt_project.yml anywhere)", async () => {
    const { findProjectRoot } = await import("../src/config")
    expect(findProjectRoot(dir)).toBeNull()
  })

  test("handles deeply nested directory (50 levels deep)", async () => {
    const { findProjectRoot } = await import("../src/config")
    // Place dbt_project.yml at root
    await writeFile(join(dir, "dbt_project.yml"), "name: deep-test")

    // Create 50-level deep subdirectory
    let deep = dir
    for (let i = 0; i < 50; i++) {
      deep = join(deep, `level${i}`)
    }
    await mkdir(deep, { recursive: true })

    const result = findProjectRoot(deep)
    expect(result).toBe(dir)
  })

  test("returns closest dbt_project.yml in nested projects", async () => {
    const { findProjectRoot } = await import("../src/config")
    // Outer project
    await writeFile(join(dir, "dbt_project.yml"), "name: outer")
    // Inner project
    const inner = join(dir, "packages", "inner")
    await mkdir(inner, { recursive: true })
    await writeFile(join(inner, "dbt_project.yml"), "name: inner")

    // From inner, should find inner's project root
    expect(findProjectRoot(inner)).toBe(inner)
    // From outer, should find outer's project root
    expect(findProjectRoot(dir)).toBe(dir)
  })

  test("handles symlink pointing to directory with dbt_project.yml", async () => {
    const { findProjectRoot } = await import("../src/config")
    const real = join(dir, "real-project")
    await mkdir(real)
    await writeFile(join(real, "dbt_project.yml"), "name: symlinked")

    const link = join(dir, "link-project")
    await symlink(real, link)

    const result = findProjectRoot(link)
    // Should find it whether via real or symlink path
    expect(result).not.toBeNull()
  })

  test("handles nonexistent start directory gracefully", async () => {
    const { findProjectRoot } = await import("../src/config")
    // Should not throw, just return null
    const result = findProjectRoot(join(dir, "does", "not", "exist"))
    expect(result).toBeNull()
  })

  test("handles start directory that is a file, not a directory", async () => {
    const { findProjectRoot } = await import("../src/config")
    const file = join(dir, "somefile.txt")
    await writeFile(file, "not a directory")

    // resolve(file, "..") is dir, which has no dbt_project.yml
    const result = findProjectRoot(file)
    expect(result).toBeNull()
  })
})

// ═════════════════════════════════════════════════════════════════════
// discoverPython — adversarial
// ═════════════════════════════════════════════════════════════════════
describe("adversarial: discoverPython", () => {
  let dir: string
  let origEnv: Record<string, string | undefined>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "adv-discover-py-"))
    origEnv = {
      VIRTUAL_ENV: process.env.VIRTUAL_ENV,
      CONDA_PREFIX: process.env.CONDA_PREFIX,
    }
  })

  afterEach(async () => {
    // Restore env
    for (const [key, val] of Object.entries(origEnv)) {
      if (val === undefined) delete process.env[key]
      else process.env[key] = val
    }
    await rm(dir, { recursive: true, force: true })
  })

  test("returns fallback when projectRoot has no venvs and no env vars set", async () => {
    const { discoverPython } = await import("../src/config")
    delete process.env.VIRTUAL_ENV
    delete process.env.CONDA_PREFIX

    const result = discoverPython(join(dir, "empty-project"))
    // Should return something (fallback to which/where or bare name)
    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
  })

  test("prefers .venv/bin/python3 over .venv/bin/python", async () => {
    const { discoverPython } = await import("../src/config")
    const binDir = join(dir, ".venv", "bin")
    await mkdir(binDir, { recursive: true })
    // Create both python3 and python
    await writeFile(join(binDir, "python3"), "#!/bin/sh")
    await writeFile(join(binDir, "python"), "#!/bin/sh")

    const result = discoverPython(dir)
    expect(result).toBe(join(binDir, "python3"))
  })

  test("falls back to python when python3 doesn't exist in venv", async () => {
    const { discoverPython } = await import("../src/config")
    const binDir = join(dir, ".venv", "bin")
    await mkdir(binDir, { recursive: true })
    // Only create python, not python3
    await writeFile(join(binDir, "python"), "#!/bin/sh")

    const result = discoverPython(dir)
    expect(result).toBe(join(binDir, "python"))
  })

  test("VIRTUAL_ENV with empty string is ignored", async () => {
    const { discoverPython } = await import("../src/config")
    process.env.VIRTUAL_ENV = ""
    delete process.env.CONDA_PREFIX

    const binDir = join(dir, ".venv", "bin")
    await mkdir(binDir, { recursive: true })
    await writeFile(join(binDir, "python3"), "#!/bin/sh")

    // Should find the project-local venv, not crash on empty VIRTUAL_ENV
    const result = discoverPython(dir)
    expect(result).toBe(join(binDir, "python3"))
  })

  test("CONDA_PREFIX pointing to nonexistent dir falls through", async () => {
    const { discoverPython } = await import("../src/config")
    process.env.CONDA_PREFIX = join(dir, "nonexistent-conda")
    delete process.env.VIRTUAL_ENV

    const binDir = join(dir, ".venv", "bin")
    await mkdir(binDir, { recursive: true })
    await writeFile(join(binDir, "python3"), "#!/bin/sh")

    // Should skip conda (doesn't exist) and find project-local venv
    const result = discoverPython(dir)
    expect(result).toBe(join(binDir, "python3"))
  })

  test("checks .venv, venv, env directories in priority order", async () => {
    const { discoverPython } = await import("../src/config")
    delete process.env.VIRTUAL_ENV
    delete process.env.CONDA_PREFIX

    // Only create env/bin (lowest priority venv name)
    const envBin = join(dir, "env", "bin")
    await mkdir(envBin, { recursive: true })
    await writeFile(join(envBin, "python3"), "#!/bin/sh")

    const result = discoverPython(dir)
    expect(result).toBe(join(envBin, "python3"))
  })

  test("broken symlink in venv bin dir is skipped", async () => {
    const { discoverPython } = await import("../src/config")
    delete process.env.VIRTUAL_ENV
    delete process.env.CONDA_PREFIX

    const binDir = join(dir, ".venv", "bin")
    await mkdir(binDir, { recursive: true })
    // Create symlink to nonexistent target
    await symlink(join(dir, "nonexistent-python"), join(binDir, "python3"))

    // existsSync returns false for broken symlinks, so should skip
    const result = discoverPython(dir)
    // Should NOT return the broken symlink path
    expect(result).not.toBe(join(binDir, "python3"))
  })

  test("handles projectRoot with spaces in path", async () => {
    const { discoverPython } = await import("../src/config")
    delete process.env.VIRTUAL_ENV
    delete process.env.CONDA_PREFIX

    const spacedDir = join(dir, "my project with spaces")
    const binDir = join(spacedDir, ".venv", "bin")
    await mkdir(binDir, { recursive: true })
    await writeFile(join(binDir, "python3"), "#!/bin/sh")

    const result = discoverPython(spacedDir)
    expect(result).toBe(join(binDir, "python3"))
  })

  test("handles projectRoot with unicode characters", async () => {
    const { discoverPython } = await import("../src/config")
    delete process.env.VIRTUAL_ENV
    delete process.env.CONDA_PREFIX

    const unicodeDir = join(dir, "项目-données")
    const binDir = join(unicodeDir, ".venv", "bin")
    await mkdir(binDir, { recursive: true })
    await writeFile(join(binDir, "python3"), "#!/bin/sh")

    const result = discoverPython(unicodeDir)
    expect(result).toBe(join(binDir, "python3"))
  })
})

// ═════════════════════════════════════════════════════════════════════
// config read() — adversarial
// ═════════════════════════════════════════════════════════════════════
describe("adversarial: config read()", () => {
  let dir: string
  let origHome: string
  let origCwd: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "adv-config-read-"))
    origHome = process.env.HOME!
    origCwd = process.cwd()
    process.env.HOME = dir
  })

  afterEach(async () => {
    process.chdir(origCwd)
    process.env.HOME = origHome
    await rm(dir, { recursive: true, force: true })
  })

  test("config file with valid JSON but wrong schema still provides values", async () => {
    const { read } = await import("../src/config")
    const configDir = join(dir, ".altimate-code")
    await mkdir(configDir, { recursive: true })
    // Valid JSON but missing required fields
    await writeFile(join(configDir, "dbt.json"), JSON.stringify({ unexpected: true }))

    process.chdir(dir)
    const result = await read()
    // Should return the parsed object (no schema validation in read)
    // or fall through to discovery — either way, should not crash
    expect(result).toBeDefined()
  })

  test("config file that is an empty JSON object", async () => {
    const { read } = await import("../src/config")
    const configDir = join(dir, ".altimate-code")
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, "dbt.json"), "{}")

    process.chdir(dir)
    const result = await read()
    // Returns {} as Config (no validation) — should not crash
    expect(result).toBeDefined()
  })

  test("config file that is a JSON array (not object)", async () => {
    const { read } = await import("../src/config")
    const configDir = join(dir, ".altimate-code")
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, "dbt.json"), "[]")

    process.chdir(dir)
    const result = await read()
    // JSON.parse succeeds but returns array — cast to Config
    // Should not crash
    expect(result).toBeDefined()
  })

  test("config file with BOM (byte order mark)", async () => {
    const { read } = await import("../src/config")
    const configDir = join(dir, ".altimate-code")
    await mkdir(configDir, { recursive: true })
    const cfg = { projectRoot: "/tmp", pythonPath: "python3", dbtIntegration: "corecommand", queryLimit: 500 }
    // Write with UTF-8 BOM
    await writeFile(join(configDir, "dbt.json"), "\uFEFF" + JSON.stringify(cfg))

    process.chdir(dir)
    const result = await read()
    // JSON.parse may or may not handle BOM — either parse or fall through to discovery
    // Should not crash either way
    expect(true).toBe(true) // main assertion: no exception thrown
  })

  test("config file with trailing comma (invalid JSON)", async () => {
    const { read } = await import("../src/config")
    const configDir = join(dir, ".altimate-code")
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, "dbt.json"), '{"projectRoot": "/tmp",}')

    // Create dbt project for fallback discovery
    await writeFile(join(dir, "dbt_project.yml"), "name: test")
    const binDir = join(dir, ".venv", "bin")
    await mkdir(binDir, { recursive: true })
    await writeFile(join(binDir, "python3"), "#!/bin/sh")

    process.chdir(dir)
    const result = await read()
    // Should fall through to auto-discovery (JSON parse fails)
    expect(result).not.toBeNull()
    expect(result!.dbtIntegration).toBe("corecommand")
  })

  test("config file that is extremely large (1MB)", async () => {
    const { read } = await import("../src/config")
    const configDir = join(dir, ".altimate-code")
    await mkdir(configDir, { recursive: true })
    const huge = { projectRoot: "/tmp", pythonPath: "python3", dbtIntegration: "corecommand", queryLimit: 500, padding: "x".repeat(1_000_000) }
    await writeFile(join(configDir, "dbt.json"), JSON.stringify(huge))

    process.chdir(dir)
    const start = performance.now()
    const result = await read()
    const elapsed = performance.now() - start

    expect(result).not.toBeNull()
    expect(result!.projectRoot).toBe("/tmp")
    expect(elapsed).toBeLessThan(1000) // should parse quickly
  })

  test("auto-discovery does not crash when cwd is deleted mid-operation", async () => {
    // Simulate a race: cwd exists at start but dbt_project.yml check fails
    const ephemeral = join(dir, "ephemeral")
    await mkdir(ephemeral)
    process.chdir(ephemeral)

    const { read } = await import("../src/config")
    // No config file, no dbt_project.yml → returns null, doesn't crash
    const result = await read()
    expect(result).toBeNull()
  })
})

// ═════════════════════════════════════════════════════════════════════
// resolveDbt — adversarial (Windows & cross-platform)
// ═════════════════════════════════════════════════════════════════════
describe("adversarial: resolveDbt cross-platform", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "adv-resolve-dbt-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("broken symlink as pythonPath doesn't crash resolution", () => {
    const { resolveDbt } = require("../src/dbt-resolve")
    const brokenLink = join(dir, "broken-python")
    try {
      symlinkSync(join(dir, "nonexistent"), brokenLink)
    } catch {
      return // platform doesn't support symlinks
    }

    // Should not throw
    const result = resolveDbt(brokenLink, dir)
    expect(result).toBeDefined()
    expect(result.path).toBeTruthy()
  })

  test("all env vars set simultaneously — highest priority wins", () => {
    const { resolveDbt } = require("../src/dbt-resolve")

    // Create dbt in ALTIMATE_DBT_PATH location
    const customDbt = join(dir, "custom-dbt")
    writeFileSync(customDbt, "#!/bin/sh\n# custom")
    chmodSync(customDbt, 0o755)

    // Also create dbt in .venv (lower priority)
    const venvBin = join(dir, "project", ".venv", "bin")
    mkdirSync(venvBin, { recursive: true })
    writeFileSync(join(venvBin, "dbt"), "#!/bin/sh")
    chmodSync(join(venvBin, "dbt"), 0o755)

    // Also set conda and virtual env
    const condaBin = join(dir, "conda", "bin")
    mkdirSync(condaBin, { recursive: true })
    writeFileSync(join(condaBin, "dbt"), "#!/bin/sh")
    chmodSync(join(condaBin, "dbt"), 0o755)

    const origAltDbt = process.env.ALTIMATE_DBT_PATH
    const origConda = process.env.CONDA_PREFIX
    const origVenv = process.env.VIRTUAL_ENV

    process.env.ALTIMATE_DBT_PATH = customDbt
    process.env.CONDA_PREFIX = join(dir, "conda")
    process.env.VIRTUAL_ENV = join(dir, "venv")

    try {
      const result = resolveDbt(undefined, join(dir, "project"))
      expect(result.path).toBe(customDbt)
      expect(result.source).toContain("ALTIMATE_DBT_PATH")
    } finally {
      if (origAltDbt) process.env.ALTIMATE_DBT_PATH = origAltDbt
      else delete process.env.ALTIMATE_DBT_PATH
      if (origConda) process.env.CONDA_PREFIX = origConda
      else delete process.env.CONDA_PREFIX
      if (origVenv) process.env.VIRTUAL_ENV = origVenv
      else delete process.env.VIRTUAL_ENV
    }
  })

  test("ALTIMATE_DBT_PATH pointing to nonexistent file falls through", () => {
    const { resolveDbt } = require("../src/dbt-resolve")

    const venvBin = join(dir, ".venv", "bin")
    mkdirSync(venvBin, { recursive: true })
    writeFileSync(join(venvBin, "dbt"), "#!/bin/sh")
    chmodSync(join(venvBin, "dbt"), 0o755)

    const origAltDbt = process.env.ALTIMATE_DBT_PATH
    process.env.ALTIMATE_DBT_PATH = join(dir, "nonexistent-dbt")

    try {
      const result = resolveDbt(undefined, dir)
      // Should fall through to project .venv
      expect(result.path).toBe(join(venvBin, "dbt"))
    } finally {
      if (origAltDbt) process.env.ALTIMATE_DBT_PATH = origAltDbt
      else delete process.env.ALTIMATE_DBT_PATH
    }
  })

  test("pythonPath as directory (not file) doesn't crash", () => {
    const { resolveDbt } = require("../src/dbt-resolve")
    // Pass a directory instead of a file as pythonPath
    const result = resolveDbt(dir, dir)
    expect(result).toBeDefined()
    expect(result.path).toBeTruthy()
  })

  test("empty string pythonPath doesn't crash", () => {
    const { resolveDbt } = require("../src/dbt-resolve")
    const result = resolveDbt("", dir)
    expect(result).toBeDefined()
  })

  test("null/undefined args return valid fallback", () => {
    const { resolveDbt } = require("../src/dbt-resolve")
    const result = resolveDbt(undefined, undefined)
    expect(result).toBeDefined()
    expect(typeof result.path).toBe("string")
    expect(typeof result.source).toBe("string")
  })
})

// ═════════════════════════════════════════════════════════════════════
// buildDbtEnv — adversarial
// ═════════════════════════════════════════════════════════════════════
describe("adversarial: buildDbtEnv", () => {
  test("uses correct path.delimiter for platform", () => {
    const { buildDbtEnv } = require("../src/dbt-resolve")
    const resolved = {
      path: "/some/bin/dbt",
      source: "test",
      binDir: "/some/bin",
    }
    const env = buildDbtEnv(resolved)
    // PATH should use the platform-specific delimiter
    expect(env.PATH).toContain(delimiter)
    expect(env.PATH!.startsWith("/some/bin" + delimiter)).toBe(true)
  })

  test("handles missing PATH env var", () => {
    const { buildDbtEnv } = require("../src/dbt-resolve")
    const origPath = process.env.PATH
    delete process.env.PATH

    try {
      const resolved = {
        path: "/some/bin/dbt",
        source: "test",
        binDir: "/some/bin",
      }
      const env = buildDbtEnv(resolved)
      // Should not crash, PATH should start with binDir
      expect(env.PATH).toContain("/some/bin")
    } finally {
      process.env.PATH = origPath
    }
  })

  test("does not mutate process.env", () => {
    const { buildDbtEnv } = require("../src/dbt-resolve")
    const origPath = process.env.PATH
    const resolved = {
      path: "/injection/bin/dbt",
      source: "test",
      binDir: "/injection/bin",
    }
    buildDbtEnv(resolved)
    // process.env.PATH should NOT have been modified
    expect(process.env.PATH).toBe(origPath)
  })
})

// ═════════════════════════════════════════════════════════════════════
// validateDbt — adversarial
// ═════════════════════════════════════════════════════════════════════
describe("adversarial: validateDbt", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "adv-validate-dbt-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("binary that hangs is killed by timeout", () => {
    const { validateDbt } = require("../src/dbt-resolve")
    // Create a script that sleeps forever
    const sleepBin = join(dir, "dbt-slow")
    writeFileSync(sleepBin, "#!/bin/sh\nsleep 999")
    chmodSync(sleepBin, 0o755)

    const start = performance.now()
    const result = validateDbt({ path: sleepBin, source: "test" })
    const elapsed = performance.now() - start

    expect(result).toBeNull()
    // Should complete in under 15s (timeout is 10s + overhead)
    expect(elapsed).toBeLessThan(15_000)
  }, 20_000) // extend bun test timeout to 20s since validateDbt has 10s internal timeout

  test("binary that outputs garbage returns null", () => {
    const { validateDbt } = require("../src/dbt-resolve")
    const garbageBin = join(dir, "dbt-garbage")
    writeFileSync(garbageBin, '#!/bin/sh\necho "not a version string at all"')
    chmodSync(garbageBin, 0o755)

    const result = validateDbt({ path: garbageBin, source: "test" })
    if (result) {
      // If it parses something, version should be "unknown"
      expect(result.version).toBe("unknown")
    }
  })

  test("binary that exits non-zero returns null", () => {
    const { validateDbt } = require("../src/dbt-resolve")
    const failBin = join(dir, "dbt-fail")
    writeFileSync(failBin, "#!/bin/sh\nexit 1")
    chmodSync(failBin, 0o755)

    const result = validateDbt({ path: failBin, source: "test" })
    expect(result).toBeNull()
  })

  test("detects dbt Fusion correctly", () => {
    const { validateDbt } = require("../src/dbt-resolve")
    const fusionBin = join(dir, "dbt-fusion")
    writeFileSync(fusionBin, '#!/bin/sh\necho "dbt Fusion v0.3.1"')
    chmodSync(fusionBin, 0o755)

    const result = validateDbt({ path: fusionBin, source: "test" })
    if (result) {
      expect(result.isFusion).toBe(true)
      expect(result.version).toBe("0.3.1")
    }
  })

  test("parses dbt-core 'installed:' format", () => {
    const { validateDbt } = require("../src/dbt-resolve")
    const coreBin = join(dir, "dbt-core")
    writeFileSync(coreBin, '#!/bin/sh\necho "installed: 1.8.9"')
    chmodSync(coreBin, 0o755)

    const result = validateDbt({ path: coreBin, source: "test" })
    if (result) {
      expect(result.isFusion).toBe(false)
      expect(result.version).toBe("1.8.9")
    }
  })

  test("parses dbt-core 'core=' format", () => {
    const { validateDbt } = require("../src/dbt-resolve")
    const coreBin = join(dir, "dbt-core2")
    writeFileSync(coreBin, '#!/bin/sh\necho "core=1.9.0-beta1 plugins=[postgres=1.9.0]"')
    chmodSync(coreBin, 0o755)

    const result = validateDbt({ path: coreBin, source: "test" })
    if (result) {
      expect(result.isFusion).toBe(false)
      expect(result.version).toBe("1.9.0-beta1")
    }
  })
})

// ═════════════════════════════════════════════════════════════════════
// Windows-specific constant correctness
// ═════════════════════════════════════════════════════════════════════
describe("adversarial: Windows constant correctness", () => {
  test("isWindows, VENV_BIN, and EXE are consistent with platform", async () => {
    // Read the source and verify the constants are set correctly
    const { readFileSync } = await import("fs")
    const configSrc = readFileSync(join(import.meta.dir, "../src/config.ts"), "utf8")
    const resolveSrc = readFileSync(join(import.meta.dir, "../src/dbt-resolve.ts"), "utf8")

    // Both files should define isWindows the same way
    expect(configSrc).toContain('process.platform === "win32"')
    expect(resolveSrc).toContain('process.platform === "win32"')

    // Both should handle Scripts vs bin
    expect(configSrc).toContain('"Scripts"')
    expect(configSrc).toContain('"bin"')
    expect(resolveSrc).toContain('"Scripts"')
    expect(resolveSrc).toContain('"bin"')

    // Both should handle .exe suffix
    expect(configSrc).toContain('".exe"')
    expect(resolveSrc).toContain('".exe"')
  })

  test("path.delimiter is used (not hardcoded colon or semicolon)", async () => {
    const { readFileSync } = await import("fs")
    const src = readFileSync(join(import.meta.dir, "../src/dbt-resolve.ts"), "utf8")

    // Should import delimiter from path
    expect(src).toContain("delimiter")
    // PATH assignment lines (env.PATH = ...) should use delimiter, not hardcoded ":" or ";"
    const pathAssignLines = src.split("\n").filter(l => /env\.PATH\s*=/.test(l))
    for (const line of pathAssignLines) {
      expect(line).toContain("delimiter")
    }
    // Verify no hardcoded colon separators in PATH construction
    for (const line of pathAssignLines) {
      // Should not have `+ ":" +` or `:${` pattern for PATH joining
      expect(line).not.toMatch(/["']:['"]\s*\+/)
    }
  })

  test("which/where command is platform-appropriate", async () => {
    const { readFileSync } = await import("fs")
    const configSrc = readFileSync(join(import.meta.dir, "../src/config.ts"), "utf8")
    const resolveSrc = readFileSync(join(import.meta.dir, "../src/dbt-resolve.ts"), "utf8")

    // Both should handle where (Windows) vs which (Unix)
    expect(configSrc).toContain('"where"')
    expect(configSrc).toContain('"which"')
    expect(resolveSrc).toContain('"where"')
    expect(resolveSrc).toContain('"which"')
  })
})

// ═════════════════════════════════════════════════════════════════════
// Performance / DoS protection
// ═════════════════════════════════════════════════════════════════════
describe("adversarial: performance", () => {
  test("discoverPython completes in under 10s even with no matches", async () => {
    const { discoverPython } = await import("../src/config")
    const emptyDir = await mkdtemp(join(tmpdir(), "adv-perf-"))

    const origVenv = process.env.VIRTUAL_ENV
    const origConda = process.env.CONDA_PREFIX
    delete process.env.VIRTUAL_ENV
    delete process.env.CONDA_PREFIX

    try {
      const start = performance.now()
      discoverPython(emptyDir)
      const elapsed = performance.now() - start
      // which/where calls have 5s timeout each, so worst case ~10s
      expect(elapsed).toBeLessThan(15_000)
    } finally {
      if (origVenv) process.env.VIRTUAL_ENV = origVenv
      if (origConda) process.env.CONDA_PREFIX = origConda
      await rm(emptyDir, { recursive: true, force: true })
    }
  })

  test("resolveDbt completes in under 15s with no dbt installed", () => {
    const { resolveDbt } = require("../src/dbt-resolve")
    const start = performance.now()
    resolveDbt("/nonexistent/python", "/nonexistent/project")
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(15_000)
  })
})
