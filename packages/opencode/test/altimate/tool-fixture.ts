import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
// altimate_change start — TaskTool's init now yields BackgroundJob/Config/Session/RuntimeFlags
// services (v1.18.10). Init only stores them (nothing is invoked at definition time), so empty
// mocks are sufficient here.
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import { RuntimeFlags } from "@/effect/runtime-flags"
// altimate_change end
import type { LegacyToolDef } from "@/altimate/tool-zod-compat"

type ToolEffect = Effect.Effect<Tool.Info<any, any>, never, any> & { id: string }

type MaybeEffectOrPromise<A> = Effect.Effect<A, any, any> | PromiseLike<A> | A

export type TestToolContext = Omit<Tool.Context, "metadata" | "ask"> & {
  metadata?: (input: Parameters<Tool.Context["metadata"]>[0]) => MaybeEffectOrPromise<void>
  ask?: (input: Parameters<Tool.Context["ask"]>[0]) => MaybeEffectOrPromise<void>
}

export type TestTool<T extends ToolEffect> = Omit<Tool.InferDef<T>, "execute"> & {
  execute(args: any, ctx: any): Promise<Tool.ExecuteResult<any>>
}

const testAgent = {
  name: "build",
  mode: "primary",
  permission: {},
  options: {},
} as Agent.Info

const toolLayer = Layer.mergeAll(
  Layer.succeed(
    Agent.Service,
    Agent.Service.of({
      get: () => Effect.succeed(testAgent),
      list: () => Effect.succeed([testAgent]),
      defaultInfo: () => Effect.succeed(testAgent),
      defaultAgent: () => Effect.succeed(testAgent.name),
      generate: () => Effect.die(new Error("not implemented in test tool fixture")),
    }),
  ),
  Layer.succeed(
    Truncate.Service,
    Truncate.Service.of({
      cleanup: () => Effect.void,
      write: () => Effect.succeed(""),
      output: (content: string) => Effect.succeed({ content, truncated: false as const }),
      limits: () => Effect.succeed({ maxLines: Number.MAX_SAFE_INTEGER, maxBytes: Number.MAX_SAFE_INTEGER }),
    }),
  ),
  // altimate_change start — TaskTool's init yields BackgroundJob.Service (v1.18.10); stub it
  Layer.succeed(
    BackgroundJob.Service,
    BackgroundJob.Service.of({
      list: () => Effect.succeed([]),
      get: () => Effect.succeed(undefined),
      start: () => Effect.die(new Error("not implemented in test tool fixture")),
      extend: () => Effect.succeed(false),
      wait: () => Effect.die(new Error("not implemented in test tool fixture")),
      waitForPromotion: () => Effect.die(new Error("not implemented in test tool fixture")),
      promote: () => Effect.succeed(undefined),
      cancel: () => Effect.succeed(undefined),
    }),
  ),
  Layer.mock(Config.Service, {}),
  Layer.mock(Session.Service, {}),
  RuntimeFlags.layer(),
  // altimate_change end
)

function toEffect(value: MaybeEffectOrPromise<void>): Effect.Effect<void, any, any> {
  if (Effect.isEffect(value)) return value
  if (value && typeof (value as PromiseLike<void>).then === "function") {
    return Effect.promise(() => value as PromiseLike<void>)
  }
  return Effect.void
}

function toEffectContext(ctx: TestToolContext): Tool.Context {
  return {
    ...ctx,
    metadata: (input) => toEffect(ctx.metadata?.(input)),
    ask: (input) => toEffect(ctx.ask?.(input)),
  } as Tool.Context
}

export async function toolInfo<T extends ToolEffect>(tool: T): Promise<Tool.Info<any, any>> {
  const provided = tool.pipe(Effect.provide(toolLayer)) as Effect.Effect<Tool.Info<any, any>, never, never>
  return Effect.runPromise(provided)
}

export async function legacyToolInfo(id: string, def: LegacyToolDef): Promise<Tool.Info<any, any>> {
  return toolInfo(Tool.define(id, def))
}

export async function initTool<T extends ToolEffect>(tool: T): Promise<TestTool<T>> {
  const info = await toolInfo(tool)
  const def = await Effect.runPromise(info.init())
  return {
    id: info.id,
    ...def,
    execute: (args: any, ctx: any) => Effect.runPromise(def.execute(args, toEffectContext(ctx))),
  } as TestTool<T>
}
