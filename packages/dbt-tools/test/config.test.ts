import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { realpathSync } from "fs"

describe("config", () => {
  let dir: string
  let originalHome: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dbt-tools-test-"))
    originalHome = process.env.HOME!
    process.env.HOME = dir
  })

  afterEach(async () => {
    process.env.HOME = originalHome
    await rm(dir, { recursive: true, force: true })
  })

  test("read returns null for missing file", async () => {
    const origCwd = process.cwd()
    process.chdir(dir)
    try {
      const { read } = await import("../src/config")
      const result = await read()
      expect(result).toBeNull()
    } finally {
      process.chdir(origCwd)
    }
  })

  test("write and read round-trip", async () => {
    const { read, write } = await import("../src/config")
    const cfg = {
      projectRoot: "/tmp/my-dbt-project",
      pythonPath: "/usr/bin/python3",
      dbtIntegration: "corecommand",
      queryLimit: 500,
    }

    await write(cfg)
    const result = await read()
    expect(result).toEqual(cfg)
  })

  test("write creates .altimate-code directory", async () => {
    const { write } = await import("../src/config")
    const { existsSync } = await import("fs")
    const cfg = {
      projectRoot: "/tmp/project",
      pythonPath: "/usr/bin/python3",
      dbtIntegration: "corecommand",
      queryLimit: 1000,
    }

    await write(cfg)
    expect(existsSync(join(dir, ".altimate-code", "dbt.json"))).toBe(true)
  })

  test("read auto-discovers from cwd when no config file exists", async () => {
    // Create a fake dbt project in the temp dir
    await writeFile(join(dir, "dbt_project.yml"), "name: test")
    // Create a fake python3 binary so discoverPython finds it
    const binDir = join(dir, ".venv", "bin")
    await mkdir(binDir, { recursive: true })
    await writeFile(join(binDir, "python3"), "#!/bin/sh")

    const origCwd = process.cwd()
    process.chdir(dir)
    try {
      // Re-import to get fresh module state
      const { read } = await import("../src/config")
      const result = await read()
      expect(result).not.toBeNull()
      expect(realpathSync(result!.projectRoot)).toBe(realpathSync(dir))
      expect(result!.dbtIntegration).toBe("corecommand")
      expect(result!.queryLimit).toBe(500)
    } finally {
      process.chdir(origCwd)
    }
  })

  test("read falls back to auto-discovery on malformed config file", async () => {
    const { read } = await import("../src/config")
    // Write a malformed JSON config file
    const configDir = join(dir, ".altimate-code")
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, "dbt.json"), "{ invalid json !!!")

    // Create a dbt project so auto-discovery has something to find
    await writeFile(join(dir, "dbt_project.yml"), "name: test")
    const binDir = join(dir, ".venv", "bin")
    await mkdir(binDir, { recursive: true })
    await writeFile(join(binDir, "python3"), "#!/bin/sh")

    const origCwd = process.cwd()
    process.chdir(dir)
    try {
      const result = await read()
      // Should fall through to auto-discovery instead of crashing
      expect(result).not.toBeNull()
      expect(result!.dbtIntegration).toBe("corecommand")
    } finally {
      process.chdir(origCwd)
    }
  })

  test("read returns null when no config file and no dbt_project.yml in cwd", async () => {
    // dir has no dbt_project.yml and HOME has no config file
    const origCwd = process.cwd()
    process.chdir(dir)
    try {
      const { read } = await import("../src/config")
      const result = await read()
      expect(result).toBeNull()
    } finally {
      process.chdir(origCwd)
    }
  })
})

// ---------------------------------------------------------------------------
// findProjectRoot
// ---------------------------------------------------------------------------
describe("findProjectRoot", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dbt-find-root-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test("returns directory containing dbt_project.yml", async () => {
    const { findProjectRoot } = await import("../src/config")
    await writeFile(join(dir, "dbt_project.yml"), "name: test")
    expect(findProjectRoot(dir)).toBe(dir)
  })

  test("walks up from a subdirectory", async () => {
    const { findProjectRoot } = await import("../src/config")
    await writeFile(join(dir, "dbt_project.yml"), "name: test")
    const sub = join(dir, "models", "staging")
    await mkdir(sub, { recursive: true })
    expect(findProjectRoot(sub)).toBe(dir)
  })

  test("returns null when no dbt_project.yml found", async () => {
    const { findProjectRoot } = await import("../src/config")
    expect(findProjectRoot(dir)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// discoverPython
// ---------------------------------------------------------------------------
describe("discoverPython", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dbt-discover-python-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test("falls back to project-local .venv/bin/python3", async () => {
    const { discoverPython } = await import("../src/config")

    const binDir = join(dir, ".venv", "bin")
    await mkdir(binDir, { recursive: true })
    await writeFile(join(binDir, "python3"), "#!/bin/sh")

    const result = discoverPython(dir)
    expect(result).toBe(join(binDir, "python3"))
  })

  test("tries python3 before python in each location", async () => {
    const { discoverPython } = await import("../src/config")

    const binDir = join(dir, ".venv", "bin")
    await mkdir(binDir, { recursive: true })
    // Only create python3, not python
    await writeFile(join(binDir, "python3"), "#!/bin/sh")

    const result = discoverPython(dir)
    expect(result).toBe(join(binDir, "python3"))
  })
})
