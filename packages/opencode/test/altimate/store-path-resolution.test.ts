/**
 * Regression tests for warehouse store path resolution and create-on-open.
 *
 * Reported defect: `altimate-code run --dir <path>` made a populated DuckDB
 * store read as empty, with no error. `--dir` calls `process.chdir()`
 * (src/cli/cmd/run.ts), a relative store path in a connection config resolved
 * against the new working directory, and the file-backed driver answered the
 * miss by CREATING an empty database. Every query then succeeded and returned
 * nothing.
 *
 * These tests run a COMPILED binary built with the production build options
 * (packages/opencode/script/build.ts: bundled sources, warehouse SDKs external,
 * no bunfig/dotenv autoload), invoked with `--dir` from an unrelated working
 * directory. An in-process `bun test` cannot see this defect: the package's own
 * node_modules stays reachable and the cwd is the test runner's, not the rig's.
 *
 * The store is driven through SQLite rather than DuckDB so the binary needs no
 * native addon — `bun:sqlite` is built in. The resolution code under test is
 * type-agnostic (see FILE_STORE_TYPES in native/connections/registry.ts) and
 * both engines create-on-open, so SQLite exercises the same two defects.
 * The DuckDB driver's own guard is covered in
 * packages/drivers/test/file-store-guard.test.ts.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { Database } from "bun:sqlite"
import { spawnSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const OPENCODE_ROOT = path.resolve(import.meta.dir, "../..")
const PROBE = path.join(OPENCODE_ROOT, "test/altimate/fixtures/store-path-probe.ts")

/** An unguessable name — a pass cannot come from anything but reading the store. */
const CANARY_TABLE = "zorbulax_ledger"

let rig: string
let binary: string

/** Compile the probe the way the shipped binary is compiled. */
function compileProbe(outfile: string) {
  const result = spawnSync(
    process.execPath,
    [
      "build",
      "--compile",
      "--conditions=browser",
      "--tsconfig-override",
      "./tsconfig.json",
      "--target=bun",
      // Match script/build.ts's compile options exactly.
      "--no-compile-autoload-bunfig",
      "--no-compile-autoload-dotenv",
      "--compile-autoload-tsconfig",
      "--compile-autoload-package-json",
      // Mirrors optionalExternals in script/build.ts — the warehouse SDKs are
      // native addons the user installs on demand, never bundled.
      ...[
        "pg",
        "snowflake-sdk",
        "@google-cloud/bigquery",
        "@databricks/sql",
        "mysql2",
        "mssql",
        "oracledb",
        "duckdb",
        "keytar",
        "ssh2",
        "dockerode",
      ].flatMap((pkg) => ["--external", pkg]),
      "--define",
      "OPENCODE_VERSION='0.0.0-test'",
      "--define",
      "OPENCODE_CHANNEL='test'",
      "--define",
      "OPENCODE_LIBC=undefined",
      "--define",
      "OPENCODE_MIGRATIONS=[]",
      "--define",
      "OPENCODE_BUILTIN_SKILLS=[]",
      "--define",
      "OPENCODE_CHANGELOG=[]",
      "--outfile",
      outfile,
      PROBE,
    ],
    { cwd: OPENCODE_ROOT, encoding: "utf-8" },
  )
  if (result.status !== 0 || !fs.existsSync(outfile)) {
    throw new Error(`probe compile failed (${result.status}):\n${result.stdout}\n${result.stderr}`)
  }
}

/** Run the compiled binary from `cwd`, with `home` as its HOME. */
function runProbe(args: string[], opts: { cwd: string; home: string }) {
  // `ALTIMATE_CODE_CONN_*` variables override both config files, so an ambient
  // one on the developer's or CI's environment would decide these assertions
  // instead of the config the test wrote. Strip them.
  const env: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("ALTIMATE_CODE_CONN_")) env[key] = value
  }

  const result = spawnSync(binary, args, {
    cwd: opts.cwd,
    encoding: "utf-8",
    env: {
      ...env,
      HOME: opts.home,
      USERPROFILE: opts.home,
      // Global.Path derives data/cache/config/state from xdg-basedir, which
      // prefers XDG_* over HOME. Leaving those ambient would put this probe's
      // project storage outside the rig on any machine that sets them, so the
      // arm that boots an instance would depend on shared state and leave dirs
      // behind. Pin them inside the rig alongside HOME.
      XDG_DATA_HOME: path.join(opts.home, ".local", "share"),
      XDG_CACHE_HOME: path.join(opts.home, ".cache"),
      XDG_CONFIG_HOME: path.join(opts.home, ".config"),
      XDG_STATE_HOME: path.join(opts.home, ".local", "state"),
      OPENCODE_TEST_HOME: opts.home,
      ALTIMATE_TELEMETRY_DISABLED: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
    },
  })
  const line = (result.stdout ?? "")
    .split("\n")
    .reverse()
    .find((l) => l.trim().startsWith("{"))
  if (!line) throw new Error(`probe produced no JSON:\n${result.stdout}\n${result.stderr}`)
  return JSON.parse(line) as { ok: boolean; cwd: string; tables?: string[]; error?: string }
}

/** Every file under `dir` that looks like a database, ignoring `skip`. */
function databaseFiles(dir: string, skip: string[] = []): string[] {
  const found: string[] = []
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(db|sqlite|duckdb)(-wal|-shm|\.wal)?$/.test(entry.name) && !skip.includes(full)) found.push(full)
    }
  }
  walk(dir)
  return found
}

/** Write a connections.json into `home`'s global config directory. */
function writeGlobalConfig(home: string, config: Record<string, unknown>) {
  const dir = path.join(home, ".altimate-code")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "connections.json"), JSON.stringify(config, null, 2))
}

// Compiling the probe takes ~2s locally; allow generous headroom on slow CI
// machines so the hook cannot time out and mask a real result.
beforeAll(() => {
  rig = fs.mkdtempSync(path.join(os.tmpdir(), "store-path-"))
  binary = path.join(rig, "probe-bin")
  compileProbe(binary)
}, 180_000)

afterAll(() => {
  if (rig) fs.rmSync(rig, { recursive: true, force: true })
})

describe("warehouse store path resolution", () => {
  test("a populated store reached through --dir from an unrelated cwd returns its real tables", () => {
    const home = path.join(rig, "case1-home")
    const project = path.join(rig, "case1-project")
    const unrelatedCwd = path.join(rig, "case1-cwd")
    fs.mkdirSync(path.join(home, ".altimate-code"), { recursive: true })
    fs.mkdirSync(project, { recursive: true })
    fs.mkdirSync(unrelatedCwd, { recursive: true })

    // The store lives beside the global config that names it, under a RELATIVE
    // path — the shape that made the reported case silently read as empty.
    const store = path.join(home, ".altimate-code", "warehouse.db")
    const seed = new Database(store, { create: true })
    seed.exec(`CREATE TABLE ${CANARY_TABLE}(id INTEGER, memo TEXT)`)
    seed.exec(`INSERT INTO ${CANARY_TABLE} VALUES (1, 'real')`)
    seed.close()

    writeGlobalConfig(home, { probe: { type: "sqlite", path: "warehouse.db" } })

    const result = runProbe(["--connection", "probe", "--dir", project], { cwd: unrelatedCwd, home })

    expect(result.cwd).toBe(fs.realpathSync(project))
    expect(result.ok).toBe(true)
    expect(result.tables).toContain(CANARY_TABLE)

    // Nothing may have been conjured under --dir or the invoking directory.
    expect(databaseFiles(project)).toEqual([])
    expect(databaseFiles(unrelatedCwd)).toEqual([])
  })

  test("a missing store fails loudly instead of reading as empty", () => {
    const home = path.join(rig, "case2-home")
    const project = path.join(rig, "case2-project")
    const absent = path.join(rig, "case2-absent")
    fs.mkdirSync(path.join(home, ".altimate-code"), { recursive: true })
    fs.mkdirSync(project, { recursive: true })
    fs.mkdirSync(absent, { recursive: true })

    const missing = path.join(absent, "definitely-absent.db")
    writeGlobalConfig(home, { probe: { type: "sqlite", path: missing } })

    const result = runProbe(["--connection", "probe", "--dir", project], { cwd: project, home })

    expect(result.ok).toBe(false)
    expect(result.error).toContain("not found")
    expect(result.error).toContain("definitely-absent.db")

    // The whole point: no database was conjured at the missing path.
    expect(fs.existsSync(missing)).toBe(false)
    expect(databaseFiles(absent)).toEqual([])
    expect(databaseFiles(project)).toEqual([])
  })

  test("a project-local config resolves against the --dir project, not the invoking cwd", () => {
    const home = path.join(rig, "case5-home")
    const project = path.join(rig, "case5-project")
    const unrelatedCwd = path.join(rig, "case5-cwd")
    fs.mkdirSync(path.join(home, ".altimate-code"), { recursive: true })
    fs.mkdirSync(path.join(project, ".altimate-code"), { recursive: true })
    fs.mkdirSync(unrelatedCwd, { recursive: true })

    const store = new Database(path.join(project, "warehouse.db"), { create: true })
    store.exec(`CREATE TABLE ${CANARY_TABLE}(id INTEGER)`)
    store.close()

    fs.writeFileSync(
      path.join(project, ".altimate-code", "connections.json"),
      JSON.stringify({ probe: { type: "sqlite", path: "warehouse.db" } }),
    )

    const result = runProbe(["--connection", "probe", "--dir", project], { cwd: unrelatedCwd, home })

    expect(result.ok).toBe(true)
    expect(result.tables).toContain(CANARY_TABLE)
    expect(databaseFiles(unrelatedCwd)).toEqual([])
  })

  test("a server-style request resolves against its instance directory, not the launch cwd", () => {
    // A server or `run --attach` request never chdirs: the project arrives in
    // the instance context while the working directory stays where the process
    // was started. Reading process.cwd() there picks up the launch directory,
    // which is somebody else's project.
    const home = path.join(rig, "case6-home")
    const project = path.join(rig, "case6-project")
    const launchCwd = path.join(rig, "case6-launch-cwd")
    fs.mkdirSync(path.join(home, ".altimate-code"), { recursive: true })
    fs.mkdirSync(path.join(project, ".altimate-code"), { recursive: true })
    fs.mkdirSync(path.join(launchCwd, ".altimate-code"), { recursive: true })

    const real = new Database(path.join(project, "warehouse.db"), { create: true })
    real.exec(`CREATE TABLE ${CANARY_TABLE}(id INTEGER)`)
    real.close()

    // A decoy project config and store sit in the launch directory.
    const decoy = new Database(path.join(launchCwd, "warehouse.db"), { create: true })
    decoy.exec("CREATE TABLE decoy_table(id INTEGER)")
    decoy.close()
    for (const dir of [project, launchCwd]) {
      fs.writeFileSync(
        path.join(dir, ".altimate-code", "connections.json"),
        JSON.stringify({ probe: { type: "sqlite", path: "warehouse.db" } }),
      )
    }

    const result = runProbe(["--connection", "probe", "--instance-dir", project], { cwd: launchCwd, home })

    expect(result.cwd).toBe(fs.realpathSync(launchCwd))
    expect(result.ok).toBe(true)
    expect(result.tables).toContain(CANARY_TABLE)
    expect(result.tables).not.toContain("decoy_table")
  })

  test("an explicit create: true still materializes a store", () => {
    const home = path.join(rig, "case3-home")
    const project = path.join(rig, "case3-project")
    fs.mkdirSync(path.join(home, ".altimate-code"), { recursive: true })
    fs.mkdirSync(project, { recursive: true })

    const target = path.join(project, "scratch.db")
    writeGlobalConfig(home, { probe: { type: "sqlite", path: target, create: true } })

    const result = runProbe(["--connection", "probe"], { cwd: project, home })

    expect(result.ok).toBe(true)
    expect(result.tables).toEqual([])
    expect(fs.existsSync(target)).toBe(true)
  })
})
