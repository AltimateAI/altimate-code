/**
 * tool-detection.ts — probes `dbt --version` output to decide whether the
 * user's local toolchain can run the sample's dbt build workflow.
 *
 * These tests exercise the REAL `detectDbtRuntime()` end-to-end by putting
 * a fake `dbt` script first on PATH. Each scenario drops a shell stub that
 * emits a scripted stdout/stderr + exit code, then asserts on what the
 * real parser inside probe() extracts. If the impl regex or shape changes,
 * these tests will catch it — unlike an earlier version that duplicated
 * the regex constants into the test file and asserted against those.
 */

import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { _resetDbtRuntimeCacheForTests, detectDbtRuntime } from "../../../src/altimate/onboarding/tool-detection"

const ORIG_PATH = process.env.PATH ?? ""
const ORIG_ALTIMATE_DBT_PATH = process.env.ALTIMATE_DBT_PATH

afterEach(() => {
  process.env.PATH = ORIG_PATH
  if (ORIG_ALTIMATE_DBT_PATH === undefined) delete process.env.ALTIMATE_DBT_PATH
  else process.env.ALTIMATE_DBT_PATH = ORIG_ALTIMATE_DBT_PATH
  _resetDbtRuntimeCacheForTests()
})

/**
 * Drop a fake `dbt` executable in a fresh tmpdir and pin `resolveDbt` at it
 * via `ALTIMATE_DBT_PATH` — that env var is the FIRST candidate `resolveDbt`
 * tries, so it takes precedence over PATH / venv / brew / etc. That's the
 * only way to isolate the probe on a machine that has a real dbt somewhere
 * (which most dev machines do).
 *
 * Also prepends the stub dir to PATH so any downstream re-invocation of
 * `dbt` (e.g. our `captureVersionOutput` for the plugin list) hits the stub.
 * The script echoes the given stdout+stderr per real dbt (which prints its
 * `--version` output on stderr with color codes on some versions, stdout
 * on others — probe() reads both to catch the stderr variant).
 */
function stubDbt(opts: { stdout?: string; stderr?: string; exitCode?: number }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-detection-stub-"))
  const script = path.join(dir, "dbt")
  const stdout = opts.stdout ?? ""
  const stderr = opts.stderr ?? ""
  const exit = opts.exitCode ?? 0
  const payload = `#!/usr/bin/env bash
cat <<'STDOUT'
${stdout}
STDOUT
cat <<'STDERR' 1>&2
${stderr}
STDERR
exit ${exit}
`
  fs.writeFileSync(script, payload, { mode: 0o755 })
  process.env.ALTIMATE_DBT_PATH = script
  process.env.PATH = `${dir}:${ORIG_PATH}`
  return dir
}

/** Stub that isn't executable (models a `dbt` file that exists but can't run).
 *  Pinned via ALTIMATE_DBT_PATH so resolveDbt returns THIS broken file
 *  rather than falling through to a real system dbt. */
function stubBrokenDbt(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-detection-broken-"))
  const broken = path.join(dir, "dbt")
  fs.writeFileSync(broken, "not-a-script", { mode: 0o644 })
  process.env.ALTIMATE_DBT_PATH = broken
  process.env.PATH = dir
  return dir
}

/** Point ALTIMATE_DBT_PATH at a nonexistent path AND scrub PATH so
 *  resolveDbt can't fall through to any dbt on the host. */
function stubNoDbt(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-detection-nodbt-"))
  process.env.ALTIMATE_DBT_PATH = path.join(dir, "does-not-exist-dbt")
  // Clear PATH entirely — no host dbt should be reachable via the fallback path.
  process.env.PATH = dir
  return dir
}

describe("detectDbtRuntime — real subprocess invocation via PATH override", () => {
  test("dbt 1.11 with duckdb plugin → hasDbt=true, hasDbtDuckdb=true, correct version", async () => {
    stubDbt({
      stdout: `Core:
  - installed: 1.11.8
  - latest:    1.12.0 - Update available!

Plugins:
  - duckdb: 1.11.4 - Update available!
`,
    })
    const runtime = await detectDbtRuntime({ force: true })
    expect(runtime.hasDbt).toBe(true)
    expect(runtime.hasDbtDuckdb).toBe(true)
    expect(runtime.dbtCoreVersion).toBe("1.11.8")
  })

  test("dbt with only non-duckdb plugins → hasDbt=true, hasDbtDuckdb=false", async () => {
    stubDbt({
      stdout: `Core:
  - installed: 1.11.8

Plugins:
  - snowflake: 1.11.0
  - bigquery:  1.11.1
`,
    })
    const runtime = await detectDbtRuntime({ force: true })
    expect(runtime.hasDbt).toBe(true)
    expect(runtime.hasDbtDuckdb).toBe(false)
    expect(runtime.dbtCoreVersion).toBe("1.11.8")
  })

  test("'duckdb' as substring in a prose line → NOT detected as adapter", async () => {
    stubDbt({
      stdout: `Core:
  - installed: 1.11.8
  - latest:    1.12.0

Try installing dbt-duckdb for a local warehouse.
`,
    })
    const runtime = await detectDbtRuntime({ force: true })
    expect(runtime.hasDbtDuckdb).toBe(false)
    expect(runtime.dbtCoreVersion).toBe("1.11.8")
  })

  test("dbt writes its version on STDERR (some 1.x versions do this) → still parsed", async () => {
    stubDbt({
      stderr: `Core:
  - installed: 1.10.2

Plugins:
  - duckdb: 1.10.0
`,
    })
    const runtime = await detectDbtRuntime({ force: true })
    expect(runtime.hasDbt).toBe(true)
    expect(runtime.hasDbtDuckdb).toBe(true)
    expect(runtime.dbtCoreVersion).toBe("1.10.2")
  })

  test("dbt exits non-zero → treated as not usable (hasDbt=false)", async () => {
    stubDbt({ stdout: "some noise", exitCode: 2 })
    const runtime = await detectDbtRuntime({ force: true })
    expect(runtime.hasDbt).toBe(false)
    expect(runtime.hasDbtDuckdb).toBe(false)
    expect(runtime.dbtCoreVersion).toBeUndefined()
  })

  // Test removed: the earlier "PATH points at empty dir → hasDbt=false"
  // assertion no longer holds. resolveDbt intentionally walks past PATH to
  // known venv/pipx/brew/pyenv locations (that's the whole point of the
  // dbt-tools refactor). If any of those host paths exist on the test
  // machine, resolveDbt finds them and hasDbt=true — which is CORRECT
  // behavior for a user who has dbt in a venv but not on PATH.
  //
  // The "dbt truly not findable" case is covered by the "not executable"
  // test below: ALTIMATE_DBT_PATH pins resolveDbt at a broken candidate,
  // validateDbt fails, hasDbt=false.
  test.skip("dbt not on PATH at all → hasDbt=false (obsolete — resolveDbt walks past PATH)", async () => {
    stubNoDbt()
    const runtime = await detectDbtRuntime({ force: true })
    expect(runtime.hasDbt).toBe(false)
    expect(runtime.hasDbtDuckdb).toBe(false)
  })

  test("dbt file exists but is not executable → hasDbt=false", async () => {
    stubBrokenDbt()
    const runtime = await detectDbtRuntime({ force: true })
    expect(runtime.hasDbt).toBe(false)
    expect(runtime.hasDbtDuckdb).toBe(false)
  })

  test("cached call returns same result without re-invoking (perf contract)", async () => {
    stubDbt({
      stdout: `Core:
  - installed: 1.11.8

Plugins:
  - duckdb: 1.11.4
`,
    })
    const first = await detectDbtRuntime({ force: true })
    // Change the stub to return DIFFERENT output — if the cache isn't
    // honored, the second call would see the new content.
    stubDbt({
      stdout: `Core:
  - installed: 9.9.9

Plugins:
  - snowflake: 9.9.9
`,
    })
    const second = await detectDbtRuntime() // NO force → must use cache
    expect(second).toEqual(first)
    // And with force → re-probes.
    const third = await detectDbtRuntime({ force: true })
    expect(third.dbtCoreVersion).toBe("9.9.9")
    expect(third.hasDbtDuckdb).toBe(false)
  })
})
