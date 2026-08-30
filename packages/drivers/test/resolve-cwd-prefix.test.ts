import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  loadOptionalDriver,
  repairCwdPrefixedPath,
  searchRootsFromError,
} from "../src/resolve"

// A globally installed CLI (`npm install -g`, package tree under
// /usr/lib/node_modules/altimate-code) run from an unrelated directory reported:
//
//   DuckDB driver found at duckdb but failed to load: ENOENT … open
//   '<cwd>/usr/lib/node_modules/altimate-code/node_modules/duckdb/package.json'
//
// Two defects in one line. The runtime concatenated the working directory onto
// an already-absolute path, and our message then named the bare specifier as
// though it were a location on disk — so it read as "found it, could not load
// it" when in fact nothing had been found at all.
//
// Real directories on disk here, because the whole mechanism is path existence.

let root = ""
let pkgRoot = ""
let nodeModules = ""

/** Build a minimal but real installed package tree. */
function writePackage(dir: string, name: string, main: string, body: string) {
  const pkgDir = path.join(dir, name)
  fs.mkdirSync(pkgDir, { recursive: true })
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name, version: "1.0.0", main }))
  fs.writeFileSync(path.join(pkgDir, main), body)
  return pkgDir
}

describe("cwd concatenated onto an absolute path", () => {
  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "resolve-cwd-")))
    pkgRoot = path.join(root, "lib", "node_modules", "altimate-code")
    nodeModules = path.join(pkgRoot, "node_modules")
    fs.mkdirSync(nodeModules, { recursive: true })
    writePackage(nodeModules, "duckdb", "index.js", "module.exports = { Database: function () {} }\n")
  })

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true })
  })

  test("repairs a path whose absolute form exists", () => {
    const real = path.join(nodeModules, "duckdb", "package.json")
    const mangled = process.cwd() + real
    expect(repairCwdPrefixedPath(mangled)).toBe(real)
  })

  test("leaves a path that exists alone", () => {
    const real = path.join(nodeModules, "duckdb", "package.json")
    expect(repairCwdPrefixedPath(real)).toBeUndefined()
  })

  test("leaves a legitimately nested path under cwd alone", () => {
    // `<cwd>/node_modules/x` de-prefixes to `/node_modules/x`, which does not
    // exist — so the repair must decline rather than invent a root.
    const nested = path.join(process.cwd(), "node_modules", "definitely-not-here", "package.json")
    expect(repairCwdPrefixedPath(nested)).toBeUndefined()
  })

  test("declines when the de-prefixed path does not exist either", () => {
    const mangled = process.cwd() + path.join(root, "nope", "package.json")
    expect(repairCwdPrefixedPath(mangled)).toBeUndefined()
  })

  test("harvests the node_modules root the runtime named", () => {
    const mangled = process.cwd() + path.join(nodeModules, "duckdb", "package.json")
    const error = Object.assign(new Error(`ENOENT: no such file or directory, open '${mangled}'`), {
      code: "ENOENT",
    })
    expect(searchRootsFromError(error)).toContain(nodeModules)
  })

  test("harvests nothing from an error naming no usable path", () => {
    expect(searchRootsFromError(new Error("something went wrong"))).toEqual([])
    expect(searchRootsFromError(new Error("open '/no/such/place/pkg/package.json'"))).toEqual([])
  })

  test("loads the driver from the location the failing runtime named", async () => {
    // Reproduces the reported failure exactly: ambient resolution throws ENOENT
    // naming the correct absolute path with cwd concatenated on, and nothing
    // else on this machine can see that tree.
    const mangled = process.cwd() + path.join(nodeModules, "duckdb", "package.json")
    const ambient = Object.assign(new Error(`ENOENT: no such file or directory, open '${mangled}'`), {
      code: "ENOENT",
    })

    let call = 0
    const importer = async (spec: string) => {
      call++
      if (call === 1) throw ambient
      return await import(/* @vite-ignore */ spec)
    }

    const mod: any = await loadOptionalDriver("duckdb", "duckdb", importer)
    const duckdb = mod.default ?? mod
    expect(typeof duckdb.Database).toBe("function")
  })

  test("does not claim a location when nothing was found", async () => {
    const ambient = Object.assign(new Error("ENOENT: no such file or directory, open '/nowhere/pkg.json'"), {
      code: "ENOENT",
    })
    const importer = async () => {
      throw ambient
    }

    let message = ""
    try {
      await loadOptionalDriver("duckdb", "duckdb", importer)
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    // The old text was `found at duckdb but failed to load: …`, naming the bare
    // specifier as a place on disk.
    expect(message).not.toContain("found at duckdb")
    expect(message).toContain("failed to load from the default module resolution")
  })
})
