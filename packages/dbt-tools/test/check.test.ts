import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { all, fusionBinary, validate } from "../src/check"
import type { Config } from "../src/config"

// dbt Fusion is a native binary, so a Fusion user may have no Python at all. The lookup for a
// dbt 2.x binary is replaced here; the real one is dbt-integration's `findDbtV2Binary`.
const realFind = fusionBinary.find
const dirs: string[] = []

afterEach(() => {
  fusionBinary.find = realFind
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "dbt-check-"))
  dirs.push(dir)
  writeFileSync(join(dir, "dbt_project.yml"), "name: p\n")
  return dir
}

function config(overrides: Partial<Config>): Config {
  return { projectRoot: project(), pythonPath: "", dbtIntegration: "fusion", queryLimit: 500, ...overrides }
}

const FUSION = { path: "/home/u/.local/bin/dbt", version: [2, 0, 9], location: "installer" as const }

describe("prerequisites in dbt Fusion mode", () => {
  test("need no Python when a dbt 2.x binary resolves", async () => {
    const asked: unknown[] = []
    fusionBinary.find = async (options) => {
      asked.push(options)
      return FUSION
    }
    const cfg = config({})

    const result = await all(cfg)

    expect(result.passed).toBe(true)
    expect(Object.keys(result.checks).sort()).toEqual(["fusion", "project"])
    expect(asked[0]).toMatchObject({ pythonPath: undefined, cwd: cfg.projectRoot })
    expect(await validate(cfg)).toBeNull()
  })

  test("need no Python path in the config at all", async () => {
    fusionBinary.find = async () => FUSION
    const cfg = config({})
    delete (cfg as Partial<Config>).pythonPath

    expect((await all(cfg)).passed).toBe(true)
  })

  test("look for dbt next to a given interpreter, which needn't exist", async () => {
    const asked: unknown[] = []
    fusionBinary.find = async (options) => {
      asked.push(options)
      return FUSION
    }

    const result = await all(config({ pythonPath: "/no/venv/bin/python" }))

    expect(result.passed).toBe(true)
    expect(asked[0]).toMatchObject({ pythonPath: "/no/venv/bin/python" })
  })

  test("fail, and say where they looked, when no dbt 2.x binary resolves", async () => {
    fusionBinary.find = async () => undefined

    const issue = await validate(config({}))

    expect(issue).toContain("Prerequisites not met")
    expect(issue).toContain("fusion: dbt Fusion was not found: no dbt 2.x binary in ~/.local/bin or on PATH")
  })

  test("still require the project", async () => {
    fusionBinary.find = async () => FUSION

    const result = await all(config({ projectRoot: "/definitely/not/a/project" }))

    expect(result.passed).toBe(false)
    expect(result.checks.project?.ok).toBe(false)
  })
})

describe("prerequisites in other modes", () => {
  test("still require Python and dbt-core, and never look for Fusion", async () => {
    fusionBinary.find = async () => {
      throw new Error("the Fusion lookup must not run outside Fusion mode")
    }

    for (const dbtIntegration of ["core", "corecommand", "cloud"]) {
      const result = await all(config({ dbtIntegration }))
      expect(result.passed).toBe(false)
      expect(Object.keys(result.checks).sort()).toEqual(["dbt", "project", "python"])
      expect(result.checks).toMatchObject({ python: { ok: false, error: "No Python path configured" } })
    }
  })
})
