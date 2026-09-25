// altimate_change - new file
//
// `/altimate/skill/{publishable,publish}`: the CLI's `skill publish` for the IDE extension. These
// cover the ROUTES — gating, input validation, which skills are offered, status mapping — with the
// skill registry and the publish engine stubbed; eligibility runs for real (publishable.test.ts)
// and the engine is covered by test/altimate/workspace/skill-publish.test.ts.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Server } from "../../src/server/server"
import * as SkillRegistry from "../../src/skill"
import * as SkillPublish from "../../src/altimate/workspace/skill-publish"
import { resetDatabase } from "./db"
import { disposeAllInstances } from "../fixture/fixture"

const ORIGINAL_FLAG = process.env.ALTIMATE_WORKSPACE
let spies: Array<{ mockRestore: () => void }> = []

// The instance directory in these tests is the process's cwd (no directory header).
const OWN = path.join(process.cwd(), ".opencode", "skills", "deploy", "SKILL.md")
const SKILLS = [
  { name: "deploy", description: "Deploy things", location: OWN, content: "" },
  { name: "dbt-develop", description: "Built in", location: "builtin:dbt-develop", content: "" },
  // `description` is optional in frontmatter.
  {
    name: "Bare",
    location: path.join(process.cwd(), ".opencode", "skills", "bare", "SKILL.md"),
    content: "",
  },
]

function request(method: "GET" | "POST", url: string, body?: unknown, headers: Record<string, string> = {}) {
  return Server.Default().request(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  })
}

// The reload before each lookup runs for real; only what the registry then answers is stubbed.
function stubSkills(skills = SKILLS) {
  spies.push(spyOn(SkillRegistry, "all").mockResolvedValue(skills as never))
  spies.push(
    spyOn(SkillRegistry, "get").mockImplementation(async (name: string) => skills.find((s) => s.name === name) as never),
  )
}

const REPORT = { action: "created" as const, publicId: "pub-1", name: "deploy", files: 2, bytes: 2048, datamateId: 42 }

beforeEach(() => {
  process.env.ALTIMATE_WORKSPACE = "1"
})

afterEach(async () => {
  for (const spy of spies) spy.mockRestore()
  spies = []
  if (ORIGINAL_FLAG === undefined) delete process.env.ALTIMATE_WORKSPACE
  else process.env.ALTIMATE_WORKSPACE = ORIGINAL_FLAG
  await disposeAllInstances()
  await resetDatabase()
})

describe("GET /altimate/skill/publishable", () => {
  test("lists only the skills that can be published", async () => {
    stubSkills()
    const response = await request("GET", "/altimate/skill/publishable")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      skills: [
        { name: "Bare", description: "", location: path.join(process.cwd(), ".opencode", "skills", "bare", "SKILL.md") },
        { name: "deploy", description: "Deploy things", location: OWN },
      ],
    })
  })

  test("is refused outside the workspace pilot", async () => {
    delete process.env.ALTIMATE_WORKSPACE
    stubSkills()
    expect((await request("GET", "/altimate/skill/publishable")).status).toBe(409)
  })

  test("refuses a browser origin on an unsecured server", async () => {
    stubSkills()
    expect((await request("GET", "/altimate/skill/publishable", undefined, { origin: "https://evil.test" })).status).toBe(403)
  })

  test("refuses a browser's Origin-less cross-site request, such as an image GET", async () => {
    // A cross-site GET reloads config and re-pulls skill URLs, so it must not run at all.
    stubSkills()
    const refused = await request("GET", "/altimate/skill/publishable", undefined, { "sec-fetch-site": "cross-site" })
    expect(refused.status).toBe(403)
    expect((await request("GET", "/altimate/skill/publishable", undefined, { "sec-fetch-site": "same-site" })).status).toBe(403)
    expect((await request("GET", "/altimate/skill/publishable", undefined, { "sec-fetch-site": "none" })).status).toBe(200)
  })
})

describe("POST /altimate/skill/publish", () => {
  test("publishes a project skill and returns the report with the CLI's wording", async () => {
    stubSkills()
    const publish = spyOn(SkillPublish, "publishSkill").mockResolvedValue(REPORT)
    spies.push(publish)

    const response = await request("POST", "/altimate/skill/publish", { name: "deploy" })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      report: REPORT,
      message: 'Published "deploy" in the workspace (2 files, 2KB).',
    })
    const input = publish.mock.calls[0][0]
    expect(input.skillDirectory).toBe(path.dirname(OWN))
    expect(input.name).toBe("deploy")
    expect(input.description).toBe("Deploy things")
  })

  test("refuses a built-in before calling the engine", async () => {
    stubSkills()
    const publish = spyOn(SkillPublish, "publishSkill")
    spies.push(publish)

    const response = await request("POST", "/altimate/skill/publish", { name: "dbt-develop" })
    expect(response.status).toBe(422)
    expect(((await response.json()) as { error: string }).error).toContain("built-in")
    expect(publish).not.toHaveBeenCalled()
  })

  test("answers 404 for a skill the project cannot reach, suggesting a same-name skill in another case", async () => {
    stubSkills()
    expect((await request("POST", "/altimate/skill/publish", { name: "nope" })).status).toBe(404)
    const response = await request("POST", "/altimate/skill/publish", { name: "DEPLOY" })
    expect(response.status).toBe(404)
    expect(((await response.json()) as { error: string }).error).toContain('Did you mean "deploy"?')
  })

  test("reports the engine's own refusals as 422 with their message", async () => {
    stubSkills()
    const refusal = new SkillPublish.NotLinkedError()
    spies.push(spyOn(SkillPublish, "publishSkill").mockRejectedValue(refusal))

    const response = await request("POST", "/altimate/skill/publish", { name: "deploy" })
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ ok: false, error: refusal.message })
  })

  test("reports a backend conflict the engine did not classify as a 422 with the server's detail", async () => {
    stubSkills()
    const { ConflictError } = await import("../../src/altimate/workspace/api-client")
    spies.push(
      spyOn(SkillPublish, "publishSkill").mockRejectedValue(new ConflictError({ message: "Bundle is locked." } as never)),
    )

    const response = await request("POST", "/altimate/skill/publish", { name: "deploy" })
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ ok: false, error: "Bundle is locked." })
  })

  test("reports anything else as a 500 with its message", async () => {
    stubSkills()
    spies.push(spyOn(SkillPublish, "publishSkill").mockRejectedValue(new Error("boom")))

    const response = await request("POST", "/altimate/skill/publish", { name: "deploy" })
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ ok: false, error: "boom" })
  })

  test("rejects a missing, empty or non-string name, and a malformed body", async () => {
    stubSkills()
    const publish = spyOn(SkillPublish, "publishSkill")
    spies.push(publish)

    expect((await request("POST", "/altimate/skill/publish", {})).status).toBe(400)
    expect((await request("POST", "/altimate/skill/publish", { name: "  " })).status).toBe(400)
    expect((await request("POST", "/altimate/skill/publish", { name: 7 })).status).toBe(400)
    expect((await request("POST", "/altimate/skill/publish", "{bad")).status).toBe(400)
    expect(publish).not.toHaveBeenCalled()
  })

  test("is refused outside the workspace pilot and from a browser origin", async () => {
    stubSkills()
    const publish = spyOn(SkillPublish, "publishSkill")
    spies.push(publish)

    expect((await request("POST", "/altimate/skill/publish", { name: "deploy" }, { origin: "https://evil.test" })).status).toBe(403)
    delete process.env.ALTIMATE_WORKSPACE
    expect((await request("POST", "/altimate/skill/publish", { name: "deploy" })).status).toBe(409)
    expect(publish).not.toHaveBeenCalled()
  })
})

describe("the workspace's copy of your own skill", () => {
  test("does not hide the project skill it was published from", async () => {
    // Real registry. `.claude/skills` is scanned before the snapshot; before the precedence rule
    // the synced copy won, so the user's own skill vanished from the list and could not be updated.
    const project = mkdtempSync(path.join(os.tmpdir(), "altimate-shadow-route-"))
    try {
      const write = (dir: string) => {
        mkdirSync(dir, { recursive: true })
        writeFileSync(path.join(dir, "SKILL.md"), "---\nname: shared-skill\ndescription: d\n---\n\nbody\n")
      }
      write(path.join(project, ".claude", "skills", "shared-skill"))
      write(path.join(project, ".altimate-code", "skill", "_workspace", "pub-1"))
      const response = await request("GET", "/altimate/skill/publishable", undefined, { "x-opencode-directory": project })
      const skills = ((await response.json()) as { skills: { name: string; location: string }[] }).skills
      const shared = skills.find((s) => s.name === "shared-skill")
      expect(shared?.location).toContain(path.join(".claude", "skills", "shared-skill"))
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })
})

describe("a workspace skill named like an Object.prototype property", () => {
  test("loads without tripping the precedence check", async () => {
    // `state.skills` is a plain object; `constructor` must not resolve to the inherited one.
    const project = mkdtempSync(path.join(os.tmpdir(), "altimate-proto-route-"))
    try {
      const dir = path.join(project, ".altimate-code", "skill", "_workspace", "pub-1")
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, "SKILL.md"), "---\nname: constructor\ndescription: d\n---\n\nbody\n")
      const response = await request("GET", "/altimate/skill/publishable", undefined, { "x-opencode-directory": project })
      expect(response.status).toBe(200)
      // A workspace skill is never offered for publish.
      expect(((await response.json()) as { skills: { name: string }[] }).skills.map((s) => s.name)).not.toContain(
        "constructor",
      )
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })
})

describe("a skill written after the server loaded", () => {
  test("is listed, even when its skills directory did not exist at first", async () => {
    // Real registry: the case the in-context reload exists for. A project with no `.opencode/`
    // at all, then `altimate-code skill create` (or the chat) writes one.
    const project = mkdtempSync(path.join(os.tmpdir(), "altimate-publishable-route-"))
    try {
      const list = async () => {
        const response = await request("GET", "/altimate/skill/publishable", undefined, {
          "x-opencode-directory": project,
        })
        expect(response.status).toBe(200)
        return ((await response.json()) as { skills: { name: string }[] }).skills.map((s) => s.name)
      }
      expect(await list()).not.toContain("late-skill")
      const dir = path.join(project, ".opencode", "skills", "late-skill")
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, "SKILL.md"), "---\nname: late-skill\ndescription: Written late.\n---\n\nbody\n")
      expect(await list()).toContain("late-skill")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })
})
