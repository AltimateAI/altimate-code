import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { driverSearchRoots, resolveOptionalPackage } from "../src/resolve"

// Six pilots were spent on a driver-load failure that only appeared under
// `--dir`, which calls `process.chdir()` (cli/cmd/run.ts) before any driver is
// loaded. Every local verification — and the rig's own pre-flight probe — ran
// without a chdir, so a green suite said nothing about the configuration that
// actually failed.
//
// This arm exists so that stops being true. Resolution must not depend on the
// working directory the process happens to hold when a driver is loaded, and a
// regression that reintroduces a cwd anchor has to fail here.

let root = ""
let pkgRoot = ""
let nodeModules = ""
let elsewhere = ""
const originalCwd = process.cwd()

function writePackage(dir: string, name: string, main: string, body: string) {
  const pkgDir = path.join(dir, name)
  fs.mkdirSync(pkgDir, { recursive: true })
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name, version: "1.0.0", main }))
  fs.writeFileSync(path.join(pkgDir, main), body)
  return pkgDir
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "resolve-chdir-")))
  pkgRoot = path.join(root, "lib", "node_modules", "altimate-code")
  nodeModules = path.join(pkgRoot, "node_modules")
  fs.mkdirSync(nodeModules, { recursive: true })
  writePackage(nodeModules, "duckdb", "index.js", "module.exports = { Database: function () {} }\n")
  elsewhere = path.join(root, "unrelated-run-dir")
  fs.mkdirSync(elsewhere, { recursive: true })
})

afterEach(() => {
  process.chdir(originalCwd)
  if (root) fs.rmSync(root, { recursive: true, force: true })
})

describe("resolution does not depend on the working directory", () => {
  test("resolves the same package before and after a chdir", () => {
    const before = resolveOptionalPackage("duckdb", [nodeModules])
    expect(before).toBeDefined()

    process.chdir(elsewhere)
    const after = resolveOptionalPackage("duckdb", [nodeModules])
    expect(after).toBe(before)
  })

  test("resolves from a directory that is not an ancestor of the package", () => {
    // `elsewhere` shares only the temp root with the package tree, so nothing
    // about it can contribute to resolution. This is the rig's shape: the run
    // directory and the install tree are unrelated.
    process.chdir(elsewhere)
    const resolved = resolveOptionalPackage("duckdb", [nodeModules])
    expect(resolved).toBeDefined()
    expect(resolved!.startsWith(nodeModules)).toBe(true)
    expect(fs.existsSync(resolved!)).toBe(true)
  })

  test("does not resolve out of the working directory's own node_modules", () => {
    // A package present only under cwd must stay invisible: project trees are
    // workspace-controlled executable content and are deliberately not searched.
    const cwdModules = path.join(elsewhere, "node_modules")
    fs.mkdirSync(cwdModules, { recursive: true })
    writePackage(cwdModules, "pg", "index.js", "module.exports = { Client: function () {} }\n")

    process.chdir(elsewhere)
    // Assert on provenance, not absence: this repo legitimately has `pg` under
    // its own tree, which driverSearchRoots finds. What must never happen is a
    // resolution out of the working directory.
    const resolved = resolveOptionalPackage("pg", driverSearchRoots())
    if (resolved !== undefined) expect(resolved.startsWith(elsewhere)).toBe(false)
  })

  test("a chdir between resolve and re-resolve does not change the answer", () => {
    process.chdir(elsewhere)
    const first = resolveOptionalPackage("duckdb", [nodeModules])
    process.chdir(originalCwd)
    const second = resolveOptionalPackage("duckdb", [nodeModules])
    process.chdir(root)
    const third = resolveOptionalPackage("duckdb", [nodeModules])
    expect(second).toBe(first)
    expect(third).toBe(first)
  })
})
