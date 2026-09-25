// altimate_change - new file
//
// Unit coverage for the IDE extension's workspace pin parser. Pure: no cache, no network, no
// instance context — `readPin` reads an env bag it is handed, so every case is a plain assertion.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { readPin, resolveWithinRoot, withinRoot } from "../../../src/altimate/workspace/pin"

const ROOT = path.resolve("/tmp/pin-root")

function env(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    ALTIMATE_CODE_SERVE: "1",
    ALTIMATE_PINNED_WORKSPACE_ID: "42",
    ALTIMATE_PINNED_WORKSPACE_NAME: "Data Eng",
    ALTIMATE_PINNED_WORKSPACE_ROOT: ROOT,
    ...over,
  }
}

describe("readPin", () => {
  test("a fully-specified pin under serve is valid", () => {
    const pin = readPin(env())
    expect(pin.kind).toBe("valid")
    if (pin.kind !== "valid") return
    expect(pin.datamateId).toBe(42)
    expect(pin.datamateName).toBe("Data Eng")
    expect(pin.root).toBe(ROOT)
  })

  test("stands down outside serve, so the TUI's --workspace flow is untouched", () => {
    // The regression this guards: `launch-resolve.ts` sets only an id for `--workspace`. If the
    // pin ever read that shape it would classify it invalid and fail the TUI closed.
    expect(readPin(env({ ALTIMATE_CODE_SERVE: undefined })).kind).toBe("absent")
  })

  test("no pin variables at all is absent, not invalid", () => {
    const pin = readPin({ ALTIMATE_CODE_SERVE: "1" })
    expect(pin.kind).toBe("absent")
  })

  test.each([
    ["missing name", { ALTIMATE_PINNED_WORKSPACE_NAME: undefined }],
    ["missing root", { ALTIMATE_PINNED_WORKSPACE_ROOT: undefined }],
    ["missing id", { ALTIMATE_PINNED_WORKSPACE_ID: undefined }],
  ])("a partial pin (%s) is invalid, never partially honoured", (_label, over) => {
    expect(readPin(env(over as Record<string, string | undefined>)).kind).toBe("invalid")
  })

  test.each([["zero", "0"], ["negative", "-3"], ["non-numeric", "abc"], ["float", "4.5"]])(
    "a %s datamate id is invalid",
    (_label, id) => {
      expect(readPin(env({ ALTIMATE_PINNED_WORKSPACE_ID: id })).kind).toBe("invalid")
    },
  )

  test("a relative root is invalid", () => {
    expect(readPin(env({ ALTIMATE_PINNED_WORKSPACE_ROOT: "relative/path" })).kind).toBe("invalid")
  })
})

describe("withinRoot — symlink containment", () => {
  // The bypass this replaced a lexical fallback to fix. `realpathSync` fails on a path that does
  // not exist yet, and the old code then compared the raw string, so a not-yet-created path under
  // a symlinked ancestor passed the prefix test and let an outside tree be attributed to the
  // pinned workspace. The directory arrives from the caller-supplied `x-opencode-directory`.
  const sandbox = mkdtempSync(path.join(os.tmpdir(), "pin-symlink-"))
  const root = path.join(sandbox, "root")
  const outside = path.join(sandbox, "outside")
  mkdirSync(root, { recursive: true })
  mkdirSync(outside, { recursive: true })
  symlinkSync(outside, path.join(root, "link"), "dir")

  afterAll(() => rmSync(sandbox, { recursive: true, force: true }))

  test("an EXISTING directory reached through a symlink out of the root is rejected", () => {
    expect(withinRoot(path.join(root, "link"), root)).toBe(false)
  })

  test("a NOT-YET-EXISTING descendant under a symlinked ancestor is rejected", () => {
    // The exact case the lexical fallback accepted.
    expect(withinRoot(path.join(root, "link", "new"), root)).toBe(false)
  })

  test("a real descendant that does not exist yet is still accepted", () => {
    // Fail-closed must not become fail-everything: `serve` legitimately resolves directories that
    // have not been created yet.
    expect(withinRoot(path.join(root, "pkg", "src"), root)).toBe(true)
  })

  test("a `..` escape is rejected", () => {
    expect(withinRoot(path.join(root, "..", "outside"), root)).toBe(false)
  })
})

describe("resolveWithinRoot — the validated path is what callers carry forward", () => {
  const sandbox2 = mkdtempSync(path.join(os.tmpdir(), "pin-canon-"))
  const root2 = path.join(sandbox2, "root")
  mkdirSync(path.join(root2, "pkg"), { recursive: true })

  afterAll(() => rmSync(sandbox2, { recursive: true, force: true }))

  test("returns the resolved path, not the caller's spelling", () => {
    // `resolveBindingOutcome` validates containment, then awaits credentials and a network call
    // before it needs the directory again. Re-deriving it from the caller's string at that point
    // would let a symlink swapped in the gap change which path is used. The canonical form is
    // captured once, here.
    const messy = path.join(root2, ".", "pkg", "..", "pkg")
    const got = resolveWithinRoot(messy, root2)
    expect(got).toBe(realpathSync(path.join(root2, "pkg")))
  })

  test("a directory that does not exist yet still yields a stable path", () => {
    const got = resolveWithinRoot(path.join(root2, "not-created-yet"), root2)
    expect(got).toBe(path.resolve(root2, "not-created-yet"))
  })

  test("returns null for anything outside the root, matching withinRoot", () => {
    const outside = path.resolve("/tmp/definitely-elsewhere")
    expect(resolveWithinRoot(outside, root2)).toBeNull()
    expect(withinRoot(outside, root2)).toBe(false)
  })
})

describe("withinRoot", () => {
  test("the root itself and its descendants are in scope", () => {
    expect(withinRoot(ROOT, ROOT)).toBe(true)
    expect(withinRoot(path.join(ROOT, "pkg", "src"), ROOT)).toBe(true)
  })

  test("a sibling sharing a name prefix is NOT in scope", () => {
    // `startsWith` without the separator would call `/tmp/pin-root-other` a child of
    // `/tmp/pin-root`, which is how a directory outside the pin gets its memory attributed to the
    // pinned workspace.
    expect(withinRoot(`${ROOT}-other`, ROOT)).toBe(false)
  })

  test("an unrelated directory is not in scope", () => {
    expect(withinRoot(path.resolve("/tmp/somewhere-else"), ROOT)).toBe(false)
  })
})
