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
import { Effect, Schema } from "effect"
import z from "zod"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { EffectBridge } from "@/effect/bridge"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionV1 } from "@opencode-ai/core/v1/session"
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

/**
 * Convert an old-style tool object into the new `DefWithoutID` (minus id), wrapped
 * in an Effect the way `Tool.define` expects. The returned `execute` bridges the
 * Effect-based context back into the Promise-based `LegacyContext` our tools use.
 */
export function legacyToInit(legacy: LegacyToolDef): Effect.Effect<DefWithoutID> {
  return Effect.sync(() => ({
    description: legacy.description,
    parameters: Schema.declare<unknown>((u): u is unknown => legacy.parameters.safeParse(u).success),
    jsonSchema: zodToJsonSchema(legacy.parameters),
    ...(legacy.formatValidationError
      ? { formatValidationError: (error: unknown) => legacy.formatValidationError!(error as z.ZodError) }
      : {}),
    execute: (args: unknown, ctx: NewContext) =>
      Effect.gen(function* () {
        const bridge = yield* EffectBridge.make()
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
        return yield* Effect.promise(() => legacy.execute(args as never, legacyCtx))
      }),
  }))
}
// altimate_change end
