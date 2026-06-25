// altimate_change start — legacy zod/Promise tool -> Effect Tool adapter
//
// Upstream v1.17.9 rewrote the Tool API: `Tool.define(id, Effect<Init>)` where
// `parameters` is an Effect `Schema` and `execute` returns an `Effect`. Our 77
// altimate/memory tools are authored against the old shape (`Tool.define(id, {
// description, parameters: z.object({...}), async execute(args, ctx) })`).
//
// Rather than rewrite all 77 tools (risking silent logic loss), this module adapts
// the old shape to the new one using the SAME recipe upstream itself uses for
// plugin tools in tool/registry.ts `fromPlugin` (Schema.declare + z.toJSONSchema +
// EffectBridge to bridge the Effect-based `ask`/`metadata` back to Promises). Tool
// logic stays byte-for-byte identical.
import { Effect, Option, Schema, SchemaGetter } from "effect"
import z from "zod"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { EffectBridge } from "@/effect/bridge"
import { InstanceRef } from "@/effect/instance-ref"
import { Instance, type InstanceContext } from "@/project/instance"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Agent } from "@/agent/agent"
import type { SessionID, MessageID } from "../session/schema"
import type { Context as NewContext, DefWithoutID } from "../tool/tool"

export type Metadata = { [key: string]: any; error?: string }

/** The old fork Tool.Context shape (Promise-based ask/metadata). */
export interface LegacyContext<M extends Metadata = Metadata> {
  sessionID: SessionID
  messageID: MessageID
  agent: string
  abort: AbortSignal
  callID?: string
  extra?: { [key: string]: any }
  messages: SessionV1.WithParts[]
  metadata(input: { title?: string; metadata?: M }): void
  ask(input: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">): Promise<void>
}

export interface LegacyResult<M extends Metadata = Metadata> {
  title: string
  metadata: M
  output: string
  attachments?: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[]
}

/** Old-style tool definition object passed to Tool.define by altimate tools. */
export interface LegacyToolDef<P extends z.ZodType = z.ZodType, M extends Metadata = Metadata> {
  description: string
  parameters: P
  execute(args: z.infer<P>, ctx: LegacyContext<M>): Promise<LegacyResult<M>>
  formatValidationError?(error: z.ZodError): string
}

/** The old fork init context passed to a deferred (async-function) tool def. */
export interface LegacyInitContext {
  agent?: Agent.Info
}

/**
 * Old-style deferred tool factory: `Tool.define(id, async (ctx) => ({ ... }))`.
 * The factory runs once per init and returns the plain `LegacyToolDef`. Used by
 * tools whose description/parameters depend on runtime state (skills, agents).
 */
export type LegacyInitFn<P extends z.ZodType = z.ZodType, M extends Metadata = Metadata> = (
  ctx?: LegacyInitContext,
) => Promise<LegacyToolDef<P, M>>

export function isZodType(value: unknown): value is z.ZodType {
  return typeof value === "object" && value !== null && "_zod" in value
}

/** True when `init` is an old-style plain tool object (not an Effect). */
export function isLegacyToolDef(init: unknown): init is LegacyToolDef {
  return (
    typeof init === "object" &&
    init !== null &&
    !Effect.isEffect(init) &&
    "execute" in init &&
    isZodType((init as { parameters?: unknown }).parameters)
  )
}

/**
 * True when `init` is an old-style deferred tool factory (a plain function
 * returning a `LegacyToolDef`). Distinct from an Effect (also callable but
 * tagged) and from the new Effect-based init.
 */
export function isLegacyInitFn(init: unknown): init is LegacyInitFn {
  return typeof init === "function" && !Effect.isEffect(init)
}

function isJsonSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeZodJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeZodJsonSchema(item))
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(
        (entry) =>
          !((entry[0] === "exclusiveMaximum" || entry[0] === "exclusiveMinimum") && typeof entry[1] === "boolean"),
      )
      .map(([key, item]) => [key, normalizeZodJsonSchema(item)]),
  )
}

// altimate_change start — Effect SchemaError nests the rejected input under
// issue.actual as an Option; legacy zod formatters need the raw original input.
function schemaErrorActual(error: unknown): { found: true; value: unknown } | { found: false } {
  const unwrapActual = (actual: unknown): { found: true; value: unknown } | { found: false } => {
    if (actual === undefined) return { found: false }
    return { found: true, value: Option.isOption(actual) ? Option.getOrUndefined(actual) : actual }
  }

  const direct = unwrapActual((error as { actual?: unknown })?.actual)
  if (direct.found) return direct

  let issue = (error as { issue?: unknown })?.issue
  while (typeof issue === "object" && issue !== null) {
    const nested = unwrapActual((issue as { actual?: unknown }).actual)
    if (nested.found) return nested
    issue = (issue as { issue?: unknown }).issue
  }

  return { found: false }
}
// altimate_change end

function zodMetadataRegistry(schema: z.ZodType) {
  const registry = z.registry<Record<string, unknown>>()
  const seen = new WeakSet<object>()
  const collect = (value: unknown) => {
    if (typeof value !== "object" || value === null) return
    if (seen.has(value)) return
    seen.add(value)
    if (isZodType(value)) {
      const metadata = typeof (value as any).meta === "function" ? (value as any).meta() : undefined
      const description = typeof value.description === "string" ? value.description : undefined
      const merged = {
        ...(metadata && typeof metadata === "object" ? metadata : {}),
        ...(description ? { description } : {}),
      }
      if (Object.keys(merged).length) registry.add(value, merged)
      collect((value as any)._zod?.def)
      return
    }
    for (const item of Object.values(value as Record<string, unknown>)) collect(item)
  }
  collect(schema)
  return registry
}

/** zod schema -> JSON Schema, matching tool/registry.ts `zodJsonSchema`. */
export function zodToJsonSchema(schema: z.ZodType): JSONSchema7 {
  const result = normalizeZodJsonSchema(
    (z as any).toJSONSchema(schema, { io: "input", metadata: zodMetadataRegistry(schema) }),
  )
  if (!isJsonSchemaObject(result)) throw new Error("altimate tool zod schema produced a non-object JSON Schema")
  const { $defs, ...rest } = result as Record<string, unknown>
  return ($defs && isJsonSchemaObject($defs)
    ? { ...rest, definitions: $defs as JSONSchema7["definitions"] }
    : rest) as JSONSchema7
}

/** Build a `DefWithoutID` from a resolved legacy tool object (no Effect wrapper). */
function legacyDefToDef(legacy: LegacyToolDef): DefWithoutID {
  return {
    description: legacy.description,
    // altimate_change start — decode THROUGH zod's `parse` so defaults, coercions and transforms
    // are applied to the value `execute` receives (and that callers see via decode). A plain
    // Schema.declare only validates and passes the raw input through, silently dropping zod
    // `.default()`/`.transform()`. Validation failures still surface as Effect SchemaErrors whose
    // nested issue.actual carries the original input (used by formatValidationError below).
    parameters: Schema.declare<unknown>((u): u is unknown => legacy.parameters.safeParse(u).success).pipe(
      Schema.decodeTo(Schema.Unknown, {
        decode: SchemaGetter.transform((u: unknown) => legacy.parameters.parse(u)),
        encode: SchemaGetter.transform((u: unknown) => u),
      }),
    ),
    // altimate_change end
    jsonSchema: zodToJsonSchema(legacy.parameters),
    ...(legacy.formatValidationError
      ? {
          // altimate_change start — the new Tool API decodes via Schema.declare, so the
          // error reaching us is an Effect SchemaIssue (no zod `.issues`/`.path`), not a
          // z.ZodError. Recover the original input from Effect SchemaError.issue.actual and
          // re-run the zod schema to produce the real z.ZodError the legacy formatter
          // expects; fall back to the original error if recovery is impossible.
          formatValidationError: (error: unknown) => {
            const actual = schemaErrorActual(error)
            if (actual.found) {
              const parsed = legacy.parameters.safeParse(actual.value)
              if (!parsed.success) return legacy.formatValidationError!(parsed.error)
            }
            return legacy.formatValidationError!(error as z.ZodError)
          },
          // altimate_change end
        }
      : {}),
    execute: (args: unknown, ctx: NewContext) =>
      // altimate_change start — bridge the ambient Instance ALS into the Effect InstanceRef so
      // legacy tools whose execute calls async facades (Skill.get, Agent.list, …) — which resolve
      // instance state via makeRuntime → attach() reading the CURRENT fiber's InstanceRef —
      // succeed even when only the ALS is set (e.g. tests that wrap the call in Instance.restore).
      withAlsInstanceRef(
        Effect.gen(function* () {
          const bridge = yield* EffectBridge.make()
          // Also restore the ALS for tools that read Instance.directory/worktree synchronously
          // (AsyncLocalStorage-backed) when only InstanceRef (the Effect reference) is provided.
          const instance = yield* InstanceRef
          const legacyCtx: LegacyContext = {
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            agent: ctx.agent,
            abort: ctx.abort,
            callID: ctx.callID,
            extra: ctx.extra as { [key: string]: any } | undefined,
            messages: ctx.messages,
            metadata: (input) => {
              void bridge.promise(ctx.metadata(input))
            },
            ask: (input) => bridge.promise(ctx.ask(input)),
          }
          return yield* Effect.promise(() =>
            instance ? Instance.restore(instance, () => legacy.execute(args as never, legacyCtx)) : legacy.execute(args as never, legacyCtx),
          )
        }),
      ),
    // altimate_change end
  }
}

/**
 * Convert an old-style tool object into the new `DefWithoutID` (minus id), wrapped
 * in an Effect the way `Tool.define` expects. The returned `execute` bridges the
 * Effect-based context back into the Promise-based `LegacyContext` our tools use.
 */
export function legacyToInit(legacy: LegacyToolDef): Effect.Effect<DefWithoutID> {
  return Effect.sync(() => legacyDefToDef(legacy))
}

// altimate_change start — bridge the ambient Instance ALS into the Effect InstanceRef while a
// legacy init factory runs. Legacy factories (skill/task) call async facades (Skill.available,
// Agent.list) that resolve instance state through makeRuntime → attach(), which prefers the
// CURRENT fiber's InstanceRef and only falls back to the ALS when no fiber is active. Because the
// factory runs inside this init Effect's fiber, attach would read an unset InstanceRef and fail
// ("InstanceRef not provided"). Provide the ALS instance as InstanceRef so attach finds it.
function withAlsInstanceRef<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  return Effect.suspend(() => {
    let instance: InstanceContext | undefined
    try {
      instance = Instance.current
    } catch {
      instance = undefined
    }
    return instance ? effect.pipe(Effect.provideService(InstanceRef, instance)) : effect
  })
}
// altimate_change end

/**
 * Convert an old-style deferred tool factory into a new init Effect. The factory
 * runs once per init; the new Tool API does not thread the calling agent into
 * `init()`, so the factory receives an empty init context (agent undefined) and
 * any per-agent description filtering degrades to "show all" — execute-time
 * permission checks still enforce access.
 */
export function legacyInitFnToInit(fn: LegacyInitFn): Effect.Effect<DefWithoutID> {
  // altimate_change start — see withAlsInstanceRef: keep the instance context available to the
  // factory's async facade calls (Skill.available/Agent.list) which resolve via makeRuntime.
  return withAlsInstanceRef(Effect.promise(() => fn({}))).pipe(Effect.map(legacyDefToDef))
  // altimate_change end
}
// altimate_change end
