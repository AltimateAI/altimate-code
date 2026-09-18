// altimate_change - new file
//
// Unit coverage for the IDE extension's workspace pin parser. Pure: no cache, no network, no
// instance context — `readPin` reads an env bag it is handed, so every case is a plain assertion.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { readPin, withinRoot } from "../../../src/altimate/workspace/pin"

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
