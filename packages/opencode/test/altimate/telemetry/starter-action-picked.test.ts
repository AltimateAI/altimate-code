// altimate_change - new file
//
// `starter_action_picked`: one row per selection from a TUI starter dialog, naming the action, the
// prompt's position for a prompt, and the starter's own workspace; never the prompt's text.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import * as Contents from "../../../src/altimate/workspace/contents"
import type { WorkspaceContents } from "../../../src/altimate/workspace/contents"
import { starterFor } from "../../../src/altimate/workspace/starter"
import {
  starterActionPickedEvent,
  starterPick,
  trackStarterActionPicked,
} from "../../../src/altimate/workspace/starter-telemetry"
import { Telemetry } from "../../../src/altimate/telemetry"

const contents: WorkspaceContents = {
  skills: [{ name: "incident-runbook", description: "" }],
  integrations: [],
  memoryEnabled: true,
  knowledge: { kind: "off" },
}

let events: any[]
let trackSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  events = []
  trackSpy = spyOn(Telemetry, "track").mockImplementation((e) => {
    events.push(e)
  })
})

afterEach(() => {
  trackSpy.mockRestore()
})

describe("starterPick", () => {
  test.each([
    ["prompt:0", { action: "prompt", promptIndex: 0 }],
    ["prompt:2", { action: "prompt", promptIndex: 2 }],
    ["open", { action: "open" }],
    ["done", { action: "done" }],
  ] as const)("%s is a starter action", (value, pick) => {
    expect(starterPick(value)).toEqual(pick)
  })

  test.each(["", "prompt:", "prompt:-1", "prompt:1.5", "prompt:x", "status", "Done", " done"])(
    "%p is not a starter action",
    (value) => {
      expect(starterPick(value)).toBeNull()
    },
  )
})

describe("starter_action_picked row", () => {
  test("a prompt carries its index and the workspace, and no text", () => {
    const row = starterActionPickedEvent(7, { action: "prompt", promptIndex: 1 }, "ses_1") as Record<string, unknown>
    expect(Object.keys(row).sort()).toEqual(
      ["action", "prompt_index", "session_id", "timestamp", "type", "workspace_id"].sort(),
    )
    expect(row).toEqual(
      expect.objectContaining({
        type: "starter_action_picked",
        session_id: "ses_1",
        workspace_id: 7,
        action: "prompt",
        prompt_index: 1,
      }),
    )
  })

  test.each(["open", "done"] as const)("%s carries no prompt_index", (action) => {
    const row = starterActionPickedEvent(7, { action }, "ses_1") as Record<string, unknown>
    expect(row.action).toBe(action)
    expect("prompt_index" in row).toBe(false)
  })

  test("falls back to the process context's session", () => {
    const row = starterActionPickedEvent(7, { action: "done" })
    expect(row.session_id).toBe(Telemetry.getContext().sessionId)
  })
})

describe("trackStarterActionPicked", () => {
  test("tracks exactly one row per selection, against the starter's workspace", () => {
    expect(trackStarterActionPicked({ workspaceId: 9 }, "prompt:2")).toBe(true)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(
      expect.objectContaining({ type: "starter_action_picked", workspace_id: 9, action: "prompt", prompt_index: 2 }),
    )
    expect(JSON.stringify(events[0])).not.toContain("Which")
  })

  test("nothing before the starter arrives: the dialog is then the bare link confirmation", () => {
    expect(trackStarterActionPicked(null, "done")).toBe(false)
    expect(trackStarterActionPicked(null, "open")).toBe(false)
    expect(events).toEqual([])
  })

  test("nothing for a value that is not a starter action", () => {
    expect(trackStarterActionPicked({ workspaceId: 9 }, "status")).toBe(false)
    expect(events).toEqual([])
  })

  test.each([undefined, 0, -3, 1.5, Number.NaN])("nothing for workspace id %p", (workspaceId) => {
    expect(trackStarterActionPicked({ workspaceId }, "done")).toBe(false)
    expect(events).toEqual([])
  })

  test("never throws when telemetry does", () => {
    trackSpy.mockImplementation(() => {
      throw new Error("boom")
    })
    expect(trackStarterActionPicked({ workspaceId: 9 }, "done")).toBe(false)
  })
})

describe("starterFor names its workspace", () => {
  test("the served starter carries the id its starter_shown row reported", async () => {
    const contentsSpy = spyOn(Contents, "workspaceContents").mockResolvedValue(contents)
    try {
      const starter = await starterFor("/tmp/project", { datamateId: 31, datamateName: "analytics" })
      expect(starter.workspaceId).toBe(31)
      const shown = events.find((e) => e.type === "starter_shown")
      expect(shown?.workspace_id).toBe(starter.workspaceId)
      events.length = 0
      trackStarterActionPicked(starter, "prompt:0")
      expect(events[0].workspace_id).toBe(shown.workspace_id)
    } finally {
      contentsSpy.mockRestore()
    }
  })
})
