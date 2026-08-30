import { describe, expect, test } from "bun:test"

import { enclosingNodeModulesRoots, installLockPath, quotedAbsolutePaths } from "../src/resolve"

// Windows path shapes, unit-testable from any platform because none of these
// touch the filesystem. UNC is the shape that keeps getting left out: a share
// root behaves like a drive root, and code that only special-cases `C:` gets it
// wrong in a way that is invisible until someone runs from a network share.

describe("installLockPath keeps a root intact", () => {
  test("puts the lock inside a POSIX root", () => {
    // Stripping the separator would leave "", making the lock the *relative*
    // ".lock" — a different file for every working directory.
    expect(installLockPath("/")).toBe("/.lock")
  })

  test("puts the lock inside a drive root", () => {
    // "C:.lock" is drive-relative, not the root of C:.
    expect(installLockPath("C:\\")).toBe("C:\\.lock")
  })

  test("puts the lock inside a UNC share root", () => {
    // The bug this pins: "\\\\server\\share" + ".lock" names the *share*
    // "\\\\server\\share.lock", a different network location entirely, so two
    // processes installing into the share would not share a lock.
    expect(installLockPath("\\\\server\\share\\")).toBe("\\\\server\\share\\.lock")
    expect(installLockPath("\\\\server\\share")).toBe("\\\\server\\share\\.lock")
  })

  test("still strips a trailing separator on an ordinary directory", () => {
    expect(installLockPath("/home/u/drivers/")).toBe("/home/u/drivers.lock")
    expect(installLockPath("/home/u/drivers")).toBe("/home/u/drivers.lock")
    expect(installLockPath("\\\\server\\share\\drivers\\")).toBe("\\\\server\\share\\drivers.lock")
  })

  test("a directory deeper than the share root is not treated as a root", () => {
    expect(installLockPath("\\\\server\\share\\a")).toBe("\\\\server\\share\\a.lock")
  })
})

describe("quotedAbsolutePaths covers every absolute shape", () => {
  test("POSIX", () => {
    expect(quotedAbsolutePaths(`open '/usr/lib/node_modules/x/package.json'`)).toEqual([
      "/usr/lib/node_modules/x/package.json",
    ])
  })

  test("drive letter, both separators", () => {
    expect(quotedAbsolutePaths(`open "C:\\app\\node_modules\\x\\package.json"`)).toEqual([
      "C:\\app\\node_modules\\x\\package.json",
    ])
    expect(quotedAbsolutePaths(`open "C:/app/node_modules/x/package.json"`)).toEqual([
      "C:/app/node_modules/x/package.json",
    ])
  })

  test("UNC share", () => {
    // Without the UNC alternative this yields nothing, so a driver on a share
    // stays unfindable even though the error named its exact location.
    expect(quotedAbsolutePaths(`ENOENT: open '\\\\server\\share\\node_modules\\duckdb\\package.json'`)).toEqual([
      "\\\\server\\share\\node_modules\\duckdb\\package.json",
    ])
  })

  test("ignores relative paths and bare words", () => {
    expect(quotedAbsolutePaths(`Cannot find package 'duckdb' from 'lib/x.js'`)).toEqual([])
  })
})

describe("enclosingNodeModulesRoots on Windows separators", () => {
  test("walks back through a UNC path, innermost first", () => {
    const roots = enclosingNodeModulesRoots(
      "\\\\server\\share\\app\\node_modules\\a\\node_modules\\duckdb\\package.json",
      "\\",
    )
    expect(roots).toEqual([
      "\\\\server\\share\\app\\node_modules\\a\\node_modules",
      "\\\\server\\share\\app\\node_modules",
    ])
  })
})
