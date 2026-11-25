// altimate_change - new file
import { afterEach, expect, spyOn, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { ProjectID } from "../../src/project/schema"
import { Provider } from "../../src/provider/provider"
import { Env } from "../../src/env"
import { AltimateApi } from "../../src/altimate/api/client"
import { WorkspaceApi } from "../../src/altimate/workspace/api-client"
import * as State from "../../src/altimate/workspace/state"

let spies: Array<{ mockRestore(): void }> = []
afterEach(() => {
  spies.forEach((s) => s.mockRestore())
  spies = []
})

function withWorkspaceKeys(keys: Record<string, string>) {
  spies.push(spyOn(AltimateApi, "isConfigured").mockResolvedValue(true))
  spies.push(spyOn(WorkspaceApi, "captureCredentials").mockResolvedValue({ url: "https://x.test", instance: "t", apiKey: "k" }))
  spies.push(spyOn(State, "resolveBinding").mockResolvedValue({ datamateId: 7 } as any))
  spies.push(spyOn(WorkspaceApi, "getModelKeys").mockResolvedValue(keys))
}

function inInstance<R>(directory: string, init: () => Promise<unknown>, fn: () => Promise<R>) {
  const now = Date.now()
  return Instance.restore(
    {
      directory,
      worktree: directory,
      project: { id: ProjectID.global, worktree: directory, time: { created: now, updated: now }, sandboxes: [] },
    },
    async () => {
      await init()
      return fn()
    },
  )
}

test("a workspace key credentials a provider that has none, and the gateway login is untouched", async () => {
  withWorkspaceKeys({ anthropic: "ws-anthropic-key" })
  await using tmp = await tmpdir({})
  await inInstance(
    tmp.path,
    async () => void delete process.env.ANTHROPIC_API_KEY,
    async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"]?.options["apiKey"]).toBe("ws-anthropic-key")
      expect(providers["altimate-backend"]?.options["apiKey"]).not.toBe("ws-anthropic-key")
    },
  )
})

test("a key the user already has wins over the workspace key", async () => {
  withWorkspaceKeys({ anthropic: "ws-anthropic-key" })
  await using tmp = await tmpdir({})
  await inInstance(
    tmp.path,
    async () => Env.set("ANTHROPIC_API_KEY", "own-key"),
    async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"]?.key).toBe("own-key")
      expect(providers["anthropic"]?.options["apiKey"]).toBeUndefined()
    },
  )
})

test("a disabled provider is not enabled by a workspace key", async () => {
  withWorkspaceKeys({ anthropic: "ws-anthropic-key" })
  await using tmp = await tmpdir({ config: { disabled_providers: ["anthropic"] } })
  await inInstance(
    tmp.path,
    async () => void delete process.env.ANTHROPIC_API_KEY,
    async () => {
      expect((await Provider.list())["anthropic"]).toBeUndefined()
    },
  )
})
