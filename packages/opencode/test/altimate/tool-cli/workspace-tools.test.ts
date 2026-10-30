import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import * as State from "../../../src/altimate/workspace/state"
import * as WorkspaceClient from "../../../src/altimate/workspace/client"
import * as SkillSync from "../../../src/altimate/workspace/skill-sync"
import {
  projectIsLinked,
  resolveWorkspaceTools,
  skillDescription,
  workspaceContextSection,
} from "../../../src/altimate/tool-cli/workspace-tools"
import { socketName } from "../../../src/altimate/tool-cli/daemon"

const binding = { datamateId: 7, datamateName: "Growth", repoRemote: null, projectPath: "/project", linkedAt: 0 }
const mocks: { mockRestore(): void }[] = []
afterEach(() => {
  while (mocks.length) mocks.pop()!.mockRestore()
})

describe("workspace tools default", () => {
  test("on when the project has a saved link, without asking the service", async () => {
    const outcome = spyOn(State, "resolveBindingOutcome").mockRejectedValue(new Error("must not be called"))
    mocks.push(outcome, spyOn(State, "readLocalBinding").mockResolvedValue(binding))
    expect(await projectIsLinked("/project")).toBe(true)
    expect(await resolveWorkspaceTools(undefined, "/project")).toBe(true)
    expect(outcome).not.toHaveBeenCalled()
  })

  test("off, without an error, when unlinked or the link cannot be read", async () => {
    const local = spyOn(State, "readLocalBinding")
    mocks.push(local)
    local.mockResolvedValue(null)
    expect(await resolveWorkspaceTools(undefined, "/project")).toBe(false)
    local.mockRejectedValue(new Error("unreadable"))
    expect(await resolveWorkspaceTools(undefined, "/project")).toBe(false)
  })

  test("an explicit flag wins and the link is not consulted", async () => {
    const lookup = async () => {
      throw new Error("must not be called")
    }
    expect(await resolveWorkspaceTools(false, "/project", lookup)).toBe(false)
    expect(await resolveWorkspaceTools(true, "/project", lookup)).toBe(true)
  })

  test("the daemon identity follows the effective value", () => {
    expect(socketName("/project", "1.0.0", undefined, true)).not.toBe(socketName("/project", "1.0.0", undefined, false))
    expect(socketName("/project", "1.0.0", undefined, false)).toBe(socketName("/project", "1.0.0"))
  })
})

describe("workspace section of tool context", () => {
  test("skillDescription reads plain, quoted and folded descriptions", () => {
    expect(skillDescription("---\nname: a\ndescription: Plain text\n---\nbody")).toBe("Plain text")
    expect(skillDescription('---\ndescription: "Quoted: yes"\n---\n')).toBe("Quoted: yes")
    expect(skillDescription("---\ndescription: >-\n  first line\n  second line\nname: a\n---\n")).toBe("first line second line")
    expect(skillDescription("no frontmatter")).toBe("")
  })

  test("lists the workspace name, skills with descriptions and the workspace tools", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tool-ws-"))
    try {
      const root = path.join(dir, "snapshot")
      await mkdir(path.join(root, "id-1"), { recursive: true })
      await mkdir(path.join(root, "bare"), { recursive: true })
      await writeFile(path.join(root, "id-1", "SKILL.md"), "---\nname: dbt-style\ndescription: How we name dbt models\n---\nbody")
      await writeFile(path.join(root, "bare", "SKILL.md"), "no frontmatter")
      mocks.push(
        spyOn(SkillSync, "snapshotRoot").mockReturnValue(root),
        spyOn(WorkspaceClient, "context").mockResolvedValue({
          workspace: { id: 7, name: "Growth", token: "t" },
          summary: "",
          skills: ["id-1", "bare"],
          memory: { status: "loaded", memories: [], clipped: false },
        } as Awaited<ReturnType<typeof WorkspaceClient.context>>),
      )
      const section = (await workspaceContextSection(dir))!
      expect(section).toContain("Linked workspace: Growth")
      expect(section).toContain("- dbt-style (workspace_skill name: id-1): How we name dbt models")
      expect(section).toContain("- bare\n")
      for (const tool of ["workspace_context", "workspace_skill", "workspace_execute"]) expect(section).toContain(`- ${tool}: `)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("is absent when the workspace cannot be read", async () => {
    mocks.push(spyOn(WorkspaceClient, "context").mockRejectedValue(new Error("not linked")))
    expect(await workspaceContextSection("/project")).toBeUndefined()
  })
})
