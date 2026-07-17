import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EffectBridge } from "../../../src/effect/bridge"
import { InstanceRef, WorkspaceRef } from "../../../src/effect/instance-ref"
import { attachWith } from "../../../src/effect/run-service"
import { WorkspaceContext } from "../../../src/control-plane/workspace-context"

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..", "..")
const opencodeRoot = path.join(repoRoot, "packages", "opencode")
const srcDir = path.join(opencodeRoot, "src")

async function readSrc(...rel: string[]) {
  return fs.readFile(path.join(srcDir, ...rel), "utf-8")
}

function stripComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
}

function fakeInstance(directory = "/tmp/upi-runtime") {
  return {
    directory,
    worktree: directory,
    project: { id: "proj_upi", name: "upi", vcs: "git" },
  } as any
}

describe("UPI-01 runtime graph: lazy layers and explicit cycle failures", () => {
  test("LayerNode dependency thunks are resolved at build time, after cyclic imports settle", () => {
    let dependency: any
    const root = LayerNode.make(Layer.empty as any, () => [dependency])
    dependency = LayerNode.make(Layer.empty as any, [] as any)

    expect(() => LayerNode.buildLayer(root as any)).not.toThrow()
  })

  test("LayerNode reports an explicit cycle path instead of failing with undefined deps", () => {
    let a: any
    let b: any
    a = LayerNode.make(Layer.empty as any, () => [b])
    b = LayerNode.make(Layer.empty as any, () => [a])

    expect(() => LayerNode.buildLayer(a as any)).toThrow(/Cycle detected in app graph: layer#\d+ -> layer#\d+/)
  })

  test("AppLayer defers defaultLayer reads for the circular service graph", async () => {
    const source = await readSrc("effect", "app-runtime.ts")
    expect(source).toContain("export const AppLayer = Layer.suspend(() =>")

    for (const service of ["Config", "Provider", "ToolRegistry", "SessionPrompt", "MCP", "LSP", "Permission"]) {
      expect(source).toContain(`${service}.defaultLayer`)
    }
  })

  test("known circular-prone service nodes use lazy dependency thunks", async () => {
    const files = [
      ["config/config.ts", "Config"],
      ["mcp/index.ts", "MCP"],
      ["mcp/auth.ts", "McpAuth"],
      ["lsp/lsp.ts", "LSP"],
      ["permission/index.ts", "Permission"],
      ["provider/auth.ts", "ProviderAuth"],
      ["tool/registry.ts", "ToolRegistry"],
    ] as const

    for (const [file, label] of files) {
      const source = stripComments(await readSrc(...file.split("/")))
      expect(source, `${label} should defer LayerNode dependencies`).toMatch(/LayerNode\.make\([^,]+,\s*\(\)\s*=>\s*\[/s)
    }
  })
})

describe("UPI-02 and UPI-03 Promise facades preserve instance and workspace context", () => {
  test("attachWith provides both InstanceRef and WorkspaceRef to Effect services", async () => {
    const instance = fakeInstance()
    const result = await Effect.runPromise(
      attachWith(
        Effect.gen(function* () {
          return {
            instance: yield* InstanceRef,
            workspace: yield* WorkspaceRef,
          }
        }),
        { instance, workspace: "ws_upi" },
      ),
    )

    expect(result.instance).toBe(instance)
    expect(result.workspace as string | undefined).toBe("ws_upi")
  })

  test("EffectBridge.fromPromise restores WorkspaceContext for async callbacks", async () => {
    const result = await Effect.runPromise(
      EffectBridge.fromPromise(async () => {
        await Promise.resolve()
        return WorkspaceContext.workspaceID
      }).pipe(Effect.provideService(WorkspaceRef, "ws_bridge" as any)),
    )

    expect(result as string | undefined).toBe("ws_bridge")
  })

  test("EffectBridge.make().promise carries refs across a Promise facade crossing", async () => {
    const instance = fakeInstance("/tmp/upi-bridge")
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const bridge = yield* EffectBridge.make()
        return yield* Effect.promise(() =>
          bridge.promise(
            Effect.gen(function* () {
              return {
                instance: yield* InstanceRef,
                workspace: yield* WorkspaceRef,
                alsWorkspace: WorkspaceContext.workspaceID,
              }
            }),
          ),
        )
      }).pipe(
        Effect.provideService(InstanceRef, instance),
        Effect.provideService(WorkspaceRef, "ws_bridge_promise" as any),
      ),
    )

    expect(result.instance).toBe(instance)
    expect(result.workspace as string | undefined).toBe("ws_bridge_promise")
    expect(result.alsWorkspace as string | undefined).toBe("ws_bridge_promise")
  })

  test("makeRuntime facades always attach captured refs before running service effects", async () => {
    const source = await readSrc("effect", "run-service.ts")
    expect(source).toContain("tryLegacyInstance()")
    expect(source).toMatch(/runPromise:[\s\S]*getRuntime\(\)\.runPromise\(attach\(service\.use\(fn\)\)/)
    expect(source).toMatch(/runFork:[\s\S]*getRuntime\(\)\.runFork\(attach\(service\.use\(fn\)\)/)
  })
})

describe("UPI-05 through UPI-07 session split invariants", () => {
  test("legacy Session row mapping preserves workspace and re-brands project ids at the DB boundary", async () => {
    const source = await readSrc("session", "index.ts")
    expect(source).toContain("projectID: ProjectID.make(row.project_id)")
    expect(source).toContain("project_id: ProjectV2.ID.make(info.projectID)")
    expect(source).toContain("workspaceID: row.workspace_id ?? undefined")
    expect(source).toContain("workspace_id: info.workspaceID")
  })

  test("Effect Session rows preserve path, agent, model, metadata, tokens, and permission copies", async () => {
    const source = await readSrc("session", "session.ts")
    for (const field of ["path: row.path ?? undefined", "agent: row.agent ?? undefined", "metadata: row.metadata ?? undefined"]) {
      expect(source).toContain(field)
    }
    expect(source).toContain("permission: row.permission ? [...row.permission] : undefined")
    expect(source).toContain("tokens_input")
    expect(source).toContain("ModelV2.ID.make(row.model.id)")
    expect(source).toContain("ProviderV2.ID.make(row.model.providerID)")
  })

  test("Effect session create/update publish through EventV2Bridge instead of direct legacy Bus writes", async () => {
    const source = await readSrc("session", "session.ts")
    const createBody = source.slice(source.indexOf('Effect.fn("Session.createNext"'), source.indexOf('const get = Effect.fn("Session.get"'))
    const patchBody = source.slice(source.indexOf("const patch ="), source.indexOf('const touch = Effect.fn("Session.touch"'))

    expect(createBody).toContain("events.publish(SessionV1.Event.Created")
    expect(patchBody).toContain("events.publish(SessionV1.Event.Updated")
    expect(patchBody).not.toContain("Bus.publish")
  })

  test("PartDelta remains on the legacy Bus because it is not a core EventV2 definition", async () => {
    const source = await readSrc("session", "session.ts")
    const body = source.slice(source.indexOf('const updatePartDelta = Effect.fnUntraced'), source.indexOf("return Service.of", source.indexOf('const updatePartDelta = Effect.fnUntraced')))

    expect(body).toContain("Bus.publish(MessageV2.Event.PartDelta")
    expect(body).not.toContain("events.publish")
  })
})
