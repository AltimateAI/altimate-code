import { describe, expect, test } from "bun:test"
import { MAX_PARENT_DEPTH, resolveRoot, yoloEnabled, type SessionNode } from "../../src/util/yolo"

// Build a getSession lookup from a child -> parent map. Every id in the map (and every
// parent it names) is treated as a KNOWN session unless listed in `unknown`.
function store(map: Record<string, string | undefined>, unknown: string[] = []) {
  const ids = new Set<string>([...Object.keys(map), ...Object.values(map).filter((v): v is string => !!v)])
  for (const id of unknown) ids.delete(id)
  return (sessionID: string): SessionNode | undefined => {
    if (!ids.has(sessionID)) return undefined
    return { parentID: map[sessionID] }
  }
}

describe("resolveRoot", () => {
  test("a root session resolves to itself", () => {
    expect(resolveRoot("a", store({ a: undefined }))).toBe("a")
  })

  test("a subagent resolves to its parent", () => {
    expect(resolveRoot("child", store({ child: "root", root: undefined }))).toBe("root")
  })

  test("a nested subagent resolves to the top of the chain", () => {
    expect(resolveRoot("grandchild", store({ grandchild: "child", child: "root", root: undefined }))).toBe("root")
  })

  // A cycle has no root, so it must fail closed rather than resolve to whichever node
  // the walk happened to stop on — that node could carry an override, or inherit --yolo.
  test("a self-parenting session does not resolve", () => {
    expect(resolveRoot("a", store({ a: "a" }))).toBeUndefined()
  })

  test("a parent cycle does not resolve", () => {
    expect(resolveRoot("a", store({ a: "b", b: "a" }))).toBeUndefined()
  })

  test("a cyclic chain never auto-approves, even under --yolo", () => {
    const cyclic = store({ a: "b", b: "a" })
    expect(yoloEnabled({ sessionID: "a", overrides: {}, getSession: cyclic, fallback: true })).toBe(false)
    expect(yoloEnabled({ sessionID: "a", overrides: { b: true }, getSession: cyclic, fallback: false })).toBe(false)
  })

  // Fail-closed cases. Each returns undefined, which callers must treat as
  // "cannot prove the root — do not auto-approve".
  test("an unknown session does not resolve", () => {
    expect(resolveRoot("ghost", store({}))).toBeUndefined()
  })

  test("an unhydrated child does not resolve to itself", () => {
    // The dangerous case: returning "child" here would miss an override on the root.
    expect(resolveRoot("child", store({ child: "root", root: undefined }, ["child"]))).toBeUndefined()
  })

  test("an unknown ancestor does not resolve", () => {
    expect(resolveRoot("child", store({ child: "root", root: undefined }, ["root"]))).toBeUndefined()
  })

  test("a chain longer than the depth cap does not resolve", () => {
    const map: Record<string, string | undefined> = {}
    const length = MAX_PARENT_DEPTH + 10
    for (let i = 0; i < length; i++) map[`s${i}`] = `s${i + 1}`
    map[`s${length}`] = undefined
    expect(resolveRoot("s0", store(map))).toBeUndefined()
  })

  test("a chain exactly at the depth cap still resolves", () => {
    // Guards the boundary in the other direction, so the cap cannot silently
    // shrink to something that rejects ordinary nesting.
    const map: Record<string, string | undefined> = {}
    for (let i = 0; i < MAX_PARENT_DEPTH - 1; i++) map[`s${i}`] = `s${i + 1}`
    map[`s${MAX_PARENT_DEPTH - 1}`] = undefined
    expect(resolveRoot("s0", store(map))).toBe(`s${MAX_PARENT_DEPTH - 1}`)
  })
})

describe("yoloEnabled", () => {
  const sessions = store({ root: undefined, child: "root", grandchild: "child", other: undefined })

  test("defaults to off when nothing is set", () => {
    expect(yoloEnabled({ sessionID: "root", overrides: {}, getSession: sessions, fallback: false })).toBe(false)
  })

  test("inherits the process-wide --yolo default", () => {
    expect(yoloEnabled({ sessionID: "root", overrides: {}, getSession: sessions, fallback: true })).toBe(true)
  })

  test("an explicit per-session enable wins over an off default", () => {
    expect(yoloEnabled({ sessionID: "root", overrides: { root: true }, getSession: sessions, fallback: false })).toBe(
      true,
    )
  })

  // The contract from the spec: "allow users to disable it without confirmation".
  // Without this, launching with --yolo would make the session impossible to un-yolo.
  test("an explicit per-session disable wins over --yolo", () => {
    expect(yoloEnabled({ sessionID: "root", overrides: { root: false }, getSession: sessions, fallback: true })).toBe(
      false,
    )
  })

  test("a subagent inherits its parent's enable", () => {
    expect(yoloEnabled({ sessionID: "child", overrides: { root: true }, getSession: sessions, fallback: false })).toBe(
      true,
    )
  })

  test("a nested subagent inherits the root's enable", () => {
    expect(
      yoloEnabled({ sessionID: "grandchild", overrides: { root: true }, getSession: sessions, fallback: false }),
    ).toBe(true)
  })

  test("a subagent inherits its parent's disable even under --yolo", () => {
    expect(yoloEnabled({ sessionID: "child", overrides: { root: false }, getSession: sessions, fallback: true })).toBe(
      false,
    )
  })

  test("an override keyed by a child id is ignored in favour of the root", () => {
    expect(yoloEnabled({ sessionID: "child", overrides: { child: true }, getSession: sessions, fallback: false })).toBe(
      false,
    )
  })

  test("an unrelated session is unaffected by another session's override", () => {
    expect(yoloEnabled({ sessionID: "other", overrides: { root: true }, getSession: sessions, fallback: false })).toBe(
      false,
    )
  })

  // The bypass this fail-closed rule exists to prevent: launched with --yolo, the user
  // explicitly turned it OFF on the root, then a child's request arrives before the
  // child session has been hydrated into the store. Resolving the child to itself would
  // miss the override and inherit fallback=true — auto-approving despite an explicit off.
  test("an unhydrated child does NOT inherit --yolo past an explicit parent disable", () => {
    const lagging = store({ root: undefined, child: "root" }, ["child"])
    expect(yoloEnabled({ sessionID: "child", overrides: { root: false }, getSession: lagging, fallback: true })).toBe(
      false,
    )
  })

  test("an unknown session never auto-approves, even under --yolo", () => {
    expect(yoloEnabled({ sessionID: "ghost", overrides: {}, getSession: sessions, fallback: true })).toBe(false)
  })

  test("an unknown session never auto-approves, even with an override on that id", () => {
    expect(yoloEnabled({ sessionID: "ghost", overrides: { ghost: true }, getSession: sessions, fallback: false })).toBe(
      false,
    )
  })
})
