import { describe, test, expect } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { create } from "../src/adapter"

/** A stand-in `python` that records the DBT_TARGET_PATH each run sees and fails the bridge run. */
function recordingPython(root: string) {
  const log = join(root, "target-path.log")
  const python = join(root, "python")
  writeFileSync(
    python,
    [
      "#!/bin/sh",
      `printf '%s\\n' "\${DBT_TARGET_PATH-unset}" >> '${log}'`,
      'case "$1" in',
      '  --version) echo "Python 3.11.9"; exit 0 ;;',
      '  -c) echo "1.10.0"; exit 0 ;;',
      "esac",
      "exit 3",
    ].join("\n") + "\n",
  )
  chmodSync(python, 0o755)
  return { python, seen: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []) }
}

// The adapter's dbt commands rewrite manifest.json in the target folder they are given; a caller that
// compiles for its own reading gives one of its own, so the project's target/manifest.json is left alone.
describe.skipIf(process.platform === "win32")("create's target folder", () => {
  const start = async (targetPath?: string) => {
    const root = mkdtempSync(join(tmpdir(), "dbt-tools-target-"))
    const project = join(root, "project")
    mkdirSync(project)
    writeFileSync(join(project, "dbt_project.yml"), "name: p\nversion: '1.0'\nprofile: p\n")
    const { python, seen } = recordingPython(root)
    const saved = process.env.DBT_TARGET_PATH
    delete process.env.DBT_TARGET_PATH
    try {
      await create(
        { projectRoot: project, pythonPath: python, dbtIntegration: "corecommand", queryLimit: 500 },
        targetPath ? { targetPath } : undefined,
      ).then(
        (adapter) => adapter.dispose(),
        () => {},
      )
      // The host's own environment is not changed: other readers of DBT_TARGET_PATH still see the project's.
      expect(process.env.DBT_TARGET_PATH).toBeUndefined()
      return seen()
    } finally {
      if (saved === undefined) delete process.env.DBT_TARGET_PATH
      else process.env.DBT_TARGET_PATH = saved
      rmSync(root, { recursive: true, force: true })
    }
  }

  test("every dbt process the adapter starts writes to the folder it is given", async () => {
    const runs = await start("/tmp/project/target/.altimate-code")
    expect(runs.length).toBeGreaterThan(0)
    expect(new Set(runs)).toEqual(new Set(["/tmp/project/target/.altimate-code"]))
  })

  test("without one, dbt writes where the project says", async () => {
    const runs = await start()
    expect(runs.length).toBeGreaterThan(0)
    expect(new Set(runs)).toEqual(new Set(["unset"]))
  })
})
