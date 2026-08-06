/** @jsxImportSource @opentui/solid */
// altimate_change — in-process coverage for the YOLO auto-approve path.
//
// The real-binary journeys under packages/opencode/test/tui-journeys are the richer
// tests, but they are gated on OPENCODE_TEST_CLI + tmux and CI deliberately does not
// set them (see the note in .github/workflows/ci.yml). Everything in this file runs
// on every PR, so the security-relevant invariants actually gate the merge:
//
//   - an enabled session auto-approves; a disabled one does not
//   - a failed reply falls back to prompting instead of dropping the request
//   - subagents inherit via the root session
//   - an unresolvable session fails CLOSED
//   - a pre-session (pending) choice never leaks into other sessions
//   - enabling clears prompts that are already on screen
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount, wait } from "./sync-fixture"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"

// Pin the process-wide default. Flag.ALTIMATE_CLI_YOLO reads process.env at access time,
// so without this the suite inherits whatever the developer's shell exports — yolo is a
// common local default, and it silently inverts the expected starting state (every
// "should not auto-approve" case would auto-approve). CI leaves it unset, so this is
// also what keeps local and CI behaviour identical.
const FLAG = "ALTIMATE_CLI_YOLO"
let previousFlag: string | undefined

beforeEach(() => {
  previousFlag = process.env[FLAG]
  process.env[FLAG] = "false"
})

afterEach(() => {
  if (previousFlag === undefined) delete process.env[FLAG]
  else process.env[FLAG] = previousFlag
})

const ROOT = "ses_root"
const CHILD = "ses_child"
const OTHER = "ses_other"

function sessionRow(id: string, parentID?: string) {
  return {
    id,
    slug: id,
    projectID: "proj_test",
    directory: "/tmp/opencode/packages/tui",
    title: "t",
    version: "1",
    parentID,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  }
}

function askEvent(sessionID: string, id: string): GlobalEvent {
  return {
    directory: "/tmp/opencode/packages/tui",
    project: "proj_test",
    payload: {
      id: `evt_${id}`,
      type: "permission.asked",
      properties: {
        id,
        sessionID,
        permission: "bash",
        patterns: ["rm -rf *"],
        metadata: {},
        always: [],
      },
    },
  } as unknown as GlobalEvent
}

// The runtime path used by sdk.client.permission.reply. Note this differs from the
// entry in packages/sdk/js/src/gen/sdk.gen.ts — the TUI goes through a different client,
// so this was taken from an observed request rather than from the generated spec.
const REPLY = /^\/permission\/[^/]+\/reply$/

/** Mount with a known session list and a recorder for permission replies. */
async function setup(options?: { sessions?: ReturnType<typeof sessionRow>[]; failReply?: boolean }) {
  const replies: string[] = []
  const sessions = options?.sessions ?? [sessionRow(ROOT)]
  const tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const mounted = await mount((url) => {
    if (url.pathname === "/session") return json(sessions)
    if (REPLY.test(url.pathname)) {
      replies.push(url.pathname)
      if (options?.failReply) return json({ error: "boom" }, { status: 500 })
      return json({})
    }
    return undefined
  }, tmp.path)
  return { ...mounted, replies, tmp }
}

function pending(sync: Awaited<ReturnType<typeof setup>>["sync"], sessionID: string) {
  return sync.data.permission[sessionID] ?? []
}

describe("tui sync: yolo auto-approve", () => {
  test("auto-approves a permission request when yolo is on for the session", async () => {
    const { app, emit, sync, replies, tmp } = await setup()
    try {
      sync.yolo.set(ROOT, true)
      emit(askEvent(ROOT, "perm_1"))
      await wait(() => replies.length === 1)
      expect(pending(sync, ROOT)).toHaveLength(0)
    } finally {
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    }
  })

  test("does not auto-approve when yolo is off — the request is shown instead", async () => {
    const { app, emit, sync, replies, tmp } = await setup()
    try {
      emit(askEvent(ROOT, "perm_1"))
      await wait(() => pending(sync, ROOT).length === 1)
      expect(replies).toHaveLength(0)
    } finally {
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    }
  })

  // The silent-drop bug: the handler does not enqueue the request before replying, so a
  // lost reply leaves the server-side Deferred unresolved and the agent hanging with
  // nothing on screen. The generated SDK returns `{ error }` instead of throwing unless
  // `throwOnError` is set, so this also guards that opt-in.
  test("a failed auto-approve falls back to prompting instead of dropping the request", async () => {
    const { app, emit, sync, replies, tmp } = await setup({ failReply: true })
    try {
      sync.yolo.set(ROOT, true)
      emit(askEvent(ROOT, "perm_1"))
      await wait(() => replies.length === 1)
      await wait(() => pending(sync, ROOT).length === 1)
      expect(pending(sync, ROOT)[0]?.id).toBe("perm_1")
    } finally {
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    }
  })

  test("a subagent's request is auto-approved via its root session", async () => {
    const { app, emit, sync, replies, tmp } = await setup({
      sessions: [sessionRow(ROOT), sessionRow(CHILD, ROOT)],
    })
    try {
      sync.yolo.set(ROOT, true)
      emit(askEvent(CHILD, "perm_1"))
      await wait(() => replies.length === 1)
      expect(pending(sync, CHILD)).toHaveLength(0)
    } finally {
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    }
  })

  test("a request from an unknown session fails closed even with yolo on elsewhere", async () => {
    const { app, emit, sync, replies, tmp } = await setup()
    try {
      sync.yolo.set(ROOT, true)
      emit(askEvent("ses_ghost", "perm_1"))
      await wait(() => pending(sync, "ses_ghost").length === 1)
      expect(replies).toHaveLength(0)
    } finally {
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    }
  })

  // The critical finding: a welcome-screen choice must not auto-approve for a session
  // that is still running in the background. `session.new` navigates to home while the
  // previous session keeps streaming, so this is reachable through the normal flow.
  test("a pre-session choice does NOT auto-approve for an already-running session", async () => {
    const { app, emit, sync, replies, tmp } = await setup({
      sessions: [sessionRow(ROOT), sessionRow(OTHER)],
    })
    try {
      sync.yolo.set(undefined, true) // welcome screen: "yolo the session I'm about to start"
      expect(sync.yolo.enabled()).toBe(true) // shown as on for the welcome screen
      emit(askEvent(OTHER, "perm_1"))
      await wait(() => pending(sync, OTHER).length === 1)
      expect(replies).toHaveLength(0)
    } finally {
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    }
  })

  test("adopt binds a pending choice to one session and clears it", async () => {
    const { app, sync, tmp } = await setup({ sessions: [sessionRow(ROOT), sessionRow(OTHER)] })
    try {
      sync.yolo.set(undefined, true)
      sync.yolo.adopt(ROOT)
      expect(sync.yolo.enabled(ROOT)).toBe(true)
      // Cleared, so a later session (e.g. one resumed from the session list) is untouched.
      expect(sync.yolo.enabled(OTHER)).toBe(false)
      sync.yolo.adopt(OTHER)
      expect(sync.yolo.enabled(OTHER)).toBe(false)
    } finally {
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    }
  })

  test("enabling yolo clears a prompt that is already on screen", async () => {
    const { app, emit, sync, replies, tmp } = await setup()
    try {
      emit(askEvent(ROOT, "perm_1"))
      await wait(() => pending(sync, ROOT).length === 1)
      sync.yolo.set(ROOT, true)
      await wait(() => replies.length === 1)
    } finally {
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    }
  })

  test("deleting a session drops its yolo override", async () => {
    const { app, emit, sync, tmp } = await setup()
    try {
      sync.yolo.set(ROOT, true)
      expect(sync.yolo.enabled(ROOT)).toBe(true)
      emit({
        directory: "/tmp/opencode/packages/tui",
        project: "proj_test",
        payload: {
          id: "evt_del",
          type: "session.deleted",
          properties: { info: sessionRow(ROOT) },
        },
      } as unknown as GlobalEvent)
      await wait(() => sync.data.yolo[ROOT] === undefined)
    } finally {
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    }
  })
})

describe("tui sync: yolo under --yolo", () => {
  // beforeEach pins the flag off; these cases opt into a --yolo launch.
  async function withFlag(fn: () => Promise<void>) {
    process.env[FLAG] = "true"
    await fn()
  }

  test("an explicit off beats the --yolo default", async () => {
    await withFlag(async () => {
      const { app, emit, sync, replies, tmp } = await setup()
      try {
        sync.yolo.set(ROOT, false)
        emit(askEvent(ROOT, "perm_1"))
        await wait(() => pending(sync, ROOT).length === 1)
        expect(replies).toHaveLength(0)
      } finally {
        app.renderer.destroy()
        await tmp[Symbol.asyncDispose]()
      }
    })
  })

  // The fail-open bypass: under --yolo with the root explicitly turned OFF, a child
  // request arriving before the child session is hydrated must not resolve to itself
  // and inherit the true fallback.
  test("an unhydrated child does not inherit --yolo past an explicit parent off", async () => {
    await withFlag(async () => {
      // CHILD is deliberately absent from the session list.
      const { app, emit, sync, replies, tmp } = await setup({ sessions: [sessionRow(ROOT)] })
      try {
        sync.yolo.set(ROOT, false)
        emit(askEvent(CHILD, "perm_1"))
        await wait(() => pending(sync, CHILD).length === 1)
        expect(replies).toHaveLength(0)
      } finally {
        app.renderer.destroy()
        await tmp[Symbol.asyncDispose]()
      }
    })
  })
})
