import "./environment"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { Permission } from "@opencode/schema/permission"
import { OpenCode } from "@opencode/sdk"
import Altimate from "../../src/server"
import { createScriptedModel, type ScriptedStep } from "./scripted-model"

export type SessionLogEvent =
  ReturnType<OpenCode.Interface["sessions"]["log"]> extends AsyncIterable<infer Event> ? Event : never

export interface Host {
  opencode: OpenCode.Interface
  model: ReturnType<typeof createScriptedModel>
  createSession: () => ReturnType<OpenCode.Interface["sessions"]["create"]>
  start: (sessionID: string, steps: readonly ScriptedStep[]) => Promise<void>
  run: (sessionID: string, steps: readonly ScriptedStep[]) => Promise<SessionLogEvent[]>
  [Symbol.asyncDispose]: () => Promise<void>
}

export async function createFixture() {
  const path = await mkdtemp(join(tmpdir(), "altimate-s1-"))
  return {
    path,
    [Symbol.asyncDispose]: () => rm(path, { recursive: true, force: true }),
  }
}

export async function createHost(input: {
  directory: string
  steps?: readonly ScriptedStep[]
  permissions?: Permission.Ruleset
  plugins?: readonly Plugin.Plugin[]
}): Promise<Host> {
  await mkdir(join(input.directory, "config"), { recursive: true })
  const model = createScriptedModel(input.steps)
  const opencode = await OpenCode.create({
    database: { path: join(input.directory, "opencode.sqlite") },
    events: { persist: true },
    models: { fetch: false },
    fs: { filewatcher: false, fff: false },
    plugins: [Altimate, model.plugin, ...(input.plugins ?? [])],
    config: {
      directory: join(input.directory, "config"),
      project: false,
      content: JSON.stringify({
        model: "scripted/scripted",
        agents: { title: { disabled: true } },
        snapshots: false,
        permissions: input.permissions,
      }),
    },
  })
  const start = async (sessionID: string, steps: readonly ScriptedStep[]) => {
    // Rejection can end a drain before the final text; each run owns a fresh response queue.
    model.reset([...steps, { text: "Script complete." }])
    await opencode.sessions.prompt({ sessionID, text: "Run the scripted data tools." })
  }
  return {
    opencode,
    model,
    createSession: () => opencode.sessions.create({ location: { directory: input.directory } }),
    start,
    async run(sessionID: string, steps: readonly ScriptedStep[]) {
      await start(sessionID, steps)
      await opencode.sessions.wait({ sessionID })
      return Array.fromAsync(opencode.sessions.log({ sessionID }))
    },
    [Symbol.asyncDispose]: () => opencode.close(),
  }
}
