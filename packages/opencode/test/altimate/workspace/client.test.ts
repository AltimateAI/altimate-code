import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as State from "../../../src/altimate/workspace/state"
import * as Skills from "../../../src/altimate/workspace/skill-sync"
import * as Contents from "../../../src/altimate/workspace/contents"
import * as Sync from "../../../src/altimate/workspace/memory-sync"
import { MemoryStore } from "../../../src/memory/store"
import * as Client from "../../../src/altimate/workspace/client"
import { Instance } from "../../../src/project/instance"
import { WorkspaceApi } from "../../../src/altimate/workspace/api-client"
import { AltimateApi } from "../../../src/altimate/api/client"
import { currentCredentials } from "../../../src/altimate/api/credentials-context"

const cleanups: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
function replace<T extends object, K extends keyof T>(object: T, key: K, value: T[K]) {
  const spy = spyOn(object, key as never).mockImplementation(value as never)
  cleanups.push(() => spy.mockRestore())
}
function scope() {
  let account: string | null = "account-A"
  let id = 35
  let stale = false
  replace(AltimateApi, "getCredentials", async () => {
    const scoped = currentCredentials()
    if (scoped) return scoped
    if (!account) throw new Error("Sign in first")
    return { altimateUrl: "https://test.invalid", altimateInstanceName: "test", altimateApiKey: account }
  })
  replace(State, "resolveBindingOutcome", async () => ({
    status: "bound",
    ...(stale ? { stale: true as const } : {}),
    binding: {
      datamateId: id,
      datamateName: "Growth",
      repoRemote: null,
      projectPath: "/project",
      linkedAt: 0,
    },
  }))
  replace(Skills, "isEnabled", () => true)
  return {
    account: (value: string | null) => {
      account = value
    },
    id: (value: number) => {
      id = value
    },
    stale: () => {
      stale = true
    },
  }
}

describe("external workspace identity", () => {
  test("receipt binds account, workspace and project; stale or unsigned identities are refused", async () => {
    const f = scope()
    const first = await Client.identity("/project")
    expect((await Client.identity("/elsewhere")).token).not.toBe(first.token)
    f.account("account-B")
    await expect(Client.assertIdentity("/project", first.token)).rejects.toThrow("changed")
    f.account("account-A")
    f.id(36)
    await expect(Client.assertIdentity("/project", first.token)).rejects.toThrow("changed")
    f.stale()
    await expect(Client.identity("/project")).rejects.toThrow("could not be confirmed")
    f.account(null)
    await expect(Client.identity("/project")).rejects.toThrow("Sign in")
  })
})

test("context contains bounded project memories, excludes global memory and refuses an account change during hydration", async () => {
  const f = scope()
  replace(Contents, "workspaceContents", async () => ({
    skills: [],
    integrations: [],
    memoryEnabled: true,
    knowledge: { kind: "off" },
  }))
  replace(Skills, "snapshotWorkspaceId", async () => null)
  replace(Sync, "readOnly", async () => ({
    status: "loaded",
    blocks: Array.from({ length: 20 }, (_, index) => ({
      id: `id-${index}`,
      remote: true as const,
      scope: index === 0 ? "global" : "project",
      content: "x".repeat(2048),
      tags: [],
      created: "2026-10-22T00:00:00Z",
      updated: "2026-10-22T00:00:00Z",
    })),
  }))
  const result = await Client.context("/project")
  expect(result.memory.memories.map((block) => block.id)).not.toContain("id-0")
  expect(result.memory.memories.reduce((n, block) => n + block.content.length, 0)).toBe(6000)
  expect(result.memory.clipped).toBe(true)
  replace(Sync, "readOnly", async () => {
    f.account("account-B")
    return { blocks: [], status: "loaded" }
  })
  await expect(Client.context("/project")).rejects.toThrow("changed")
})

test("named skill reader uses the current account snapshot and refuses traversal, symlinks and oversized files", async () => {
  scope()
  const directory = await mkdtemp(path.join(os.tmpdir(), "workspace-client-"))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const root = path.join(directory, "snapshot")
  await mkdir(path.join(root, "revenue"), { recursive: true })
  await writeFile(path.join(root, "revenue", "SKILL.md"), "# Revenue\nUse booked ARR.")
  replace(Skills, "snapshotWorkspaceId", async () => 35)
  replace(Skills, "snapshotRoot", () => root)
  const { token } = await Client.identity(directory)
  expect(await Client.readSkill(directory, "revenue", token)).toContain("booked ARR")
  await expect(Client.readSkill(directory, "../private", token)).rejects.toThrow("skill name")
  await symlink(path.join(root, "revenue"), path.join(root, "linked"))
  await expect(Client.readSkill(directory, "linked", token)).rejects.toThrow("symlink")
  await writeFile(path.join(root, "revenue", "SKILL.md"), "x".repeat(32001))
  await expect(Client.readSkill(directory, "revenue", token)).rejects.toThrow("too large")
  replace(Skills, "snapshotWorkspaceId", async () => 99)
  await expect(Client.readSkill(directory, "revenue", token)).rejects.toThrow("not current")
})

test("explicit save validates receipt and content, writes one project block and reports uncertain cloud writes", async () => {
  const f = scope()
  const writes: unknown[] = []
  replace(Sync, "isEnabled", () => true)
  replace(Sync, "memoryEnabledForPoller", async () => "enabled")
  replace(MemoryStore, "read", async () => undefined)
  replace(MemoryStore, "write", async (...args) => {
    writes.push(args)
    return { duplicates: [] }
  })
  replace(Sync, "backfill", async () => ({ ok: 1, failed: 0, skipped: 0, declined: 0, deferred: 0, gated: false }))
  const { token } = await Client.identity("/project")
  expect((await Client.remember("/project", token, "metrics/arr", "Use booked ARR.")).cloudConfirmed).toBe(true)
  expect(writes.length).toBe(1)
  expect(writes[0]).toMatchObject([
    { scope: "project", id: "metrics/arr", content: "Use booked ARR." },
    { mirror: false, cleanup: false },
  ])
  replace(Sync, "backfill", async () => {
    throw new Error("offline")
  })
  const result = await Client.remember("/project", token, "metrics/arr", "Use booked ARR.")
  expect(result.savedLocally).toBe(true)
  expect(result.cloudConfirmed).toBe(false)
  expect(result.message).toContain("not be confirmed")
  const count = writes.length
  await expect(Client.remember("/project", token, "../bad", "text")).rejects.toThrow()
  await expect(Client.remember("/project", token, "good", "x".repeat(2049))).rejects.toThrow("2048")
  f.account("account-B")
  await expect(Client.remember("/project", token, "good", "text")).rejects.toThrow("changed")
  expect(writes.length).toBe(count)
})

test("account change after local persistence cannot retarget the approved publication", async () => {
  const f = scope()
  replace(Sync, "isEnabled", () => true)
  replace(Sync, "memoryEnabledForPoller", async () => "enabled")
  replace(MemoryStore, "read", async () => undefined)
  replace(MemoryStore, "write", async () => {
    f.account("account-B")
    return { duplicates: [] }
  })
  let sentAs: string | undefined
  replace(Sync, "backfill", async () => {
    sentAs = (await AltimateApi.getCredentials()).altimateApiKey
    return { ok: 1, failed: 0, skipped: 0, declined: 0, deferred: 0, gated: false }
  })
  const { token } = await Client.identity("/project")
  expect((await Client.remember("/project", token, "good", "text")).cloudConfirmed).toBe(true)
  expect(sentAs).toBe("account-A")
  expect((await AltimateApi.getCredentials()).altimateApiKey).toBe("account-B")
})

test("single-block save suppresses unrelated expired-file cleanup in the real store", async () => {
  scope()
  const directory = await mkdtemp(path.join(os.tmpdir(), "workspace-save-cleanup-"))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const root = path.join(directory, ".altimate-code", "memory")
  await mkdir(root, { recursive: true })
  for (let i = 0; i < 50; i++) {
    await writeFile(
      path.join(root, `expired-${i}.md`),
      `---\nid: expired-${i}\nscope: project\ncreated: 2020-01-01T00:00:00Z\nupdated: 2020-01-01T00:00:00Z\nexpires: 2020-01-02T00:00:00Z\n---\n\nOld fact.\n`,
    )
  }
  await Instance.provide({
    directory,
    fn: async () => {
      const block = {
        id: "fresh",
        scope: "project" as const,
        content: "New fact.",
        tags: [],
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
      }
      await MemoryStore.write(block, { mirror: false, cleanup: false })
      expect((await MemoryStore.list("project", { includeExpired: true })).length).toBe(51)
      await MemoryStore.write({ ...block, id: "control" }, { mirror: false })
      expect((await MemoryStore.list("project", { includeExpired: true })).map((b) => b.id).sort()).toEqual([
        "control",
        "fresh",
      ])
    },
  })
})

test("workspace listing pins one credential snapshot across account changes", async () => {
  const f = scope()
  replace(WorkspaceApi, "listDatamates", async (credentials) => {
    f.account("account-B")
    expect((await AltimateApi.getCredentials()).altimateApiKey).toBe("account-A")
    f.account("account-A")
    return []
  })
  expect(await Client.listWorkspaces()).toEqual([])
})
