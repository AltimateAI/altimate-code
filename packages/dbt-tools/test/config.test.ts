import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir, homedir } from "os"

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
    const { read } = await import("../src/config")
    const result = await read()
    expect(result).toBeNull()
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
})
