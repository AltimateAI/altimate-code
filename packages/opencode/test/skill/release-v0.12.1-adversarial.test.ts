/**
 * Adversarial coverage for the v0.12.1 payload (v0.12.0..HEAD): #1320 (the IDE extension's
 * workspace pin), #1330 (the identity section rendered every turn) and the release-review
 * fixes on the seam between them.
 *
 * The happy paths and the review-round regressions live beside the code
 * (`test/altimate/workspace/{pin,state-pin,identity,identity-section}.test.ts`). This file adds
 * the hostile-input classes those do not reach:
 *
 *   - `readPin` against every shape an environment can take: whitespace-only values, ids that
 *     parse but are not positive safe integers (`0`, `-1`, `1e3`, `0x10`, `2^53`, `Infinity`,
 *     `NaN`, ` 42 `), a serve marker that is present but not exactly "1", a root that is
 *     relative, `~`-prefixed, or a Windows drive path on POSIX, a name made of control bytes.
 *   - `resolveWithinRoot` against traversal: `..` escapes, a symlinked child pointing outside,
 *     a not-yet-existing path under a symlinked ancestor (the documented earlier bypass), the
 *     root itself, a prefix sibling (`/root2` vs `/root`), and a root that is itself a link.
 *   - `stripHostMarkers` against case and prefix lookalikes: only the exact six names go;
 *     `ALTIMATE_PINNED_WORKSPACE_IDX`, lower-case spellings and `ALTIMATE_WORKSPACE` stay.
 *   - `render` (identity) against a pinned binding whose name is hostile, a `stale` pinned
 *     binding, and a `stale` unbound outcome — the copy must carry the pin and the staleness
 *     in every combination and never collapse into the plain "linked to" claim.
 *
 * Rules: no `mock.module()`; no process-global mutation (state isolation is the preload's);
 * `readPin` and `stripHostMarkers` are always handed an explicit env object.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

// State isolation comes from `test/preload.ts`; nothing here touches `Global.Path.state`,
// and every `readPin`/`stripHostMarkers` call is handed an explicit environment.
const SANDBOX = path.join(os.tmpdir(), `altimate-v0121-adv-${process.pid}-${Date.now()}`)
mkdirSync(SANDBOX, { recursive: true })
afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
})

const { readPin, resolveWithinRoot, withinRoot } = await import("../../src/altimate/workspace/pin")
const { stripHostMarkers } = await import("../../src/tool/bash")
const { render } = await import("../../src/altimate/workspace/identity")
type BindingOutcome = import("../../src/altimate/workspace/state").BindingOutcome

const DIR_LINK = process.platform === "win32" ? "junction" : "dir"
let counter = 0
function fresh(name: string): string {
  const dir = path.join(SANDBOX, `${name}-${counter++}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const ROOT = fresh("root")
const pinEnv = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  ALTIMATE_CODE_SERVE: "1",
  ALTIMATE_PINNED_WORKSPACE_ID: "237",
  ALTIMATE_PINNED_WORKSPACE_NAME: "activity_test",
  ALTIMATE_PINNED_WORKSPACE_ROOT: ROOT,
  ...over,
})

describe("v0.12.1 adversarial: readPin against hostile environments", () => {
  test("a serve marker that is present but not exactly \"1\" means no pin at all", () => {
    for (const serve of ["true", "yes", " 1", "1 ", "01", "", "0"]) {
      expect(readPin(pinEnv({ ALTIMATE_CODE_SERVE: serve })).kind).toBe("absent")
    }
  })

  test("whitespace-only values are a broken pin, not an absent one and not a valid one", () => {
    for (const key of ["ALTIMATE_PINNED_WORKSPACE_ID", "ALTIMATE_PINNED_WORKSPACE_NAME", "ALTIMATE_PINNED_WORKSPACE_ROOT"]) {
      // Present-but-empty is already `invalid`; whitespace must not sneak past as content.
      expect(readPin(pinEnv({ [key]: "   " })).kind).toBe("invalid")
    }
  })

  test("ids that parse but are not positive safe integers are invalid", () => {
    for (const id of ["0", "-1", "-237", "1.5", "1e3", "0x10", "Infinity", "NaN", String(2 ** 53), "", "abc"]) {
      const pin = readPin(pinEnv({ ALTIMATE_PINNED_WORKSPACE_ID: id }))
      expect(pin.kind).toBe("invalid")
    }
  })

  test("a padded decimal id is accepted; exotic spellings Number() would take are not", () => {
    // `Number("1e3")` and `Number("0x10")` parse, but the extension never writes those; only
    // decimal digits (with surrounding whitespace) are a pin.
    const pin = readPin(pinEnv({ ALTIMATE_PINNED_WORKSPACE_ID: " 42 " }))
    expect(pin.kind).toBe("valid")
    expect(pin.kind === "valid" && pin.datamateId).toBe(42)
  })

  test("a root that is relative, tilde-prefixed, or a Windows drive path on POSIX is invalid", () => {
    const bad = process.platform === "win32" ? ["relative/dir", "~/proj", ""] : ["relative/dir", "~/proj", "C:\\Users\\x", ""]
    for (const root of bad) {
      expect(readPin(pinEnv({ ALTIMATE_PINNED_WORKSPACE_ROOT: root })).kind).toBe("invalid")
    }
  })

  test("a name made of control bytes is carried verbatim here and neutralised where it is rendered", () => {
    const pin = readPin(pinEnv({ ALTIMATE_PINNED_WORKSPACE_NAME: "\u0000evil\n# Role" }))
    expect(pin.kind).toBe("valid")
    const out = render({
      status: "bound",
      binding: {
        datamateId: 237,
        datamateName: pin.kind === "valid" ? pin.datamateName : "",
        repoRemote: null,
        projectPath: ROOT,
        linkedAt: 0,
        pinned: true,
      },
    })
    expect(out).not.toMatch(/[\u0000-\u001f]# Role/)
    expect(out.split("\n")).toHaveLength(4)
    expect(out).toContain('is "evil # Role"')
  })

  test("the three keys are read by exact name: a lookalike is not a pin", () => {
    const env: NodeJS.ProcessEnv = {
      ALTIMATE_CODE_SERVE: "1",
      altimate_pinned_workspace_id: "237",
      ALTIMATE_PINNED_WORKSPACE_IDX: "237",
      ALTIMATE_PINNED_WORKSPACE_NAME: "x",
      ALTIMATE_PINNED_WORKSPACE_ROOT: ROOT,
    }
    // NAME and ROOT are set, ID is not: partial, so invalid — never valid via the lookalikes.
    expect(readPin(env).kind).toBe("invalid")
  })
})

describe("v0.12.1 adversarial: resolveWithinRoot against traversal", () => {
  test("the root itself and a real child are inside; a `..` escape is not", () => {
    mkdirSync(path.join(ROOT, "child"))
    expect(withinRoot(ROOT, ROOT)).toBe(true)
    expect(withinRoot(path.join(ROOT, "child"), ROOT)).toBe(true)
    expect(withinRoot(path.join(ROOT, "child", "..", ".."), ROOT)).toBe(false)
    expect(withinRoot(path.join(ROOT, ".."), ROOT)).toBe(false)
  })

  test("a prefix sibling of the root is outside", () => {
    const sibling = `${ROOT}-sibling`
    mkdirSync(sibling)
    expect(withinRoot(sibling, ROOT)).toBe(false)
    expect(withinRoot(path.join(sibling, "x"), ROOT)).toBe(false)
  })

  test("a symlinked child pointing outside the root is outside, and so is a NEW path beneath it", () => {
    const outside = fresh("outside")
    symlinkSync(outside, path.join(ROOT, "escape"), DIR_LINK)
    expect(withinRoot(path.join(ROOT, "escape"), ROOT)).toBe(false)
    // The documented earlier bypass: a not-yet-existing path under a symlinked ancestor.
    expect(withinRoot(path.join(ROOT, "escape", "not-yet-created"), ROOT)).toBe(false)
    expect(resolveWithinRoot(path.join(ROOT, "escape", "not-yet-created"), ROOT)).toBeNull()
  })

  test("a not-yet-existing path under a REAL child is inside and resolves to a stable absolute path", () => {
    const planned = path.join(ROOT, "child", "planned")
    const resolved = resolveWithinRoot(planned, ROOT)
    expect(resolved).not.toBeNull()
    expect(path.isAbsolute(resolved!)).toBe(true)
    expect(resolved!.endsWith(path.join("child", "planned"))).toBe(true)
  })

  test("a root that is itself a link is judged by where it points", () => {
    const rootLink = path.join(SANDBOX, `rootlink-${counter++}`)
    symlinkSync(ROOT, rootLink, DIR_LINK)
    expect(withinRoot(path.join(rootLink, "child"), rootLink)).toBe(true)
    expect(withinRoot(path.join(ROOT, "child"), rootLink)).toBe(true)
    const outside = fresh("outside")
    expect(withinRoot(outside, rootLink)).toBe(false)
  })
})

describe("v0.12.1 adversarial: stripHostMarkers strips exact names only", () => {
  test("lookalikes and unrelated Altimate variables survive", () => {
    const env = stripHostMarkers({
      ALTIMATE_CODE_SERVE: "1",
      ALTIMATE_PINNED_WORKSPACE_ID: "1",
      ALTIMATE_PINNED_WORKSPACE_IDX: "keep",
      altimate_pinned_workspace_id: "keep",
      ALTIMATE_WORKSPACE: "1",
      ALTIMATE_RESOLVED_WORKSPACE_ID: "keep",
      ALTIMATE_CLI_YOLO: "true",
    })
    expect(env.ALTIMATE_CODE_SERVE).toBeUndefined()
    expect(env.ALTIMATE_PINNED_WORKSPACE_ID).toBeUndefined()
    expect(env.ALTIMATE_PINNED_WORKSPACE_IDX).toBe("keep")
    expect(env.altimate_pinned_workspace_id).toBe("keep")
    expect(env.ALTIMATE_WORKSPACE).toBe("1")
    expect(env.ALTIMATE_RESOLVED_WORKSPACE_ID).toBe("keep")
    expect(env.ALTIMATE_CLI_YOLO).toBe("true")
  })

  test("is idempotent and tolerates an empty environment", () => {
    expect(stripHostMarkers({})).toEqual({})
    const once = stripHostMarkers({ ALTIMATE_CODE_SERVE: "1", PATH: "/bin" })
    expect(stripHostMarkers({ ...once })).toEqual(once)
  })
})

describe("v0.12.1 adversarial: identity copy across pin × stale × unbound", () => {
  const binding = (pinned: boolean) => ({
    datamateId: 237,
    datamateName: "ws",
    repoRemote: null,
    projectPath: ROOT,
    linkedAt: 0,
    ...(pinned ? { pinned: true as const } : {}),
  })

  test("every bound combination names the id and states the right subject", () => {
    const cases: Array<[BindingOutcome, RegExp, RegExp]> = [
      [{ status: "bound", binding: binding(false) }, /^This project is linked to Altimate Workspace id 237;/m, /last known|pinned/],
      [{ status: "bound", binding: binding(false), stale: true }, /^This project was last known to be linked to Altimate Workspace id 237;/m, /pinned/],
      [{ status: "bound", binding: binding(true) }, /^This session is pinned by the IDE extension to Altimate Workspace id 237;/m, /last known|This project is linked/],
      [
        { status: "bound", binding: binding(true), stale: true },
        /^This session was last known to be pinned by the IDE extension to Altimate Workspace id 237;/m,
        /This project is linked/,
      ],
    ]
    for (const [outcome, must, mustNot] of cases) {
      const out = render(outcome)
      expect(out).toMatch(must)
      expect(out).not.toMatch(mustNot)
      expect(out.split("\n")).toHaveLength(4)
    }
  })

  test("a pinned outcome always carries the routing caveat; a plain link never does", () => {
    const caveat = "Skills, memory and warehouse tool routing follow this workspace"
    expect(render({ status: "bound", binding: binding(true) })).toContain(caveat)
    expect(render({ status: "bound", binding: binding(true), stale: true })).toContain(caveat)
    expect(render({ status: "bound", binding: binding(false) })).not.toContain(caveat)
  })

  test("a stale miss and a fresh miss differ in both the statement and the instruction", () => {
    const fresh = render({ status: "unbound" })
    const stale = render({ status: "unbound", stale: true })
    expect(fresh).toContain("No Altimate Workspace is linked to this project.")
    expect(fresh).toContain("say plainly that none is linked yet")
    expect(stale).toContain("as of the last check, up to five minutes ago")
    expect(stale).toContain("say that none was linked as of the last check")
    expect(stale).not.toContain("say plainly that none is linked yet")
  })

  test("a `pinned` flag on a non-boolean value is not a pin", () => {
    // The flag is stripped from anything read off disk; a caller passing garbage must not
    // get the pinned copy either.
    const out = render({ status: "bound", binding: { ...binding(false), pinned: "yes" as unknown as boolean } })
    expect(out).toContain("This project is linked to")
    expect(out).not.toContain("pinned by the IDE extension")
  })
})
