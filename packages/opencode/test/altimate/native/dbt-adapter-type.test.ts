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
  expect((await dbtProjectAdapterType()).type).toBe("postgres")
  manifest(path.join(dir, "target"), "duckdb")
  const later = new Date(Date.now() + 5_000)
  utimesSync(path.join(dir, "target", "manifest.json"), later, later)
  expect((await dbtProjectAdapterType()).type).toBe("duckdb")
})
