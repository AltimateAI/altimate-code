import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DbtBuildGreenValidator } from "../../opencode/src/altimate/validators/dbt-build-green"

const dist = join(import.meta.dir, "../dist/index.js")
const dbt = Bun.which("dbt")
const version = dbt && existsSync(dist) ? spawnSync(dbt, ["--version"], { encoding: "utf8", timeout: 20_000 }) : undefined
const realTest = version?.status === 0 && /duckdb/i.test(version.stdout) && process.platform !== "win32" ? test : test.skip

for (const mode of ["model", "project", "red"] as const) {
  realTest(`real dbt ${mode} build retains its execution artifact`, async () => {
    const root = mkdtempSync(join(tmpdir(), "dbt-build-artifact-"))
    try {
      mkdirSync(join(root, "models"))
      writeFileSync(join(root, "dbt_project.yml"), "name: artifact\nversion: '1.0'\nconfig-version: 2\nprofile: artifact\ntarget-path: artifacts\n")
      writeFileSync(join(root, "profiles.yml"), "artifact:\n  target: dev\n  outputs:\n    dev:\n      type: duckdb\n      path: artifact.duckdb\n      threads: 1\n")
      writeFileSync(join(root, "models/orders.sql"), mode === "red" ? "select missing_column as id\n" : "select 1 as id\n")
      writeFileSync(join(root, "models/orders.yml"), "version: 2\nmodels:\n  - name: orders\n    columns:\n      - name: id\n        tests: [not_null]\n")
      const run = (...args: string[]) => spawnSync("node", [dist, ...args], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, ".config"), DBT_PROFILES_DIR: root, ALTIMATE_DBT_PATH: dbt ?? undefined },
        timeout: 90_000,
      })
      if (mode === "model") {
        mkdirSync(join(root, "local_pkg"))
        writeFileSync(join(root, "local_pkg/dbt_project.yml"), "name: local_pkg\nversion: '1.0'\nconfig-version: 2\n")
        writeFileSync(join(root, "packages.yml"), "packages:\n  - local: local_pkg\n")
      }
      const init = run("init", "--project-root", root, "--python-path", join(dirname(dbt!), "python3"))
      expect(init.status, init.stdout + init.stderr).toBe(0)
      const output = run("build", ...(mode === "project" ? [] : ["--model", "orders"]))
      const artifact = JSON.parse(readFileSync(join(root, "artifacts/run_results.json"), "utf8"))
      expect(artifact.args.which, output.stdout + output.stderr).toBe("build")
      expect(artifact.results.some((row: { status: string }) => row.status === (mode === "red" ? "error" : "pass"))).toBe(true)
      if (mode !== "red") {
        expect(output.status, output.stdout + output.stderr).toBe(0)
        const response = JSON.parse(output.stdout)
        if (mode === "project") expect(response.schema_verify_summary.match).toBe(1)
        else expect(response.schema_verify.verdict).toBe("match")
        expect(response.notes.join(" ")).toContain("Schema verification ran after build")
        if (mode === "model") expect(response.notes.join(" ")).toContain("re-installed packages and reset")
      }
      const validation = await DbtBuildGreenValidator.check({
        sessionID: "artifact",
        workingDirectory: root,
        sessionStartMs: 0,
        step: 1,
        retryCount: 0,
      })
      expect(validation.ok, validation.reason).toBe(mode !== "red")
      if (mode === "model") {
        writeFileSync(join(root, "models/untested.sql"), "select 2 as id\n")
        const untested = run("test", "--model", "untested", "--format", "text")
        expect(untested.status, untested.stdout + untested.stderr).toBe(0)
        expect(untested.stdout).toContain("Model has no tests")
        expect(untested.stdout).not.toContain("Nothing to do")
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)
}
