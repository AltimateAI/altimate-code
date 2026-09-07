import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"

import { driverSearchRoots, loadOptionalDriver, resolveOptionalPackage, searchRootsFromError } from "../src/resolve"

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
  // Each test's starting cwd must not depend on the previous test's afterEach
  // having run — restore it here too, so a test that fails before reaching its
  // own afterEach (or a future `.concurrent` run) cannot leave a stale cwd for
  // the next test.
  process.chdir(originalCwd)
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

  test("loads from the package's own directory while cwd is somewhere else", async () => {
    // Resolution being cwd-independent is not enough: the *load* consults the
    // package manifest too, and in a compiled binary that lookup was observed
    // resolving against the process working directory —
    // `ENOENT ... open '<cwd>/usr/lib/.../duckdb/package.json'` for a file that
    // exists at that path without the prefix. This pins the load itself.
    //
    // The fixture reports its own __dirname, so the assertion is about which
    // directory the module was loaded from rather than merely that it loaded.
    const pkgDir = path.join(nodeModules, FIXTURE)
    fs.writeFileSync(path.join(pkgDir, "index.js"), "module.exports = { dir: __dirname }\n")

    process.chdir(elsewhere)

    // The only route to the fixture root is the path named in the ambient
    // failure, which is how the real failure surfaces it. Naming the plain
    // absolute path here would find the fixture regardless of whether
    // `repairCwdPrefixedPath` works — that path already exists on disk, so
    // this test would still pass with the repair removed. Instead reproduce
    // the observed shape exactly: the working directory concatenated onto the
    // already-absolute manifest path, `<cwd>/usr/lib/.../duckdb/package.json`
    // — a location that exists only after the `<cwd>` prefix is stripped.
    const real = path.join(pkgDir, "package.json")
    const concatenated = elsewhere + real
    expect(fs.existsSync(concatenated)).toBe(false)
    const ambient = Object.assign(new Error(`ENOENT: no such file or directory, open '${concatenated}'`), {
      code: "ENOENT",
    })
    const importer = async () => {
      throw ambient
    }

    const loaded: any = await loadOptionalDriver("duckdb", FIXTURE, importer)
    const mod = loaded?.default ?? loaded
    expect(mod.dir).toBe(fs.realpathSync(pkgDir))
  })

  test("treats a descendant named with a leading '..' as workspace-controlled, not parent traversal", () => {
    // A directory component that merely STARTS WITH ".." — "..evil" — is a
    // real child of cwd, not parent traversal, even though the relative path
    // string built from it also starts with the two characters "..". Only
    // ".." itself, or ".." followed by a separator, means a path actually
    // climbed above cwd; a naive `rel.startsWith("..")` check conflates the
    // two and would admit this as an external, non-workspace root.
    const evilNodeModules = path.join(root, "..evil", "node_modules", "duckdb")
    fs.mkdirSync(evilNodeModules, { recursive: true })
    fs.writeFileSync(path.join(evilNodeModules, "package.json"), JSON.stringify({ name: "duckdb", version: "1.0.0" }))

    process.chdir(root)

    const named = path.join(evilNodeModules, "package.json")
    const ambient = Object.assign(new Error(`ENOENT: no such file or directory, open '${named}'`), {
      code: "ENOENT",
    })

    const roots = searchRootsFromError(ambient)

    // The workspace-controlled node_modules under "..evil" must not be
    // returned — it is a real descendant of cwd, so it stays excluded exactly
    // like any other project node_modules.
    expect(roots).toEqual([])
  })

  test("excludes a nested dependency root under an ancestor node_modules when cwd starts below the project root", () => {
    // The CLI can start in a subdirectory that has no node_modules of its own
    // — cwd = <project>/packages/app — while the hoisted node_modules lives at
    // the project root above it. A nested dependency there,
    // <project>/node_modules/host/node_modules/duckdb, is workspace-controlled
    // through its *outer* node_modules even though it is not itself one of the
    // exact directories `nodeModulesUpward(cwd)` walks to.
    const project = path.join(root, "project")
    const nested = path.join(project, "node_modules", "host", "node_modules", "duckdb")
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(path.join(nested, "package.json"), JSON.stringify({ name: "duckdb", version: "1.0.0" }))

    const cwd = path.join(project, "packages", "app")
    fs.mkdirSync(cwd, { recursive: true })
    process.chdir(cwd)

    const named = path.join(nested, "package.json")
    const ambient = Object.assign(new Error(`ENOENT: no such file or directory, open '${named}'`), {
      code: "ENOENT",
    })

    const roots = searchRootsFromError(ambient)

    // Neither the inner nested root nor the outer project node_modules it sits
    // under may be returned: both are workspace-controlled, and importing from
    // either during a warehouse read/test would cross the permission boundary
    // driverSearchRoots() otherwise enforces.
    expect(roots).not.toContain(fs.realpathSync(nested))
    expect(roots).not.toContain(fs.realpathSync(path.join(project, "node_modules")))
    expect(roots).toEqual([])
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
