import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { AltimateApi } from "../../../src/altimate/api/client"
import { recordApprovedBinding } from "../../../src/altimate/workspace/state"
import { ledgerPathForTests, publishSkill, SkillNameConflictError } from "../../../src/altimate/workspace/skill-publish"
import { tmpdir } from "../../fixture/fixture"

test("a failed replace leaves the ledger unchanged and the next publish still requires replace", async () => {
  await using dir = await tmpdir()
  const skillDirectory = path.join(dir.path, "skills", "team-playbook")
  await fs.mkdir(skillDirectory, { recursive: true })
  await fs.writeFile(path.join(skillDirectory, "SKILL.md"), "---\nname: team-playbook\n---\nRun the tests.\n")
  const configured = spyOn(AltimateApi, "isConfigured").mockResolvedValue(true)
  const credentials = spyOn(AltimateApi, "getCredentials").mockResolvedValue({
    altimateInstanceName: "publish-replace-test",
    altimateUrl: "https://api.example.com",
    altimateApiKey: "test-key",
  })
  const writes: string[] = []
  let patchStatus = 500
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url)
    const method = init?.method ?? "GET"
    if (url.pathname.endsWith("/users/me")) return Response.json({ id: 7 })
    if (url.pathname.endsWith("/datamates/"))
      return Response.json({ datamates: [{ id: 42, name: "Growth", user_id: 7, memory_enabled: false }] })
    if (method === "GET" && url.pathname.endsWith("/skills"))
      return Response.json({ items: [{ name: "team-playbook", public_id: "remote-skill", created_by: 7 }], pages: 1 })
    if (method === "GET") return Response.json({ skill: { attached_datamate_ids: [42] } })
    writes.push(method)
    if (method === "POST") return Response.json({ detail: "Name already exists" }, { status: 409 })
    if (method === "PATCH") return Response.json({ detail: "Patch failed" }, { status: patchStatus })
    throw new Error(`Unexpected request: ${method} ${url}`)
  }) as typeof globalThis.fetch)
  try {
    await recordApprovedBinding(
      dir.path,
      { datamateId: 42, datamateName: "Growth", repoRemote: null, projectPath: dir.path, linkedAt: Date.now() },
      { awaitBackfill: true, seed: false },
    )
    writes.length = 0
    const before = await fs.readFile(ledgerPathForTests(), "utf8").catch(() => undefined)
    const input = { projectDirectory: dir.path, skillDirectory, name: "team-playbook", description: "Team lessons" }

    await expect(publishSkill({ ...input, replace: true })).rejects.toThrow("Patch failed")
    expect(writes).toEqual(["POST", "PATCH"])
    const after = await fs.readFile(ledgerPathForTests(), "utf8").catch(() => undefined)
    patchStatus = 200
    writes.length = 0
    const retry = await publishSkill(input).catch((error) => error)

    expect(after).toBe(before)
    expect(retry).toBeInstanceOf(SkillNameConflictError)
    expect(writes).toEqual(["POST"])

    const replaced = await publishSkill({ ...input, replace: true })
    expect(replaced).toMatchObject({ action: "updated", publicId: "remote-skill" })
    writes.length = 0
    expect(await publishSkill(input)).toMatchObject({ action: "updated", publicId: "remote-skill" })
    expect(writes).toEqual(["PATCH"])
  } finally {
    fetch.mockRestore()
    credentials.mockRestore()
    configured.mockRestore()
  }
})

test("replace refuses a same-name skill attached only to another workspace", async () => {
  await using dir = await tmpdir()
  const skillDirectory = path.join(dir.path, "skills", "team-playbook")
  await fs.mkdir(skillDirectory, { recursive: true })
  await fs.writeFile(path.join(skillDirectory, "SKILL.md"), "---\nname: team-playbook\n---\nRun the tests.\n")
  const configured = spyOn(AltimateApi, "isConfigured").mockResolvedValue(true)
  const credentials = spyOn(AltimateApi, "getCredentials").mockResolvedValue({
    altimateInstanceName: "publish-workspace-test",
    altimateUrl: "https://api.example.com",
    altimateApiKey: "test-key",
  })
  const writes: string[] = []
  const lookups: Array<string | null> = []
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url)
    const method = init?.method ?? "GET"
    if (url.pathname.endsWith("/users/me")) return Response.json({ id: 7 })
    if (url.pathname.endsWith("/datamates/"))
      return Response.json({ datamates: [{ id: 42, name: "Growth", user_id: 7, memory_enabled: false }] })
    if (method === "GET" && url.pathname.endsWith("/skills")) {
      const workspace = url.searchParams.get("datamate_id")
      lookups.push(workspace)
      return Response.json({
        items: workspace === "42" ? [] : [{ name: "team-playbook", public_id: "other-workspace", created_by: 7 }],
        pages: 1,
      })
    }
    if (method === "GET") return Response.json({ skill: { attached_datamate_ids: [77] } })
    writes.push(method)
    if (method === "POST") return Response.json({ detail: "Name already exists" }, { status: 409 })
    return Response.json({})
  }) as typeof globalThis.fetch)
  try {
    await recordApprovedBinding(
      dir.path,
      { datamateId: 42, datamateName: "Growth", repoRemote: null, projectPath: dir.path, linkedAt: Date.now() },
      { awaitBackfill: true, seed: false },
    )
    writes.length = 0
    const before = await fs.readFile(ledgerPathForTests(), "utf8").catch(() => undefined)
    await expect(publishSkill({
      projectDirectory: dir.path, skillDirectory, name: "team-playbook", description: "Team lessons", replace: true,
    })).rejects.toBeInstanceOf(SkillNameConflictError)
    expect(lookups).toEqual(["42"])
    expect(writes).toEqual(["POST"])
    expect(await fs.readFile(ledgerPathForTests(), "utf8").catch(() => undefined)).toBe(before)
  } finally {
    fetch.mockRestore()
    credentials.mockRestore()
    configured.mockRestore()
  }
})
