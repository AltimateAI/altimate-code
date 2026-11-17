import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { homedir, tmpdir } from "os"
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
    // As the adapter judges a candidate: script launchers count, and `--version` gets 15 s.
    expect(asked[0]).toMatchObject({ skipScripts: false, timeoutMs: 15_000 })
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

  test("name the interpreter they looked next to, when the config has one", async () => {
    fusionBinary.find = async () => undefined

    const issue = await validate(config({ pythonPath: "/no/venv/bin/python" }))

    expect(issue).toContain(
      "fusion: dbt Fusion was not found: no dbt 2.x binary next to /no/venv/bin/python, in ~/.local/bin or on PATH",
    )
  })

  test("still require the project", async () => {
    fusionBinary.find = async () => FUSION

    const result = await all(config({ projectRoot: "/definitely/not/a/project" }))

    expect(result.passed).toBe(false)
    expect(result.checks.project?.ok).toBe(false)
  })
})

// The real lookup, through the CLI in its own process: another test file here mocks
// `child_process`, and bun's module mocks reach every file of the run. A stand-in `dbt` is the
// only thing on PATH. The lookup always tries ~/.local/bin/dbt first (Bun ignores HOME for that),
// so the rejection test can't run where that is a real Fusion.
function realFusionInLocalBin(): boolean {
  const dbt = join(homedir(), ".local", "bin", "dbt")
  if (!existsSync(dbt)) return false
  try {
    return /^dbt(-fusion)? 2\./m.test(execFileSync(dbt, ["--version"], { encoding: "utf-8", timeout: 15_000 }))
  } catch {
    return false
  }
}

describe.skipIf(process.platform === "win32")("the Fusion lookup, run by `altimate-dbt doctor`", () => {
  const entry = join(import.meta.dir, "../src/index.ts")

  /** `doctor` in Fusion mode with no Python path, and a `dbt` on PATH that prints `versionLine`. */
  function doctorWith(versionLine: string): { passed: boolean; checks: { check: string; status: string }[] } {
    const home = mkdtempSync(join(tmpdir(), "dbt-check-home-"))
    dirs.push(home)
    const bin = join(home, "bin")
    mkdirSync(bin)
    writeFileSync(join(bin, "dbt"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${versionLine}"; fi\nexit 0\n`, {
      mode: 0o755,
    })
    mkdirSync(join(home, ".altimate-code"))
    writeFileSync(
      join(home, ".altimate-code", "dbt.json"),
      JSON.stringify({ projectRoot: project(), dbtIntegration: "fusion", queryLimit: 500 }),
    )
    const result = Bun.spawnSync([process.execPath, entry, "doctor"], { env: { HOME: home, PATH: bin } })
    return JSON.parse(result.stdout.toString())
  }

  test("accepts a Fusion behind a script launcher that reports 2.x", () => {
    const report = doctorWith("dbt 2.0.9")

    expect(report.passed).toBe(true)
    expect(report.checks).toContainEqual({ check: "fusion", status: "ok" })
  })

  test.skipIf(realFusionInLocalBin())("still rejects dbt Core", () => {
    const report = doctorWith("Core: installed: 1.10.23")

    expect(report.passed).toBe(false)
    expect(report.checks).toContainEqual(expect.objectContaining({ check: "fusion", status: "fail" }))
  })
})

describe("prerequisites in other modes", () => {
  const noFusion = async (): Promise<never> => {
    throw new Error("the Fusion lookup must not run outside Fusion mode")
  }

  test("still require a Python path, and never look for Fusion", async () => {
    fusionBinary.find = noFusion

    for (const dbtIntegration of ["core", "corecommand", "cloud"]) {
      const result = await all(config({ dbtIntegration }))
      expect(result.passed).toBe(false)
      expect(Object.keys(result.checks).sort()).toEqual(["dbt", "project", "python"])
      expect(result.checks).toMatchObject({ python: { ok: false, error: "No Python path configured" } })
    }
  })

  // A stand-in interpreter that runs but has no dbt-core: `--version` works, every other run fails.
  test.skipIf(process.platform === "win32")("still require dbt-core in a working Python", async () => {
    fusionBinary.find = noFusion
    const dir = mkdtempSync(join(tmpdir(), "dbt-check-py-"))
    dirs.push(dir)
    const python = join(dir, "python")
    writeFileSync(python, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Python 3.11.0"; exit 0; fi\nexit 1\n', {
      mode: 0o755,
    })

    for (const dbtIntegration of ["core", "corecommand", "cloud"]) {
      const result = await all(config({ dbtIntegration, pythonPath: python }))
      expect(result.passed).toBe(false)
      expect(result.checks.python?.ok).toBe(true)
      expect(result.checks).toMatchObject({
        dbt: { ok: false, error: "dbt-core is not installed in the configured Python environment" },
      })
      expect(result.checks.project?.ok).toBe(true)
    }
  })
})
