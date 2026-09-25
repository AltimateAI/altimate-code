// altimate_change - new file
//
// Which skills the serve routes offer for publish (publishable.ts). Real directories in a sandbox;
// the home directory is redirected with OPENCODE_TEST_HOME so "personal" is judged against it.
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const { explainIneligible, projectRootFor, publishEligibility } = await import(
  "../../../src/altimate/workspace/publishable"
)
const { IDE_DELIVERED_MARKER } = await import("../../../src/altimate/workspace/skill-publish")
const { isInWorkspaceSnapshot, snapshotCopyYields } = await import(
  "../../../src/altimate/workspace/snapshot-path"
)

const SANDBOX = mkdtempSync(path.join(os.tmpdir(), "altimate-publishable-"))
const HOME = path.join(SANDBOX, "home")
const ORIGINAL_TEST_HOME = process.env.OPENCODE_TEST_HOME
let project = ""

function skill(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const location = path.join(dir, "SKILL.md")
  writeFileSync(location, `---\nname: ${path.basename(dir)}\n---\n`)
  return location
}

beforeEach(() => {
  process.env.OPENCODE_TEST_HOME = HOME
  project = mkdtempSync(path.join(SANDBOX, "proj-"))
})

afterAll(() => {
  if (ORIGINAL_TEST_HOME === undefined) delete process.env.OPENCODE_TEST_HOME
  else process.env.OPENCODE_TEST_HOME = ORIGINAL_TEST_HOME
  rmSync(SANDBOX, { recursive: true, force: true })
})

describe("publishEligibility", () => {
  test("a skill the user wrote in the project is publishable", () => {
    const location = skill(path.join(project, ".opencode", "skills", "deploy"))
    expect(publishEligibility(location, project, project)).toBe("publishable")
  })

  test("an embedded built-in is not", () => {
    expect(publishEligibility("builtin:dbt-develop", project, project)).toBe("builtin")
  })

  test("a personal skill under the home directory is not the project's", () => {
    const location = skill(path.join(HOME, ".claude", "skills", "mine"))
    expect(publishEligibility(location, project, project)).toBe("personal")
  })

  test("a skill from the workspace snapshot is the workspace's", () => {
    const location = skill(path.join(project, ".altimate-code", "skill", "_workspace", "theirs"))
    expect(publishEligibility(location, project, project)).toBe("workspace")
  })

  test("a skill the IDE extension delivered is the workspace's", () => {
    const dir = path.join(project, ".claude", "skills", "altimate-theirs")
    const location = skill(dir)
    writeFileSync(path.join(dir, IDE_DELIVERED_MARKER), "{}")
    expect(publishEligibility(location, project, project)).toBe("workspace")
  })

  test("a skill outside the project boundary is refused", () => {
    const location = skill(path.join(SANDBOX, "elsewhere", "skills", "stray"))
    expect(publishEligibility(location, project, project)).toBe("outside-project")
  })

  test("the boundary is the worktree, so a skill at the repository root counts from a subdirectory", () => {
    const location = skill(path.join(project, ".opencode", "skills", "deploy"))
    const subdirectory = path.join(project, "models")
    mkdirSync(subdirectory, { recursive: true })
    expect(publishEligibility(location, subdirectory, projectRootFor(subdirectory, project))).toBe("publishable")
  })
})

describe("snapshots and built-ins, wherever they sit", () => {
  test("a workspace snapshot in a parent directory is still the workspace's", () => {
    // Discovery reads config directories up to the worktree, so a session in `repo/sub` also sees
    // `repo/.altimate-code/skill/_workspace`; the snapshot carries no marker by design.
    const location = skill(path.join(project, ".altimate-code", "skill", "_workspace", "theirs"))
    const subdirectory = path.join(project, "sub")
    mkdirSync(subdirectory, { recursive: true })
    expect(publishEligibility(location, subdirectory, project)).toBe("workspace")
  })

  test("the `<built-in>` placeholder location is a built-in", () => {
    expect(publishEligibility("<built-in>", project, project)).toBe("builtin")
  })
})

describe("isInWorkspaceSnapshot", () => {
  test("matches the snapshot by whole path segments only", () => {
    expect(isInWorkspaceSnapshot("/r/.altimate-code/skill/_workspace/x/SKILL.md")).toBe(true)
    expect(isInWorkspaceSnapshot("/r/sub/.altimate-code/skill/_workspace")).toBe(true)
    expect(isInWorkspaceSnapshot("/r/.altimate-code/skill/_workspace-notes/x")).toBe(false)
    expect(isInWorkspaceSnapshot("/r/.altimate-code/skills/_workspace/x")).toBe(false)
    expect(isInWorkspaceSnapshot("/r/.opencode/skills/x")).toBe(false)
  })
})

describe("snapshotCopyYields", () => {
  const root = "/work/repo"
  const snapshot = "/work/repo/.altimate-code/skill/_workspace/pub-1/SKILL.md"
  test("the workspace copy yields to the user's own skill in the project", () => {
    expect(snapshotCopyYields(snapshot, "/work/repo/.claude/skills/mine/SKILL.md", root)).toBe(true)
    expect(snapshotCopyYields(snapshot, "/work/repo/.opencode/skills/mine/SKILL.md", root)).toBe(true)
  })

  test("but still overrides built-in, personal and other snapshot entries, as before", () => {
    expect(snapshotCopyYields(snapshot, "builtin:dbt-develop/SKILL.md", root)).toBe(false)
    expect(snapshotCopyYields(snapshot, "<built-in>", root)).toBe(false)
    expect(snapshotCopyYields(snapshot, "/home/me/.claude/skills/mine/SKILL.md", root)).toBe(false)
    expect(snapshotCopyYields(snapshot, "/work/repo/.altimate-code/skill/_workspace/pub-2/SKILL.md", root)).toBe(false)
  })

  test("a location that is not a string (an inherited property, say) never yields", () => {
    expect(snapshotCopyYields(snapshot, undefined, root)).toBe(false)
    expect(snapshotCopyYields(snapshot, Object.prototype.constructor, root)).toBe(false)
  })

  test("only a snapshot entry ever yields, and only with a project to judge against", () => {
    expect(snapshotCopyYields("/work/repo/.claude/skills/x/SKILL.md", "/work/repo/.opencode/skills/x/SKILL.md", root)).toBe(false)
    expect(snapshotCopyYields(snapshot, "/work/repo/.claude/skills/mine/SKILL.md", undefined)).toBe(false)
  })
})

describe("projectRootFor", () => {
  test("a project with no git uses its directory, never the filesystem root", () => {
    expect(projectRootFor("/work/proj", "/")).toBe("/work/proj")
    expect(projectRootFor("/work/proj/models", "/work/proj")).toBe("/work/proj")
  })
})

describe("explainIneligible", () => {
  test("says nothing for a publishable skill and why for the rest", () => {
    expect(explainIneligible("deploy", "/p/.opencode/skills/deploy/SKILL.md", "publishable")).toBeNull()
    expect(explainIneligible("dbt-develop", "builtin:dbt-develop", "builtin")).toContain("built-in")
    expect(explainIneligible("mine", "/h/.claude/skills/mine/SKILL.md", "personal")).toContain("personal skill")
    expect(explainIneligible("theirs", "/p/x/SKILL.md", "workspace")).toContain("this workspace sent to you")
    expect(explainIneligible("stray", "/e/stray/SKILL.md", "outside-project")).toContain("not inside this project")
  })
})
