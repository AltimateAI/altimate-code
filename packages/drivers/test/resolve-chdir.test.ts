import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"

import { driverSearchRoots, resolveOptionalPackage } from "../src/resolve"

// Specifiers that exist nowhere but the tree each test builds. Asking for a
// real driver name would let the repo's own `packages/drivers/node_modules`
// satisfy the lookup through the execPath and module-location roots — which no
// environment isolation can suppress — so the test would pass while proving
// nothing about which root actually won.
const FIXTURE = "altimate-chdir-fixture"
const CWD_ONLY = "altimate-cwd-only-fixture"
const MARKER = "resolved-from-the-fixture-tree"

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
  writePackage(nodeModules, FIXTURE, "index.js", `module.exports = { marker: ${JSON.stringify(MARKER)} }\n`)
  elsewhere = path.join(root, "unrelated-run-dir")
  fs.mkdirSync(elsewhere, { recursive: true })
})

afterEach(() => {
  process.chdir(originalCwd)
  if (root) fs.rmSync(root, { recursive: true, force: true })
})

describe("resolution does not depend on the working directory", () => {
  test("resolves the same package before and after a chdir", () => {
    const before = resolveOptionalPackage(FIXTURE, [nodeModules])
    expect(before).toBeDefined()

    process.chdir(elsewhere)
    const after = resolveOptionalPackage(FIXTURE, [nodeModules])
    expect(after).toBe(before)
  })

  test("resolves from a directory that is not an ancestor of the package", () => {
    // `elsewhere` shares only the temp root with the package tree, so nothing
    // about it can contribute to resolution. This is the rig's shape: the run
    // directory and the install tree are unrelated.
    process.chdir(elsewhere)
    const resolved = resolveOptionalPackage(FIXTURE, [nodeModules])
    expect(resolved).toBeDefined()
    expect(resolved!.startsWith(nodeModules)).toBe(true)
    // Load it and read the marker, so the test reports which root satisfied the
    // lookup rather than merely that something was found.
    const loaded = createRequire(pathToFileURL(resolved!).href)(resolved!)
    expect(loaded.marker).toBe(MARKER)
  })

  test("does not resolve out of the working directory's own node_modules", () => {
    // A package present only under cwd must stay invisible: project trees are
    // workspace-controlled executable content and are deliberately not searched.
    const cwdModules = path.join(elsewhere, "node_modules")
    fs.mkdirSync(cwdModules, { recursive: true })
    writePackage(cwdModules, CWD_ONLY, "index.js", `module.exports = { marker: ${JSON.stringify(MARKER)} }\n`)

    process.chdir(elsewhere)
    // The specifier exists nowhere else on the machine, so this is absence with
    // a known cause: anything but undefined means the lookup reached into the
    // working directory.
    expect(resolveOptionalPackage(CWD_ONLY, driverSearchRoots())).toBeUndefined()
  })

  test("a chdir between resolve and re-resolve does not change the answer", () => {
    process.chdir(elsewhere)
    const first = resolveOptionalPackage(FIXTURE, [nodeModules])
    process.chdir(originalCwd)
    const second = resolveOptionalPackage(FIXTURE, [nodeModules])
    process.chdir(root)
    const third = resolveOptionalPackage(FIXTURE, [nodeModules])
    expect(second).toBe(first)
    expect(third).toBe(first)
  })
})
