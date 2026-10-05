/**
 * Adversarial coverage for the v0.12.4 release payload (v0.12.3..HEAD): the workspace pilot's
 * `serve` HTTP routes (#1366, #1371), skipped-skill reporting (#1374, #1376), relink / consent /
 * pinned skills (#1373), account-scoped binding cache and skill snapshot (#1377), and the TUI
 * model-store copy (#1365, covered by its own aliasing test), PLUS this release's review fixes:
 *
 *  - user-facing link / re-link messages no longer say "binding" or "pre-check" (End User persona)
 *
 * Each PR carries its own behavioural suites (skill-sync, state-account-scope, the route tests,
 * skill.test.ts attribution cases). This file targets the pure helpers those PRs introduced with
 * hostile inputs: path traversal and lookalike segments against snapshot attribution, type
 * confusion against the precedence rule, raw-error leakage into user-facing skip reasons, control
 * characters in server-supplied skill ids, and header combinations against the route gate.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { readFileSync } from "fs"
import {
  isWithin,
  snapshotCopyYields,
  snapshotProjectOf,
} from "../../src/altimate/workspace/snapshot-path"
import {
  describeSyncProblems,
  displayId,
  forgetAnnouncement,
  shouldAnnounce,
  skipReason,
} from "../../src/altimate/workspace/skill-sync"
import { ConflictError, isHiddenBindingConflict } from "../../src/altimate/workspace/api-client"
import { Server } from "../../src/server/server"
import { WORKSPACE_PILOT_OFF_MESSAGE } from "../../src/cli/cmd/workspace-pilot"

const SNAP = path.join(".altimate-code", "skill", "_workspace")
// Native absolute paths, so the expectations hold on Windows (drive-qualified, `\\`) as on POSIX.
const ROOT = path.parse(process.cwd()).root
const abs = (...parts: string[]) => path.join(ROOT, ...parts)
const P = abs("p")

describe("v0.12.4 adversarial: snapshot attribution by path segments", () => {
  test("a traversal out of the snapshot is not attributed to it", () => {
    // Resolves to <root>/p/.altimate-code/evil — no `_workspace` segment survives.
    expect(snapshotProjectOf(`${P}${path.sep}${SNAP}${path.sep}..${path.sep}..${path.sep}evil${path.sep}SKILL.md`)).toBeNull()
  })

  test("a traversal INTO the snapshot is attributed after resolution", () => {
    expect(snapshotProjectOf(`${P}${path.sep}x${path.sep}..${path.sep}${SNAP}${path.sep}a${path.sep}SKILL.md`)).toBe(P)
  })

  test("lookalike segments are not a snapshot", () => {
    expect(snapshotProjectOf(abs("p", ".altimate-code", "skill", "_workspace2", "a", "SKILL.md"))).toBeNull()
    expect(snapshotProjectOf(abs("p", ".altimate-code-x", "skill", "_workspace", "a", "SKILL.md"))).toBeNull()
    expect(snapshotProjectOf(abs("p", ".altimate-code", "skills", "_workspace", "a", "SKILL.md"))).toBeNull()
    expect(snapshotProjectOf(abs("p", "_workspace", "skill", ".altimate-code", "a", "SKILL.md"))).toBeNull()
  })

  test("a project opened at the filesystem root is the root, not 'no project'", () => {
    const result = snapshotProjectOf(abs(SNAP, "a", "SKILL.md"))
    expect(result).not.toBeNull()
    expect(path.resolve(result!)).toBe(path.resolve(ROOT))
  })

  test("a Windows drive-root project is the drive root, not the bare drive", () => {
    const w = path.win32
    expect(snapshotProjectOf("C:\\.altimate-code\\skill\\_workspace\\a\\SKILL.md", w)).toBe("C:\\")
    expect(snapshotProjectOf("C:\\p\\.altimate-code\\skill\\_workspace\\a\\SKILL.md", w)).toBe("C:\\p")
    expect(snapshotProjectOf("\\\\srv\\share\\.altimate-code\\skill\\_workspace\\a\\SKILL.md", w)).toBe("\\\\srv\\share\\")
    expect(snapshotProjectOf("C:\\p\\_workspace\\SKILL.md", w)).toBeNull()
  })

  test("other Windows root spellings resolve to the root", () => {
    const w = path.win32
    expect(snapshotProjectOf("c:\\.altimate-code\\skill\\_workspace\\a\\SKILL.md", w)).toBe("c:\\")
    expect(snapshotProjectOf("C:/.altimate-code/skill/_workspace/a/SKILL.md", w)).toBe("C:\\")
    expect(snapshotProjectOf("\\\\?\\C:\\.altimate-code\\skill\\_workspace\\a\\SKILL.md", w)).toBe("\\\\?\\C:\\")
  })

  test("nested snapshots attribute to the outermost project", () => {
    expect(snapshotProjectOf(abs("p", SNAP, "q", SNAP, "a", "SKILL.md"))).toBe(P)
  })

  test("isWithin refuses a prefix sibling and a parent", () => {
    expect(isWithin(P, abs("p2", "SKILL.md"))).toBe(false)
    expect(isWithin(P, ROOT)).toBe(false)
    expect(isWithin(P, P)).toBe(true)
    expect(isWithin(P, `${P}${path.sep}a${path.sep}..${path.sep}b`)).toBe(true)
    expect(isWithin(P, `${P}${path.sep}..${path.sep}p2`)).toBe(false)
  })
})

describe("v0.12.4 adversarial: snapshotCopyYields type confusion", () => {
  const PROJ = abs("proj")
  const match = abs("proj", SNAP, "pub-1", "SKILL.md")
  const own = abs("proj", ".claude", "skills", "x", "SKILL.md")

  test("non-string or relative existing locations never make the workspace copy yield", () => {
    for (const existing of [undefined, null, 0, 1, {}, [], true, "builtin:x", "<built-in>", "relative/SKILL.md", ""]) {
      expect(snapshotCopyYields(match, existing as unknown, PROJ)).toBe(false)
    }
  })

  test("no project root means no protection", () => {
    expect(snapshotCopyYields(match, own, undefined)).toBe(false)
    expect(snapshotCopyYields(match, own, "")).toBe(false)
  })

  test("only a project skill inside the root wins over the workspace copy", () => {
    expect(snapshotCopyYields(match, own, PROJ)).toBe(true)
    expect(snapshotCopyYields(match, abs("proj2", ".claude", "skills", "x", "SKILL.md"), PROJ)).toBe(false)
    expect(snapshotCopyYields(match, abs("home", "me", ".claude", "skills", "x", "SKILL.md"), PROJ)).toBe(false)
    // Another snapshot entry is not the user's own skill.
    expect(snapshotCopyYields(match, abs("proj", SNAP, "pub-2", "SKILL.md"), PROJ)).toBe(false)
  })

  test("a non-snapshot match never yields, whatever it collides with", () => {
    expect(snapshotCopyYields(abs("proj", ".claude", "skills", "y", "SKILL.md"), own, PROJ)).toBe(false)
  })
})

describe("v0.12.4 adversarial: skip reasons never carry the raw error", () => {
  test("non-Error inputs fall back to the generic reason", () => {
    for (const err of [undefined, null, "size mismatch", 42, {}, [], Symbol("x")]) {
      expect(skipReason(err)).toBe("it could not be downloaded")
    }
  })

  test("paths and URLs in the message are not echoed", () => {
    const reason = skipReason(new Error("size mismatch for /Users/alice/.secrets/token at https://api.example.com/x"))
    expect(reason).toBe("its file size could not be verified")
    expect(reason).not.toContain("/Users")
    expect(reason).not.toContain("https://")
  })

  test("local write failures are attributed to the device, network codes are not", () => {
    for (const code of ["ENOSPC", "EDQUOT", "EACCES", "EPERM", "EROFS"]) {
      expect(skipReason(Object.assign(new Error("x"), { code }))).toBe("it could not be saved on this device")
    }
    for (const code of ["ECONNRESET", "ETIMEDOUT", "__proto__", "constructor", "toString"]) {
      expect(skipReason(Object.assign(new Error("x"), { code }))).toBe("it could not be downloaded")
    }
  })

  test("a message that merely CONTAINS a known prefix is not mapped", () => {
    expect(skipReason(new Error("server said: size mismatch"))).toBe("it could not be downloaded")
  })
})

describe("v0.12.4 adversarial: server-supplied skill ids are sanitised for display", () => {
  test("control characters and line separators are stripped", () => {
    expect(displayId("pub\u0000-1\n\r\t\u001b[31m")).toBe("pub-1[31m")
    expect(displayId("a b c\u0085d")).toBe("abcd")
  })

  test("an id that is empty after cleaning gets a placeholder", () => {
    expect(displayId("")).toBe("(unnamed skill)")
    expect(displayId("\u0000\n ")).toBe("(unnamed skill)")
  })

  test("the 64-character boundary", () => {
    expect(displayId("a".repeat(64))).toBe("a".repeat(64))
    const long = displayId("a".repeat(65))
    expect(long.length).toBe(64)
    expect(long.endsWith("…")).toBe(true)
  })
})

describe("v0.12.4 adversarial: describeSyncProblems boundaries", () => {
  const skipped = (n: number) => Array.from({ length: n }, (_, i) => ({ skill: `s${i}`, reason: "r" }))

  test("nothing skipped and no error is not a problem", () => {
    expect(describeSyncProblems({ changed: false, skipped: [] })).toBeNull()
  })

  test("an error alone is reported as the run failing", () => {
    expect(describeSyncProblems({ changed: false, skipped: [], error: "offline" })).toEqual({
      title: "Workspace skills not synced",
      message: "offline",
    })
  })

  test("singular, exactly three, and more than three", () => {
    expect(describeSyncProblems({ changed: false, skipped: skipped(1) })!.title).toBe("1 workspace skill skipped")
    const three = describeSyncProblems({ changed: false, skipped: skipped(3) })!
    expect(three.message.split("\n")).toHaveLength(3)
    expect(three.message).not.toContain("more")
    const five = describeSyncProblems({ changed: false, skipped: skipped(5) })!
    expect(five.title).toBe("5 workspace skills skipped")
    expect(five.message.split("\n")).toEqual(["s0: r", "s1: r", "s2: r", "…and 2 more"])
  })

  test("a run error is appended after the skipped list, not instead of it", () => {
    const p = describeSyncProblems({ changed: false, skipped: skipped(1), error: "publish failed" })!
    expect(p.message.split("\n")).toEqual(["s0: r", "publish failed"])
  })
})

describe("v0.12.4 adversarial: the announce latch", () => {
  const problem = { title: "t", message: "m" }

  test("the same problem is announced once per directory, keyed on the resolved path", () => {
    const dir = `/tmp/v0124-latch-${process.pid}-a`
    expect(shouldAnnounce(dir, problem)).toBe(true)
    expect(shouldAnnounce(`${dir}/./`, problem)).toBe(false)
    expect(shouldAnnounce(dir, { title: "t", message: "m2" })).toBe(true)
  })

  test("a clean run clears the latch so a recurrence is announced again", () => {
    const dir = `/tmp/v0124-latch-${process.pid}-b`
    expect(shouldAnnounce(dir, problem)).toBe(true)
    expect(shouldAnnounce(dir, null)).toBe(false)
    expect(shouldAnnounce(dir, problem)).toBe(true)
  })

  test("forgetting a stale problem does not drop a newer one", () => {
    const dir = `/tmp/v0124-latch-${process.pid}-c`
    const newer = { title: "t", message: "newer" }
    expect(shouldAnnounce(dir, problem)).toBe(true)
    expect(shouldAnnounce(dir, newer)).toBe(true)
    forgetAnnouncement(dir, problem)
    expect(shouldAnnounce(dir, newer)).toBe(false)
    forgetAnnouncement(dir, newer)
    expect(shouldAnnounce(dir, newer)).toBe(true)
  })
})

describe("v0.12.4 adversarial: workspace route gate", () => {
  // Workspaces are on by default; ALTIMATE_DISABLE_WORKSPACE is the only way to turn them off.
  const original = process.env.ALTIMATE_DISABLE_WORKSPACE
  beforeEach(() => {
    delete process.env.ALTIMATE_DISABLE_WORKSPACE
  })
  afterEach(() => {
    if (original === undefined) delete process.env.ALTIMATE_DISABLE_WORKSPACE
    else process.env.ALTIMATE_DISABLE_WORKSPACE = original
  })

  test("with workspaces turned off every request is a 409, whatever its headers", () => {
    process.env.ALTIMATE_DISABLE_WORKSPACE = "1"
    for (const [origin, fetchSite] of [
      [undefined, undefined],
      ["http://127.0.0.1:4096", "same-origin"],
      ["https://evil.example", "cross-site"],
    ] as const) {
      expect(Server.workspaceRouteRefusal(origin, "127.0.0.1:4096", "pw", fetchSite)?.status).toBe(409)
    }
  })

  test("a browser-labelled cross-site request is refused even with a password and matching origin", () => {
    for (const fetchSite of ["cross-site", "same-site", "Same-Origin", "NONE", " same-origin"]) {
      expect(Server.workspaceRouteRefusal("http://127.0.0.1:4096", "127.0.0.1:4096", "pw", fetchSite)?.status).toBe(403)
    }
  })

  test("an origin on an unsecured server is refused; a native client is not", () => {
    // "" rather than undefined: undefined selects the default, the environment's server password.
    expect(Server.workspaceRouteRefusal("http://127.0.0.1:4096", "127.0.0.1:4096", "")?.status).toBe(403)
    expect(Server.workspaceRouteRefusal(undefined, "127.0.0.1:4096", "")).toBeUndefined()
  })

  test("with a password, malformed and lookalike origins are refused", () => {
    for (const origin of ["null", "not a url", "http://127.0.0.1:4096.evil.example", "http://127.0.0.1:40960", "http://localhost:4096"]) {
      expect(Server.workspaceRouteRefusal(origin, "127.0.0.1:4096", "pw")?.status).toBe(403)
    }
    expect(Server.workspaceRouteRefusal("http://127.0.0.1:4096", undefined, "pw")?.status).toBe(403)
  })
})

describe("v0.12.4 adversarial: hidden-workspace conflicts", () => {
  test("only a ConflictError naming an id and withholding the name is a hidden workspace", () => {
    const conflict = (detail: Record<string, unknown>) => new ConflictError(detail as never)
    expect(isHiddenBindingConflict(conflict({ message: "x", existing_datamate_id: 7 }))).toBe(true)
    expect(isHiddenBindingConflict(conflict({ message: "x", existing_datamate_id: 7, existing_datamate_name: "Growth" }))).toBe(false)
    expect(isHiddenBindingConflict(conflict({ message: "x", existing_datamate_id: "7" }))).toBe(false)
    expect(isHiddenBindingConflict(conflict({ message: "x" }))).toBe(false)
    for (const err of [undefined, null, new Error("409"), { detail: { existing_datamate_id: 7 } }, "conflict"]) {
      expect(isHiddenBindingConflict(err)).toBe(false)
    }
  })
})

describe("v0.12.4 adversarial: user-facing wording (release review fixes)", () => {
  const src = (p: string) => readFileSync(path.resolve(import.meta.dir, "..", "..", "src", p), "utf-8")

  test("link and re-link messages speak of links, not bindings or pre-checks", () => {
    const link = src("cli/cmd/link.ts")
    const tui = src("plugin/tui/altimate/workspace.tsx")
    for (const stale of [
      "Pre-check missed an existing binding",
      "No existing binding to re-link",
      "No existing binding for this remote to re-link",
      "pre-check skipped",
      "look up existing bindings",
      "Binding to project",
      "Cannot rebind",
      "no longer exists.",
    ]) {
      expect(link).not.toContain(stale)
      expect(tui).not.toContain(stale)
    }
    expect(link).toContain("This project is already linked to a workspace — re-linking it instead.")
    expect(tui).toContain("Could not reach the Altimate workspace service to check for an existing link.")
    // A 404 means gone OR not visible to this account (the server answers both the same way),
    // on the attach path as well as the re-link path: TUI picker, TUI inline attach, CLI.
    const notFound = "That workspace, or this project's link to it, could not be found, or you no longer have access to it."
    expect(tui.split(notFound).length - 1).toBe(2)
    expect(link.split(notFound).length - 1).toBe(1)
    // The re-link guard throws this, and both surfaces show a thrown error's message as-is.
    const relink = "Cannot re-link: the existing link was found by this project's"
    expect(link).toContain(relink)
    expect(tui).toContain(relink)
  })

  test("the turned-off message names the switch to unset", () => {
    expect(WORKSPACE_PILOT_OFF_MESSAGE).toContain("ALTIMATE_DISABLE_WORKSPACE")
  })
})
