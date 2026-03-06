import { describe, test, expect, afterEach } from "bun:test"
import path from "path"
import fs from "fs"
import {
  installTmpdir,
  createBinaryPackage,
  createDummyBinary,
  runBinWrapper,
  BIN_WRAPPER_SCRIPT,
  CURRENT_PLATFORM,
  CURRENT_ARCH,
} from "./fixture"

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

describe("bin/altimate-code wrapper", () => {
  test("uses ALTIMATE_CODE_BIN_PATH env var when set", () => {
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

  test("uses cached .altimate-code when present", () => {
    const { dir, cleanup: c } = installTmpdir()
    cleanup = c

    const wrapperPath = copyBinWrapper(dir)
    const binDir = path.dirname(wrapperPath)
    createDummyBinary(binDir, ".altimate-code")

    const result = runBinWrapper(wrapperPath)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("altimate-code-test-ok")
  })

  test("finds binary in sibling node_modules package", () => {
    const { dir, cleanup: c } = installTmpdir()
    cleanup = c

    // Standard npm flat layout:
    //   dir/node_modules/@altimateai/altimate-code/bin/altimate-code      (wrapper)
    //   dir/node_modules/@altimateai/altimate-code-{p}-{a}/bin/binary     (binary)
    const wrapperPkgBin = path.join(dir, "node_modules", "@altimateai", "altimate-code", "bin")
    fs.mkdirSync(wrapperPkgBin, { recursive: true })
    const wrapperPath = path.join(wrapperPkgBin, "altimate-code")
    fs.copyFileSync(BIN_WRAPPER_SCRIPT, wrapperPath)

    createBinaryPackage(dir)

    const result = runBinWrapper(wrapperPath)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("altimate-code-test-ok")
  })

  test("finds binary in parent node_modules (hoisted)", () => {
    const { dir, cleanup: c } = installTmpdir()
    cleanup = c

    // Hoisted layout:
    //   dir/node_modules/@altimateai/altimate-code-{p}-{a}/bin/binary     (hoisted binary)
    //   dir/packages/app/node_modules/@altimateai/altimate-code/bin/wrapper
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
