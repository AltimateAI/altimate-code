import { Effect, Exit } from "effect"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import type * as PlatformError from "effect/PlatformError"
import type * as Scope from "effect/Scope"
import { ChildProcessSpawner } from "effect/unstable/process"
import { InstanceRef } from "../../src/effect/instance-ref"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance, provideTmpdirServer } from "../fixture/fixture"
import type { TestLLMServer } from "../lib/llm-server"

type Body<A, E, R> = Effect.Effect<A, E, R> | (() => Effect.Effect<A, E, R>)

const body = <A, E, R>(value: Body<A, E, R>) => (typeof value === "function" ? value() : value)

export function withLegacyInstance<A, E, R>(value: Body<A, E, R>) {
  return Effect.gen(function* () {
    const instance = yield* InstanceRef
    if (!instance) return yield* body(value)

    const context = yield* Effect.context<R>()
    const exit = yield* Effect.promise(() =>
      Instance.restore(instance, () => Effect.runPromiseExit(body(value).pipe(Effect.provide(context)))),
    )
    if (Exit.isSuccess(exit)) return exit.value
    return yield* Effect.failCause(exit.cause)
  })
}

const isInstanceOptions = (options: any) =>
  !!options && typeof options === "object" && ("git" in options || "config" in options || "init" in options)

const mergeConfig = (base: any, next: any) => {
  if (!base) return next
  if (!next) return base
  return () => {
    const resolvedBase = typeof base === "function" ? base() : base
    const resolvedNext = typeof next === "function" ? next() : next
    return {
      ...resolvedBase,
      ...resolvedNext,
      enabled_providers: resolvedNext.enabled_providers ?? resolvedBase.enabled_providers,
      provider: {
        ...resolvedBase.provider,
        ...resolvedNext.provider,
      },
    }
  }
}

const mergeOptions = (defaults: any, options: any) => {
  if (!defaults) return options
  if (options === undefined) return defaults
  if (!isInstanceOptions(options)) return options
  return {
    ...defaults,
    ...options,
    config: mergeConfig(defaults.config, options.config),
  }
}

export function withLegacyInstanceRunner<T extends { instance: any }>(runner: T, defaults?: any): T {
  const wrap = (method: any) => (name: string, value: any, options?: any, opts?: any) =>
    method(name, () => withLegacyInstance(value), mergeOptions(defaults, options), opts)

  const instance = wrap(runner.instance) as any
  instance.only = wrap(runner.instance.only)
  instance.skip = wrap(runner.instance.skip)
  instance.todo = runner.instance.todo

  return { ...runner, instance }
}

export function provideTmpdirInstanceLegacy<A, E, R>(
  self: (dir: string) => Effect.Effect<A, E, R>,
  options?: { git?: boolean; config?: Partial<ConfigV1.Info> | (() => Partial<ConfigV1.Info>) },
) {
  return provideTmpdirInstance((dir: string) => withLegacyInstance(self(dir)), options)
}

export function provideTmpdirServerLegacy<A, E, R>(
  self: (input: { dir: string; llm: TestLLMServer["Service"] }) => Effect.Effect<A, E, R>,
  options?: { git?: boolean; config?: (url: string) => Partial<ConfigV1.Info> },
): Effect.Effect<
  A,
  E | PlatformError.PlatformError,
  R | TestLLMServer | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  return provideTmpdirServer((input) => withLegacyInstance(self(input)) as Effect.Effect<A, E, R>, options)
}
