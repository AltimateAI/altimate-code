import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "fs"
import os from "os"
import path from "path"
import { dbtProjectAdapterType } from "../../../src/altimate/native/connections/dbt-adapter-type"

let dir: string
let cwd: string
const saved = { HOME: process.env.HOME, DBT_TARGET_PATH: process.env.DBT_TARGET_PATH }

beforeEach(() => {
  cwd = process.cwd()
  dir = mkdtempSync(path.join(os.tmpdir(), "dbt-adapter-type-"))
  process.env.HOME = dir // no saved altimate-dbt config
  delete process.env.DBT_TARGET_PATH
  writeFileSync(path.join(dir, "dbt_project.yml"), "name: p\nversion: '1'\n")
  process.chdir(dir)
})

afterEach(() => {
  process.chdir(cwd)
  for (const [k, v] of Object.entries(saved)) (v === undefined ? delete process.env[k] : (process.env[k] = v))
  rmSync(dir, { recursive: true, force: true })
})

const manifest = (root: string, type: string) => {
  mkdirSync(root, { recursive: true })
  writeFileSync(path.join(root, "manifest.json"), JSON.stringify({ metadata: { adapter_type: type } }))
}

test("reads the adapter type from the project's target path", async () => {
  manifest(path.join(dir, "target"), "Snowflake")
  expect(await dbtProjectAdapterType()).toEqual({ project: true, type: "snowflake" })
  process.env.DBT_TARGET_PATH = "build"
  manifest(path.join(dir, "build"), "bigquery")
  expect(await dbtProjectAdapterType()).toEqual({ project: true, type: "bigquery" })
})

test("a missing or unreadable manifest still reports a dbt project", async () => {
  expect(await dbtProjectAdapterType()).toEqual({ project: true })
  mkdirSync(path.join(dir, "target"))
  writeFileSync(path.join(dir, "target", "manifest.json"), "{not json")
  expect(await dbtProjectAdapterType()).toEqual({ project: true })
})

test("re-reads the manifest only when it changes", async () => {
  manifest(path.join(dir, "target"), "postgres")
  const file = path.join(dir, "target", "manifest.json")
  const first = new Date(Date.now() - 60_000)
  utimesSync(file, first, first)
  expect((await dbtProjectAdapterType()).type).toBe("postgres")
  // Same size, so only the modification time can tell the new manifest apart.
  manifest(path.join(dir, "target"), "bigquery")
  utimesSync(file, first, first)
  expect((await dbtProjectAdapterType()).type).toBe("postgres")
  const later = new Date(Date.now() + 5_000)
  utimesSync(file, later, later)
  expect((await dbtProjectAdapterType()).type).toBe("bigquery")
})

test("a saved altimate-dbt config names the project, and a malformed one falls back to discovery", async () => {
  const { path: configPath } = await import("../../../../dbt-tools/src/config")
  const other = mkdtempSync(path.join(os.tmpdir(), "dbt-adapter-type-other-"))
  try {
    manifest(path.join(other, "target"), "redshift")
    mkdirSync(path.dirname(configPath()), { recursive: true })
    writeFileSync(configPath(), JSON.stringify({ projectRoot: other }))
    expect(await dbtProjectAdapterType()).toEqual({ project: true, type: "redshift" })
    writeFileSync(configPath(), "{not json")
    manifest(path.join(dir, "target"), "duckdb")
    expect(await dbtProjectAdapterType()).toEqual({ project: true, type: "duckdb" })
  } finally {
    rmSync(other, { recursive: true, force: true })
  }
})
