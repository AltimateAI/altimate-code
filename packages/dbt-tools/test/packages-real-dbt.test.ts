// Real dbt + real built altimate-dbt (dist/index.js): concurrent invocations must
// not each run `dbt deps`. Skipped when dist/ is not built or dbt-duckdb is not
// installed. Uses a local package, so it needs no network.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn, spawnSync } from "child_process"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"

const DIST = process.env.ALTIMATE_DBT_DIST ?? join(import.meta.dir, "..", "dist", "index.js")

function findDbt(): string | undefined {
  const r = spawnSync("dbt", ["--version"], { encoding: "utf-8", timeout: 20_000 })
  if (r.status !== 0 || !/duckdb/i.test(`${r.stdout}${r.stderr}`)) return undefined
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["dbt"], { encoding: "utf-8" })
  return which.stdout.trim().split(/\r?\n/)[0] || undefined
}

const REAL_DBT = existsSync(DIST) ? findDbt() : undefined
const suite = REAL_DBT ? describe : describe.skip

let work = ""
let proj = ""
let shim = ""
let log = ""
let env: Record<string, string> = {}

const CONCURRENCY = 4

function dbtSync(args: string[]) {
  return spawnSync(REAL_DBT!, args, { cwd: proj, encoding: "utf-8", env: { ...process.env, ...env }, timeout: 120_000 })
}

function runAltimateDbt(i: number) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const c = spawn(
      "node",
      [DIST, "schema-verify", "--model", "m"],
      { cwd: proj, env: { ...process.env, ...env, E2E_DB: join(proj, `db${i}.duckdb`) } },
    )
    let out = ""
    c.stdout.on("data", (d) => (out += d))
    c.stderr.on("data", (d) => (out += d))
    c.on("close", (code) => resolve({ code, out }))
  })
}

const depsCalls = () =>
  existsSync(log) ? readFileSync(log, "utf-8").split("\n").filter((l) => l.split(" ")[0] === "deps").length : 0

const packageHealthy = () => existsSync(join(proj, "dbt_packages", "localpkg", "dbt_project.yml"))

suite("real dbt: concurrent altimate-dbt invocations and `dbt deps`", () => {
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "dbt-pkgs-real-"))
    proj = join(work, "proj")
    const pkg = join(work, "localpkg")
    mkdirSync(join(pkg, "macros"), { recursive: true })
    writeFileSync(join(pkg, "dbt_project.yml"), "name: localpkg\nversion: '0.1.0'\nconfig-version: 2\n")
    writeFileSync(join(pkg, "macros", "one.sql"), "{% macro one() %}1{% endmacro %}\n")
    mkdirSync(join(proj, "models"), { recursive: true })
    mkdirSync(join(proj, "seeds"), { recursive: true })
    writeFileSync(join(proj, "dbt_project.yml"), "name: proj\nversion: '1.0'\nconfig-version: 2\nprofile: proj\n")
    writeFileSync(
      join(proj, "profiles.yml"),
      "proj:\n  target: dev\n  outputs:\n    dev:\n      type: duckdb\n      path: \"{{ env_var('E2E_DB', 'e2e.duckdb') }}\"\n      threads: 1\n",
    )
    writeFileSync(join(proj, "packages.yml"), "packages:\n  - local: ../localpkg\n")
    writeFileSync(join(proj, "seeds", "raw.csv"), "id,name\n1,a\n2,b\n")
    writeFileSync(join(proj, "models", "m.sql"), "select id, name, {{ localpkg.one() }} as one from {{ ref('raw') }}\n")
    writeFileSync(join(proj, "models", "m.yml"), "version: 2\nmodels:\n  - name: m\n    columns:\n      - name: id\n")

    // A `dbt` that records its subcommand, then runs the real one. Both the dbt-tools resolver
    // (ALTIMATE_DBT_PATH) and the integration library (PATH) will find it.
    log = join(work, "dbt-calls.log")
    const bin = join(work, "bin")
    mkdirSync(bin)
    shim = join(bin, "dbt")
    writeFileSync(shim, `#!/bin/sh\necho "$@" >> "${log}"\nexec "${REAL_DBT}" "$@"\n`)
    chmodSync(shim, 0o755)
    const home = join(work, "home")
    mkdirSync(home)
    env = {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
      ALTIMATE_DBT_PATH: shim,
    }
    // The library looks for dbt next to the configured python, so point it at a directory
    // whose `dbt` is the recording shim.
    const venvBin = join(work, "venv", "bin")
    mkdirSync(venvBin, { recursive: true })
    copyFileSync(shim, join(venvBin, "dbt"))
    chmodSync(join(venvBin, "dbt"), 0o755)
    const realPython = join(dirname(REAL_DBT!), "python3")
    // A wrapper, not a symlink: python finds its site-packages relative to the real executable.
    writeFileSync(join(venvBin, "python3"), `#!/bin/sh\nexec "${existsSync(realPython) ? realPython : "python3"}" "$@"\n`)
    chmodSync(join(venvBin, "python3"), 0o755)
    const init = spawnSync("node", [DIST, "init", "--project-root", proj, "--python-path", join(venvBin, "python3")], {
      env: { ...process.env, ...env },
      encoding: "utf-8",
    })
    expect(init.status).toBe(0)

    // Prepare a built project (the shim records these calls too; the log is cleared below).
    expect(dbtSync(["deps"]).status).toBe(0)
    expect(dbtSync(["build"]).status).toBe(0)
    for (let i = 0; i < CONCURRENCY; i++) copyFileSync(join(proj, "e2e.duckdb"), join(proj, `db${i}.duckdb`))
  }, 180_000)

  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true })
  })

  test("packages already installed: concurrent invocations run `dbt deps` zero times", async () => {
    writeFileSync(log, "")
    expect(packageHealthy()).toBe(true)
    const runs = await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => runAltimateDbt(i)))
    expect(runs.every((r) => !/No dbt_project\.yml found/.test(r.out))).toBe(true)
    expect(depsCalls()).toBe(0)
    expect(packageHealthy()).toBe(true)
  }, 120_000)

  test("packages missing: concurrent invocations install exactly once and leave a healthy directory", async () => {
    rmSync(join(proj, "dbt_packages"), { recursive: true, force: true })
    rmSync(join(proj, "target", ".altimate-dbt"), { recursive: true, force: true })
    writeFileSync(log, "")
    const runs = await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => runAltimateDbt(i)))
    expect(runs.every((r) => !/No dbt_project\.yml found/.test(r.out))).toBe(true)
    expect(depsCalls()).toBe(1)
    expect(packageHealthy()).toBe(true)
  }, 120_000)

  test("a package directory left without dbt_project.yml is repaired by the next invocation", async () => {
    rmSync(join(proj, "dbt_packages", "localpkg"), { recursive: true, force: true })
    mkdirSync(join(proj, "dbt_packages", "localpkg"), { recursive: true }) // present but empty
    writeFileSync(log, "")
    await runAltimateDbt(0)
    expect(depsCalls()).toBe(1)
    expect(packageHealthy()).toBe(true)
  }, 120_000)
})
