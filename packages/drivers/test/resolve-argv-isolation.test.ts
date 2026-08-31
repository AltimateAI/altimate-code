import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { loadOptionalDriver } from "../src/resolve"

// `@mapbox/node-pre-gyp` resolves a native module's manifest by parsing the
// HOST APPLICATION's `process.argv`. `find()` passes `argv: process.argv` into
// its own `Run`, `nopt` abbreviation-matches our flags against node-pre-gyp's
// option list, and `node-pre-gyp.js:164` then does
//
//     package_json_path = path.join(this.opts.directory, package_json_path)
//
// `path.join`, not `path.resolve` — so an absolute manifest path is not
// discarded. Our `--dir` abbreviates to `--directory`, and the driver ended up
// looking for its manifest at `<--dir value>` + the manifest's absolute path.
//
// The fixture below reproduces exactly that arithmetic. It does not stand in
// for node-pre-gyp in general; it stands in for the one line that broke.

const FIXTURE = "altimate-argv-fixture"
const savedArgv = process.argv

let root = ""
let nodeModules = ""
let pkgDir = ""

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "resolve-argv-")))
  nodeModules = path.join(root, "node_modules")
  pkgDir = path.join(nodeModules, FIXTURE)
  fs.mkdirSync(pkgDir, { recursive: true })
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: FIXTURE, version: "1.0.0", main: "index.js" }),
  )
  fs.writeFileSync(
    path.join(pkgDir, "index.js"),
    [
      "const path = require('path')",
      "const i = process.argv.indexOf('--dir')",
      "const directory = i !== -1 ? process.argv[i + 1] : undefined",
      "const manifest = path.join(__dirname, 'package.json')",
      "module.exports = {",
      "  sawDirFlag: directory !== undefined,",
      "  manifestPath: directory ? path.join(directory, manifest) : manifest,",
      "}",
      "",
    ].join("\n"),
  )
})

afterEach(() => {
  process.argv = savedArgv
  if (root) fs.rmSync(root, { recursive: true, force: true })
})

/** Reach the fixture the way the real failure does: via the harvested root. */
function importerThrowingAt(target: string) {
  const ambient = Object.assign(new Error(`ENOENT: no such file or directory, open '${target}'`), { code: "ENOENT" })
  return async () => {
    throw ambient
  }
}

describe("a driver load does not see the host's command line", () => {
  test("the loaded module cannot observe --dir", async () => {
    process.argv = [savedArgv[0], savedArgv[1], "run", "--dir", "/some/project", "--print-logs"]

    const loaded: any = await loadOptionalDriver(
      "duckdb",
      FIXTURE,
      importerThrowingAt(path.join(pkgDir, "package.json")),
    )
    const mod = loaded?.default ?? loaded

    // Without argv neutralisation the fixture sees the flag and joins, which is
    // precisely what sent the driver after a manifest that never existed.
    expect(mod.sawDirFlag).toBe(false)
    expect(mod.manifestPath).toBe(path.join(pkgDir, "package.json"))
    expect(mod.manifestPath.startsWith("/some/project")).toBe(false)
  })

  test("restores the command line afterwards", async () => {
    const argv = [savedArgv[0], savedArgv[1], "run", "--dir", "/some/project"]
    process.argv = argv

    await loadOptionalDriver("duckdb", FIXTURE, importerThrowingAt(path.join(pkgDir, "package.json")))

    expect(process.argv).toEqual(argv)
  })

  test("restores the command line even when the load throws", async () => {
    fs.writeFileSync(path.join(pkgDir, "index.js"), "throw new Error('broken driver')\n")
    const argv = [savedArgv[0], savedArgv[1], "run", "--dir", "/some/project"]
    process.argv = argv

    let failed = false
    try {
      await loadOptionalDriver("duckdb", FIXTURE, importerThrowingAt(path.join(pkgDir, "package.json")))
    } catch {
      failed = true
    }

    expect(failed).toBe(true)
    expect(process.argv).toEqual(argv)
  })
})
