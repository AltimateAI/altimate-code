/**
 * Ownership + containment (#1305 review round 2).
 *
 * `resolveInstall()` answers from the path alone, which cannot prove that the running
 * binary belongs to a manager's GLOBAL tree. These cover the two pieces that decide it.
 */
import { describe, test, expect } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { isInside, bunGlobalRoot } from "../../src/installation"

describe("bunGlobalRoot", () => {
  test("derives the package tree from the shim directory", () => {
    // `bun pm bin -g` reports the SHIM dir; packages live in a sibling tree. Conflating the
    // two rejected every global bun install as "not-global".
    expect(bunGlobalRoot("/home/u/.bun/bin")).toBe("/home/u/.bun/install/global/node_modules")
  })

  test("a bun global binary is inside the derived root", () => {
    const root = bunGlobalRoot("/home/u/.bun/bin")
    const exec = "/home/u/.bun/install/global/node_modules/@altimateai/altimate-code/bin/altimate-code"
    // The regression: the shim dir does NOT contain the executable, the package root does.
    expect(exec.startsWith("/home/u/.bun/bin")).toBe(false)
    expect(exec.startsWith(root)).toBe(true)
  })

  test("returns empty when bun reports nothing", () => {
    expect(bunGlobalRoot("")).toBe("")
  })
})

describe("isInside", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ownership-"))
  const parent = path.join(tmp, "node_modules")
  const sibling = path.join(tmp, "node_modules-other")
  fs.mkdirSync(parent, { recursive: true })
  fs.mkdirSync(sibling, { recursive: true })

  test("a child directory is inside", () => {
    expect(isInside(path.join(parent, "@altimateai", "altimate-code"), parent)).toBe(true)
  })

  test("the directory itself counts as inside", () => {
    expect(isInside(parent, parent)).toBe(true)
  })

  test("a sibling sharing a name prefix is NOT inside", () => {
    // The previous lowercased startsWith() matched `/x/node_modules-other` against
    // `/x/node_modules`, which let an unrelated tree pass the ownership check.
    expect(isInside(path.join(sibling, "pkg"), parent)).toBe(false)
  })

  test("an unrelated path is not inside", () => {
    expect(isInside("/somewhere/else/bin/altimate", parent)).toBe(false)
  })

  test("symlinked parents resolve before comparison", () => {
    // A symlinked prefix (/var vs /private/var on macOS, nvm, asdf) previously produced a
    // false "not-global" refusal because only the executable side was realpath-resolved.
    const link = path.join(tmp, "link-to-node_modules")
    try {
      fs.symlinkSync(parent, link)
    } catch {
      return // symlinks unavailable (e.g. unprivileged Windows) — nothing to assert
    }
    expect(isInside(path.join(link, "pkg"), parent)).toBe(true)
    expect(isInside(path.join(parent, "pkg"), link)).toBe(true)
  })

  test("an empty parent is never a container", () => {
    // globalLayout() returns "" when the manager cannot answer; that must not read as
    // containment (which would silently approve any path).
    expect(isInside("/anything", "")).toBe(false)
  })
})
