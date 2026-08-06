import { describe, expect, test } from "bun:test"
import { MAX_PARENT_DEPTH, rootSessionID, yoloEnabled } from "../../src/util/yolo"

// Build a parentOf lookup from a child -> parent map.
function chain(map: Record<string, string>) {
  return (sessionID: string) => map[sessionID]
}

describe("rootSessionID", () => {
  test("a root session resolves to itself", () => {
    expect(rootSessionID("a", chain({}))).toBe("a")
  })

  test("a subagent resolves to its parent", () => {
    expect(rootSessionID("child", chain({ child: "root" }))).toBe("root")
  })

  test("a nested subagent resolves to the top of the chain", () => {
    expect(rootSessionID("grandchild", chain({ grandchild: "child", child: "root" }))).toBe("root")
  })

  test("a self-parenting session terminates instead of looping", () => {
    expect(rootSessionID("a", chain({ a: "a" }))).toBe("a")
  })

  test("a parent cycle terminates instead of looping", () => {
    expect(rootSessionID("a", chain({ a: "b", b: "a" }))).toBe("b")
  })

  test("a chain longer than the depth cap terminates", () => {
    const map: Record<string, string> = {}
    const length = MAX_PARENT_DEPTH + 10
    for (let i = 0; i < length; i++) map[`s${i}`] = `s${i + 1}`
    // Must return *something* without hanging; the cap is a safety valve, not a feature.
    expect(typeof rootSessionID("s0", chain(map))).toBe("string")
  })
})

describe("yoloEnabled", () => {
  const parentOf = chain({ child: "root", grandchild: "child" })

  test("defaults to off when nothing is set", () => {
    expect(yoloEnabled({ sessionID: "root", overrides: {}, parentOf, fallback: false })).toBe(false)
  })

  test("inherits the process-wide --yolo default", () => {
    expect(yoloEnabled({ sessionID: "root", overrides: {}, parentOf, fallback: true })).toBe(true)
  })

  test("an explicit per-session enable wins over an off default", () => {
    expect(yoloEnabled({ sessionID: "root", overrides: { root: true }, parentOf, fallback: false })).toBe(true)
  })

  // The contract from the ticket: "allow users to disable it without confirmation".
  // Without this, launching with --yolo would make the session impossible to un-yolo.
  test("an explicit per-session disable wins over --yolo", () => {
    expect(yoloEnabled({ sessionID: "root", overrides: { root: false }, parentOf, fallback: true })).toBe(false)
  })

  // The regression that motivated root-session normalization: subagents run in their
  // own child session, so a naive per-session lookup would leave them prompting.
  test("a subagent inherits its parent's enable", () => {
    expect(yoloEnabled({ sessionID: "child", overrides: { root: true }, parentOf, fallback: false })).toBe(true)
  })

  test("a nested subagent inherits the root's enable", () => {
    expect(yoloEnabled({ sessionID: "grandchild", overrides: { root: true }, parentOf, fallback: false })).toBe(true)
  })

  test("a subagent inherits its parent's disable even under --yolo", () => {
    expect(yoloEnabled({ sessionID: "child", overrides: { root: false }, parentOf, fallback: true })).toBe(false)
  })

  // An override written against a CHILD id must not be consulted — the toggle always
  // writes to the root, so a child-keyed entry means something went wrong upstream and
  // silently honouring it would reintroduce per-child divergence.
  test("an override keyed by a child id is ignored in favour of the root", () => {
    expect(yoloEnabled({ sessionID: "child", overrides: { child: true }, parentOf, fallback: false })).toBe(false)
  })

  test("an unrelated session is unaffected by another session's override", () => {
    expect(yoloEnabled({ sessionID: "other", overrides: { root: true }, parentOf, fallback: false })).toBe(false)
  })
})
