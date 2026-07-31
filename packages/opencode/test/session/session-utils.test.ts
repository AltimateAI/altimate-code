import { describe, test, expect } from "bun:test"
import { Session } from "../../src/session"

describe("Session.isDefaultTitle", () => {
  test("recognises parent session titles", () => {
    expect(Session.isDefaultTitle("New session - 2024-01-15T08:30:00.000Z")).toBe(true)
  })

  test("recognises child session titles", () => {
    expect(Session.isDefaultTitle("Child session - 2024-06-01T23:59:59.999Z")).toBe(true)
  })

  test("rejects arbitrary strings", () => {
    expect(Session.isDefaultTitle("My custom title")).toBe(false)
    expect(Session.isDefaultTitle("")).toBe(false)
    expect(Session.isDefaultTitle("hello world")).toBe(false)
  })

  test("rejects prefix without valid ISO timestamp", () => {
    expect(Session.isDefaultTitle("New session - not-a-date")).toBe(false)
    expect(Session.isDefaultTitle("New session - ")).toBe(false)
    expect(Session.isDefaultTitle("New session - 2024-01-15")).toBe(false)
  })

  test("rejects partial prefix matches", () => {
    expect(Session.isDefaultTitle("New session 2024-01-15T08:30:00.000Z")).toBe(false)
    expect(Session.isDefaultTitle("New session -2024-01-15T08:30:00.000Z")).toBe(false)
  })

  test("rejects titles with extra content after timestamp", () => {
    expect(Session.isDefaultTitle("New session - 2024-01-15T08:30:00.000Z extra")).toBe(false)
  })
})

describe("Session.fromRow / toRow", () => {
  test("roundtrip preserves fields with full summary", () => {
    const info: Session.Info = {
      id: "sess_123" as any,
      slug: "abc-def",
      projectID: "proj_456" as any,
      workspaceID: "ws_789" as any,
      directory: "/home/user/project",
      parentID: "sess_parent" as any,
      title: "Test session",
      version: "0.5.13",
      summary: {
        additions: 10,
        deletions: 5,
        files: 3,
        diffs: [{ file: "src/index.ts", additions: 10, deletions: 5 }] as any,
      },
      share: { url: "https://example.com/share/123" },
      revert: { messageID: "msg_abc" as any, snapshot: "snapshot_abc" },
      permission: "plan" as any,
      time: {
        created: 1700000000000,
        updated: 1700001000000,
        compacting: 1700002000000,
        archived: 1700003000000,
      },
    }

    const row = Session.toRow(info)
    const restored = Session.fromRow(row as any)

    expect(restored.id).toBe(info.id)
    expect(restored.slug).toBe(info.slug)
    expect(restored.projectID).toBe(info.projectID)
    expect(restored.workspaceID).toBe(info.workspaceID)
    expect(restored.directory).toBe(info.directory)
    expect(restored.parentID).toBe(info.parentID)
    expect(restored.title).toBe(info.title)
    expect(restored.version).toBe(info.version)
    expect(restored.summary).toEqual(info.summary)
    expect(restored.share).toEqual(info.share)
    expect(restored.revert).toEqual(info.revert)
    expect(restored.permission).toBe(info.permission)
    expect(restored.time.created).toBe(info.time.created)
    expect(restored.time.updated).toBe(info.time.updated)
    expect(restored.time.compacting).toBe(info.time.compacting)
    expect(restored.time.archived).toBe(info.time.archived)
  })

  test("fromRow produces undefined summary when all summary columns are null", () => {
    const row = {
      id: "sess_1",
      slug: "x",
      project_id: "p1",
      workspace_id: null,
      directory: "/tmp",
      parent_id: null,
      title: "t",
      version: "1",
      summary_additions: null,
      summary_deletions: null,
      summary_files: null,
      summary_diffs: null,
      share_url: null,
      revert: null,
      permission: null,
      time_created: 1,
      time_updated: 2,
      time_compacting: null,
      time_archived: null,
    }
    const info = Session.fromRow(row as any)
    expect(info.summary).toBeUndefined()
    expect(info.share).toBeUndefined()
    expect(info.revert).toBeUndefined()
    expect(info.parentID).toBeUndefined()
    expect(info.workspaceID).toBeUndefined()
    expect(info.time.compacting).toBeUndefined()
    expect(info.time.archived).toBeUndefined()
  })

  test("fromRow constructs summary when at least one summary column is non-null", () => {
    const row = {
      id: "sess_2",
      slug: "y",
      project_id: "p2",
      workspace_id: null,
      directory: "/tmp",
      parent_id: null,
      title: "t",
      version: "1",
      summary_additions: 5,
      summary_deletions: null,
      summary_files: null,
      summary_diffs: null,
      share_url: null,
      revert: null,
      permission: null,
      time_created: 1,
      time_updated: 2,
      time_compacting: null,
      time_archived: null,
    }
    const info = Session.fromRow(row as any)
    expect(info.summary).toBeDefined()
    expect(info.summary!.additions).toBe(5)
    expect(info.summary!.deletions).toBe(0)
    expect(info.summary!.files).toBe(0)
  })
})
