// altimate_change - new file
import { describe, expect, test } from "bun:test"
import type { Event, Message } from "@opencode-ai/sdk/v2"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { LearnNudge, NUDGE_TOAST } from "../../../src/altimate/learn/nudge"
import { installLearnNudge, nudgeEnvironmentAllowed } from "../../../src/plugin/tui/altimate/learn-nudge"

async function setup(options: { env?: NodeJS.ProcessEnv; stdinTTY?: boolean; stdoutTTY?: boolean } = {}) {
  const handlers = new Map<string, (event: Event) => void>()
  const pending: Promise<void>[] = []
  const messages: Message[] = []
  const shown: string[] = []
  const claims: string[] = []
  const state = {
    ready: true,
    config: {} as { learn?: { capture?: boolean } },
    route: { name: "session", params: { sessionID: "session" } },
    path: { worktree: "/repo", directory: "/repo/subdir" },
    projectID: undefined as string | undefined,
  }
  let loaded = 0
  let dispose = () => {}
  const controller = new AbortController()
  const api = {
    state: {
      get ready() {
        return state.ready
      },
      get config() {
        return state.config
      },
      get path() {
        return state.path
      },
      session: {
        messages: () => messages,
        get: () => (state.projectID === undefined ? undefined : { projectID: state.projectID }),
      },
    },
    route: {
      get current() {
        return state.route
      },
    },
    ui: { toast: ({ message }: { message: string }) => shown.push(message) },
    lifecycle: {
      signal: controller.signal,
      onDispose(fn: () => void) {
        dispose = fn
      },
    },
    event: {
      on(type: string, handler: (event: Event) => void) {
        handlers.set(type, handler)
        return () => handlers.delete(type)
      },
    },
  } as unknown as TuiPluginApi

  await installLearnNudge(api, {
    env: {},
    stdinTTY: true,
    stdoutTTY: true,
    ...options,
    async load() {
      loaded++
      return {
        LearnNudge: class extends LearnNudge {
          constructor(deps: ConstructorParameters<typeof LearnNudge>[0]) {
            super({
              ...deps,
              claim: async (project) => {
                claims.push(project)
                return true
              },
            })
          }
          override onPart(part: Parameters<LearnNudge["onPart"]>[0]) {
            const work = super.onPart(part)
            pending.push(work)
            return work
          }
          override onIdle(sessionID: string) {
            const work = super.onIdle(sessionID)
            pending.push(work)
            return work
          }
        },
      }
    },
  })

  function emit(type: Event["type"], properties: object) {
    handlers.get(type)?.({ id: "event", type, properties } as Event)
  }
  function assistant(sessionID = "session") {
    emit("message.updated", { info: { id: "m0", sessionID, role: "assistant", time: { completed: 1 } } })
  }
  function correction(id: string, sessionID = "session") {
    emit("message.updated", { info: { id, sessionID, role: "user", time: { created: 2 } } })
    emit("message.part.updated", {
      part: { id: `${id}-text`, sessionID, messageID: id, type: "text", text: "No, use the existing helper instead." },
    })
  }
  function idle(sessionID = "session") {
    emit("session.status", { sessionID, status: { type: "idle" } })
  }
  return {
    state,
    shown,
    claims,
    loaded,
    handlers,
    messages,
    emit,
    assistant,
    correction,
    idle,
    async flush() {
      await Promise.all(pending)
    },
    dispose() {
      controller.abort()
      dispose()
    },
  }
}

describe("learning nudge TUI plugin", () => {
  test("run and its JSON output path stay outside the TUI plugin host", async () => {
    const [run, tui, attach] = await Promise.all(
      ["run", "tui", "attach"].map((command) =>
        Bun.file(new URL(`../../../src/cli/cmd/${command}.ts`, import.meta.url)).text(),
      ),
    )
    expect(run).toContain('args.format === "json"')
    expect(run).not.toMatch(/createLegacyTuiPluginHost|plugin\/tui\/runtime|learn-nudge|learn\/(?:nudge|correction)/)
    expect(tui).toContain("pluginHost: createLegacyTuiPluginHost({ local: true })")
    expect(attach).toContain("pluginHost: createLegacyTuiPluginHost()")
    expect(attach).not.toContain("local: true")
  })

  test("counts full user text after an assistant and shows exactly once on the second correction's idle", async () => {
    const h = await setup()
    h.correction("initial-task")
    h.idle()
    h.assistant()
    h.correction("m1")
    h.idle()
    await h.flush()
    expect(h.shown).toEqual([])
    h.correction("m2")
    h.emit("session.status", { sessionID: "session", status: { type: "busy" } })
    await h.flush()
    expect(h.shown).toEqual([])
    h.idle()
    h.idle()
    await h.flush()
    expect(h.shown).toEqual([NUDGE_TOAST])
    expect(h.shown[0]).toContain("Don't show again: `altimate-code learn nudge off`")
    expect(h.claims).toEqual(["/repo"])
  })

  test("does not load the observer or subscribe under CI or non-TTY", async () => {
    for (const options of [
      { env: { CI: "true" } },
      { env: { CI: "" } },
      { env: { CI: "false" } },
      { stdinTTY: false },
      { stdoutTTY: false },
    ]) {
      const h = await setup(options)
      expect(h.loaded).toBe(0)
      expect(h.handlers.size).toBe(0)
    }
    expect(nudgeEnvironmentAllowed({}, true, true)).toBe(true)
  })

  test("ignores other sessions and hidden or loading views", async () => {
    const h = await setup()
    h.assistant("background")
    h.correction("b1", "background")
    h.correction("b2", "background")
    h.idle("background")
    h.state.route.name = "home"
    h.assistant()
    h.correction("m1")
    h.correction("m2")
    h.idle()
    h.state.route.name = "session"
    h.state.ready = false
    h.assistant()
    h.correction("m3")
    h.correction("m4")
    h.idle()
    await h.flush()
    expect(h.shown).toEqual([])
    expect(h.claims).toEqual([])
  })

  test("uses an already hydrated completed assistant for a resumed session", async () => {
    const h = await setup()
    h.messages.push({
      id: "m0",
      sessionID: "session",
      role: "assistant",
      time: { created: 0, completed: 1 },
    } as Message)
    h.correction("m1")
    h.correction("m2")
    h.idle()
    await h.flush()
    expect(h.shown).toEqual([NUDGE_TOAST])
  })

  test("does not mistake the later assistant response for a prior turn", async () => {
    const h = await setup()
    h.messages.push({
      id: "m9",
      sessionID: "session",
      role: "assistant",
      time: { created: 0, completed: 1 },
    } as Message)
    h.correction("m1")
    h.correction("m2")
    h.idle()
    await h.flush()
    expect(h.shown).toEqual([])
  })

  test("project capture and env capture both suppress the nudge", async () => {
    for (const env of [{}, { ALTIMATE_LEARN_CAPTURE: "false" }, { ALTIMATE_LEARN_CAPTURE: "TRUE" }]) {
      const h = await setup({ env })
      if (env.ALTIMATE_LEARN_CAPTURE !== "TRUE") h.state.config.learn = { capture: true }
      h.assistant()
      h.correction("m1")
      h.correction("m2")
      h.idle()
      await h.flush()
      expect(h.shown).toEqual([])
      expect(h.claims).toEqual([])
    }
  })

  test("rechecks enablement at idle and does not restart after disabling learning", async () => {
    const h = await setup()
    h.assistant()
    h.correction("m1")
    h.correction("m2")
    await h.flush()
    h.state.config.learn = { capture: true }
    h.idle()
    h.state.config.learn.capture = false
    h.assistant()
    h.correction("m3")
    h.correction("m4")
    h.idle()
    await h.flush()
    expect(h.shown).toEqual([])
    expect(h.claims).toEqual([])
  })

  test("stops pending classification and notice work when the TUI is disposed", async () => {
    const h = await setup()
    h.assistant()
    h.correction("m1")
    h.correction("m2")
    h.idle()
    h.dispose()
    await h.flush()
    expect(h.shown).toEqual([])
    expect(h.claims).toEqual([])
  })

  test("linked worktrees use the same hydrated project identity", async () => {
    const h = await setup()
    h.state.projectID = "shared-repository"
    h.assistant()
    h.correction("m1")
    h.correction("m2")
    h.idle()
    await h.flush()
    h.state.path = { worktree: "/linked-worktree", directory: "/linked-worktree/subdir" }
    h.state.route.params.sessionID = "other-session"
    h.assistant("other-session")
    h.correction("m3", "other-session")
    h.correction("m4", "other-session")
    h.idle("other-session")
    await h.flush()
    expect(h.claims).toEqual(["project:shared-repository", "project:shared-repository"])
  })

  test("uses the directory for the global nongit project", async () => {
    const h = await setup()
    h.state.projectID = "global"
    h.state.path = { worktree: "/", directory: "/scratch" }
    h.assistant()
    h.correction("m1")
    h.correction("m2")
    h.idle()
    await h.flush()
    expect(h.claims).toEqual(["/scratch"])
  })
})
