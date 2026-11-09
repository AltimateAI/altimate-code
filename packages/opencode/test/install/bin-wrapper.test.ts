import { describe, test, expect, afterEach } from "bun:test"
import path from "path"
import fs from "fs"
import { spawnSync } from "child_process"
import {
  installTmpdir,
  createBinaryPackage,
  createDummyBinary,
  runBinWrapper,
  BIN_WRAPPER_SCRIPT,
  CURRENT_PLATFORM,
  CURRENT_ARCH,
} from "./fixture"

// Dummy binaries created by the fixture are Unix shell scripts (#!/bin/sh).
// Tests that run these binaries can only pass on Unix platforms.
const unixtest = process.platform !== "win32" ? test : test.skip

let cleanup: (() => void) | undefined

afterEach(() => {
  cleanup?.()
  cleanup = undefined
})

function copyBinWrapper(destDir: string): string {
  const binDir = path.join(destDir, "bin")
  fs.mkdirSync(binDir, { recursive: true })
  const wrapperPath = path.join(binDir, "altimate-code")
  fs.copyFileSync(BIN_WRAPPER_SCRIPT, wrapperPath)
  return wrapperPath
}

// altimate_change start — #982: the launcher puts the bundled dbt toolkit on the app's PATH
describe.each([
  ["bin/altimate-code", BIN_WRAPPER_SCRIPT],
  ["bin/altimate", path.join(path.dirname(BIN_WRAPPER_SCRIPT), "altimate")],
])("%s puts altimate-dbt on the app's PATH (#982)", (_name, wrapperSource) => {
  // Published layout: <pkg>/bin/<wrapper> and <pkg>/dbt-tools/bin/altimate-dbt.
  function makeLayout(dir: string, opts: { linkedIntoBin: boolean }) {
    const pkg = path.join(dir, "node_modules", "altimate-code")
    const binDir = path.join(pkg, "bin")
    const dbtToolsBin = path.join(pkg, "dbt-tools", "bin")
    fs.mkdirSync(binDir, { recursive: true })
    fs.mkdirSync(dbtToolsBin, { recursive: true })
    const wrapperPath = path.join(binDir, path.basename(wrapperSource))
    fs.copyFileSync(wrapperSource, wrapperPath)
    fs.writeFileSync(path.join(dbtToolsBin, "altimate-dbt"), '#!/bin/sh\necho "bundled-dbt-tools"')
    fs.chmodSync(path.join(dbtToolsBin, "altimate-dbt"), 0o755)
    if (opts.linkedIntoBin) {
      fs.writeFileSync(path.join(binDir, "altimate-dbt"), '#!/bin/sh\necho "linked-by-postinstall"')
      fs.chmodSync(path.join(binDir, "altimate-dbt"), 0o755)
    }
    // Stand-in for the compiled app: runs altimate-dbt from PATH, then prints PATH.
    const app = path.join(dir, "app")
    fs.writeFileSync(app, '#!/bin/sh\naltimate-dbt\necho "PATH=$PATH"')
    fs.chmodSync(app, 0o755)
    return { wrapperPath, binDir, dbtToolsBin: fs.realpathSync(dbtToolsBin), app }
  }

  unixtest("falls back to dbt-tools/bin when postinstall did not link altimate-dbt", () => {
    const { dir, cleanup: c } = installTmpdir()
    cleanup = c
    const { wrapperPath, app } = makeLayout(dir, { linkedIntoBin: false })

    const result = runBinWrapper(wrapperPath, [], { ALTIMATE_CODE_BIN_PATH: app })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("bundled-dbt-tools")
  })

  unixtest("uses the postinstall-linked altimate-dbt and does not add dbt-tools/bin", () => {
    const { dir, cleanup: c } = installTmpdir()
    cleanup = c
    const { wrapperPath, dbtToolsBin, app } = makeLayout(dir, { linkedIntoBin: true })

    const result = runBinWrapper(wrapperPath, [], { ALTIMATE_CODE_BIN_PATH: app })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("linked-by-postinstall")
    expect(result.stdout).not.toContain(dbtToolsBin)
  })

  unixtest("keeps the user's PATH and does not duplicate the bin folder", () => {
    const { dir, cleanup: c } = installTmpdir()
    cleanup = c
    const { wrapperPath, app } = makeLayout(dir, { linkedIntoBin: true })
    const realBinDir = path.dirname(fs.realpathSync(wrapperPath))

    const result = runBinWrapper(wrapperPath, [], {
      ALTIMATE_CODE_BIN_PATH: app,
      PATH: [realBinDir, process.env.PATH ?? ""].join(path.delimiter),
    })
    expect(result.exitCode).toBe(0)
    const pathLine = result.stdout.split("\n").find((l) => l.startsWith("PATH="))!
    const entries = pathLine.slice("PATH=".length).split(path.delimiter)
    expect(entries.filter((e) => e === realBinDir).length).toBe(1)
    for (const original of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
      expect(entries).toContain(original)
    }
  })

  // Ours must win even when our folder is already on PATH behind an older altimate-dbt.
  unixtest("moves the tool folders ahead of an older altimate-dbt already on PATH", () => {
    const { dir, cleanup: c } = installTmpdir()
    cleanup = c
    const { wrapperPath, dbtToolsBin, app } = makeLayout(dir, { linkedIntoBin: false })
    const stale = path.join(dir, "stale")
    fs.mkdirSync(stale)
    fs.writeFileSync(path.join(stale, "altimate-dbt"), '#!/bin/sh\necho "stale-altimate-dbt"')
    fs.chmodSync(path.join(stale, "altimate-dbt"), 0o755)

    const result = runBinWrapper(wrapperPath, [], {
      ALTIMATE_CODE_BIN_PATH: app,
      PATH: [stale, dbtToolsBin, process.env.PATH ?? ""].join(path.delimiter),
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("bundled-dbt-tools")
    expect(result.stdout).not.toContain("stale-altimate-dbt")
    const pathLine = result.stdout.split("\n").find((l) => l.startsWith("PATH="))!
    expect(pathLine.slice("PATH=".length).split(path.delimiter).filter((e) => e === dbtToolsBin).length).toBe(1)
  })

  // Windows commonly spells the variable `Path`. The launcher must extend that key, not add a second `PATH`.
  unixtest("extends a mixed-case Path key instead of adding PATH", () => {
    const { dir, cleanup: c } = installTmpdir()
    cleanup = c
    const { wrapperPath, dbtToolsBin } = makeLayout(dir, { linkedIntoBin: false })
    const app = path.join(dir, "print-env")
    fs.writeFileSync(app, '#!/bin/sh\necho "Path=$Path"\necho "PATH=$PATH"')
    fs.chmodSync(app, 0o755)
    const env: Record<string, string> = { ...process.env, ALTIMATE_CODE_BIN_PATH: app, Path: "/original/bin" } as Record<
      string,
      string
    >
    delete env.PATH
    delete env.ALTIMATE_BIN_DIR

    const result = spawnSync(process.execPath, [wrapperPath], { encoding: "utf-8", timeout: 10_000, env })
    expect(result.status).toBe(0)
    const pathLine = result.stdout.split("\n").find((l) => l.startsWith("Path="))!
    const entries = pathLine.slice("Path=".length).split(path.delimiter)
    expect(entries).toContain(dbtToolsBin)
    expect(entries.at(-1)).toBe("/original/bin")
    // No PATH key was created: /bin/sh fills in its own default PATH, which never holds our folders.
    const upperLine = result.stdout.split("\n").find((l) => l.startsWith("PATH=")) ?? ""
    expect(upperLine).not.toContain(dbtToolsBin)
  })
})
// altimate_change end

describe("bin/altimate-code wrapper", () => {
  unixtest("uses ALTIMATE_CODE_BIN_PATH env var when set", () => {
    const { dir, cleanup: c } = installTmpdir()
    cleanup = c

    const wrapperPath = copyBinWrapper(dir)
    const dummyBin = createDummyBinary(dir)

    const result = runBinWrapper(wrapperPath, [], {
      ALTIMATE_CODE_BIN_PATH: dummyBin,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("altimate-code-test-ok")
  })

  unixtest("uses cached .opencode when present", () => {
    const { dir, cleanup: c } = installTmpdir()
    cleanup = c

    const wrapperPath = copyBinWrapper(dir)
    const binDir = path.dirname(wrapperPath)
    createDummyBinary(binDir, ".altimate-code")

    const result = runBinWrapper(wrapperPath)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("altimate-code-test-ok")
  })

  unixtest("finds binary in sibling node_modules package", () => {
    const { dir, cleanup: c } = installTmpdir()
    cleanup = c

    // Standard npm flat layout:
    //   dir/node_modules/@opencode-ai/opencode/bin/altimate-code      (wrapper)
    //   dir/node_modules/@opencode-ai/opencode-{p}-{a}/bin/binary     (binary)
    const wrapperPkgBin = path.join(dir, "node_modules", "@altimateai", "altimate-code", "bin")
    fs.mkdirSync(wrapperPkgBin, { recursive: true })
    const wrapperPath = path.join(wrapperPkgBin, "altimate-code")
    fs.copyFileSync(BIN_WRAPPER_SCRIPT, wrapperPath)

    createBinaryPackage(dir)

    const result = runBinWrapper(wrapperPath)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("altimate-code-test-ok")
  })

  unixtest("finds binary in parent node_modules (hoisted)", () => {
    const { dir, cleanup: c } = installTmpdir()
    cleanup = c

    // Hoisted layout:
    //   dir/node_modules/@opencode-ai/opencode-{p}-{a}/bin/binary     (hoisted binary)
    //   dir/packages/app/node_modules/@opencode-ai/opencode/bin/wrapper
    createBinaryPackage(dir)

    const nestedBin = path.join(dir, "packages", "app", "node_modules", "@altimateai", "altimate-code", "bin")
    fs.mkdirSync(nestedBin, { recursive: true })
    const wrapperPath = path.join(nestedBin, "altimate-code")
    fs.copyFileSync(BIN_WRAPPER_SCRIPT, wrapperPath)

    const result = runBinWrapper(wrapperPath)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("altimate-code-test-ok")
  })

  test("fails with helpful error when no binary exists", () => {
    const { dir, cleanup: c } = installTmpdir()
    cleanup = c

    const wrapperPath = copyBinWrapper(dir)

    const result = runBinWrapper(wrapperPath)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("package manager failed to install")
  })

  test("error message lists expected package names", () => {
    const { dir, cleanup: c } = installTmpdir()
    cleanup = c

    const wrapperPath = copyBinWrapper(dir)

    const result = runBinWrapper(wrapperPath)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(`@altimateai/altimate-code-${CURRENT_PLATFORM}-${CURRENT_ARCH}`)
  })
})
