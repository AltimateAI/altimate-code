import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "fs"
import os from "os"
import path from "path"
import { dbtProjectAdapterType, dbtRoute } from "../../../src/altimate/native/connections/dbt-adapter-type"

let dir: string
let cwd: string
const saved = { HOME: process.env.HOME, DBT_TARGET_PATH: process.env.DBT_TARGET_PATH, DBT_PROFILES_DIR: process.env.DBT_PROFILES_DIR }

beforeEach(() => {
  dbtRoute.root = undefined // another file in the same process may have created a dbt adapter
  cwd = process.cwd()
  dir = mkdtempSync(path.join(os.tmpdir(), "dbt-adapter-type-"))
  process.env.HOME = dir // no saved altimate-dbt config
  delete process.env.DBT_TARGET_PATH
  delete process.env.DBT_PROFILES_DIR
  writeFileSync(path.join(dir, "dbt_project.yml"), "name: p\nversion: '1'\n")
  process.chdir(dir)
})

afterEach(() => {
  dbtRoute.root = undefined
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
  expect(await dbtProjectAdapterType()).toEqual({ project: true, type: "snowflake", targetTypes: [] })
  process.env.DBT_TARGET_PATH = "build"
  manifest(path.join(dir, "build"), "bigquery")
  expect(await dbtProjectAdapterType()).toEqual({ project: true, type: "bigquery", targetTypes: [] })
})

test("a missing or unreadable manifest still reports a dbt project", async () => {
  expect(await dbtProjectAdapterType()).toEqual({ project: true, targetTypes: [] })
  mkdirSync(path.join(dir, "target"))
  writeFileSync(path.join(dir, "target", "manifest.json"), "{not json")
  expect(await dbtProjectAdapterType()).toEqual({ project: true, targetTypes: [] })
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
    writeFileSync(path.join(other, "dbt_project.yml"), "name: o\nversion: '1'\n")
    manifest(path.join(other, "target"), "redshift")
    mkdirSync(path.dirname(configPath()), { recursive: true })
    writeFileSync(configPath(), JSON.stringify({ projectRoot: other }))
    expect(await dbtProjectAdapterType()).toEqual({ project: true, type: "redshift", targetTypes: [] })
    writeFileSync(configPath(), "{not json")
    manifest(path.join(dir, "target"), "duckdb")
    expect(await dbtProjectAdapterType()).toEqual({ project: true, type: "duckdb", targetTypes: [] })
  } finally {
    rmSync(other, { recursive: true, force: true })
  }
})

test("every target of the project's profile counts, as dbt may connect with any of them", async () => {
  writeFileSync(path.join(dir, "dbt_project.yml"), "name: p\nversion: '1'\nprofile: shop\n")
  writeFileSync(
    path.join(dir, "profiles.yml"),
    "shop:\n  target: dev\n  outputs:\n    dev:\n      type: duckdb\n      path: x.duckdb\n    prod:\n      type: snowflake\n      account: a\n      user: u\n      password: p\n      database: d\n      warehouse: w\n      schema: s\nother:\n  outputs:\n    o:\n      type: postgres\n      host: h\n      user: u\n      password: p\n      dbname: d\n      schema: s\n",
  )
  manifest(path.join(dir, "target"), "duckdb")
  const result = await dbtProjectAdapterType()
  expect(result.type).toBe("duckdb")
  expect(result.targetTypes.sort()).toEqual(["duckdb", "snowflake"])
})

test("a templated profile name counts every profile's targets; a stale saved root means no dbt project", async () => {
  writeFileSync(path.join(dir, "dbt_project.yml"), "name: p\nversion: '1'\nprofile: \"{{ env_var('DBT_PROFILE', 'shop') }}\"\n")
  writeFileSync(
    path.join(dir, "profiles.yml"),
    "shop:\n  outputs:\n    dev:\n      type: mysql\n      server: h\n      username: u\n      password: p\n      schema: s\nother:\n  outputs:\n    o:\n      type: postgres\n      host: h\n      user: u\n      password: p\n      dbname: d\n      schema: s\n",
  )
  expect((await dbtProjectAdapterType()).targetTypes.sort()).toEqual(["mysql", "postgres"])
  const { path: configPath } = await import("../../../../dbt-tools/src/config")
  mkdirSync(path.dirname(configPath()), { recursive: true })
  writeFileSync(configPath(), JSON.stringify({ projectRoot: path.join(dir, "gone") }))
  // dbt's routing reads the saved config, rejects its root and falls back to the registry default.
  expect((await dbtProjectAdapterType()).project).toBe(false)
})

test("once dbt's adapter is resolved, its project is the one read; a saved config of null is no project", async () => {
  dbtRoute.root = null // the adapter could not be created: the registry default takes the call
  expect((await dbtProjectAdapterType()).project).toBe(false)
  const other = path.join(dir, "other")
  mkdirSync(other)
  writeFileSync(path.join(other, "dbt_project.yml"), "name: o\nversion: '1'\n")
  manifest(path.join(other, "target"), "postgres")
  dbtRoute.root = other // created for another project than the working directory's
  expect((await dbtProjectAdapterType()).type).toBe("postgres")
  dbtRoute.root = undefined
  const { path: configPath } = await import("../../../../dbt-tools/src/config")
  mkdirSync(path.dirname(configPath()), { recursive: true })
  writeFileSync(configPath(), "null")
  expect((await dbtProjectAdapterType()).project).toBe(false)
  writeFileSync(configPath(), JSON.stringify({ projectRoot: 42 }))
  expect((await dbtProjectAdapterType()).project).toBe(false)
  // An adapter already created keeps running after its dbt_project.yml is removed.
  rmSync(path.join(other, "dbt_project.yml"))
  dbtRoute.root = other
  expect((await dbtProjectAdapterType()).project).toBe(true)
})
