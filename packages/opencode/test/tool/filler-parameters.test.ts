import { afterEach, describe, expect } from "bun:test"
import { Effect, Exit, Layer, Result, Schema } from "effect"
import z from "zod"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EffectBridge } from "@/effect/bridge"
import { Plugin } from "@/plugin"
import { Instance } from "@/project/instance"
import { MessageID, SessionID } from "@/session/schema"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances, requireInstance } from "../fixture/fixture"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const fillers = [[], "", 0, null]
const pluginCalls: unknown[] = []
const pluginLayer = Layer.succeed(
  Plugin.Service,
  Plugin.Service.of({
    init: () => Effect.void,
    trigger: ((_name: unknown, _input: unknown, output: unknown) =>
      Effect.succeed(output)) as Plugin.Interface["trigger"],
    list: () =>
      Effect.succeed([
        {
          tool: {
            optional_array_plugin: {
              description: "Synthetic optional parameters",
              args: {
                labels: z.array(z.string()).min(1).optional(),
                limit: z.number().optional().default(3),
              },
              execute: async (args: unknown) => {
                pluginCalls.push(args)
                return "ok"
              },
            },
          },
        },
      ]),
  }),
)

const it = testEffect(
  LayerNode.buildLayer(LayerNode.group([ToolRegistry.node, Agent.node, Truncate.node]), {
    replacements: [
      LayerNode.replace(
        Config.node,
        TestConfig.layer({
          get: () => Effect.succeed({ experimental: { batch_tool: true } }),
        }),
      ),
      LayerNode.replace(RuntimeFlags.node, RuntimeFlags.layer()),
      LayerNode.replace(Plugin.node, pluginLayer),
    ],
  }),
)

afterEach(async () => {
  pluginCalls.length = 0
  await disposeAllInstances()
})

function branches(schema: JSONSchema7): JSONSchema7[] {
  const alternatives = schema.anyOf ?? schema.oneOf
  if (!alternatives) return [schema]
  const { anyOf: _, oneOf: __, ...base } = schema
  return alternatives.flatMap((branch) => (typeof branch === "boolean" ? [] : branches({ ...base, ...branch })))
}

function fixture(definition: JSONSchema7 | boolean, root: JSONSchema7): unknown {
  if (typeof definition === "boolean") return "value"
  if (definition.$ref) {
    const name = definition.$ref.replace(/^#\/(?:\$defs|definitions)\//, "")
    const target = root.definitions?.[name]
    if (!target) throw new Error(`Unresolved fixture reference: ${definition.$ref}`)
    return fixture(target, root)
  }
  if (definition.const !== undefined) return definition.const
  if (definition.enum) return definition.enum[0]
  if (definition.default !== undefined) return definition.default
  const alternative = definition.anyOf?.[0] ?? definition.oneOf?.[0]
  if (alternative !== undefined) return fixture(alternative, root)
  const type = Array.isArray(definition.type) ? definition.type[0] : definition.type
  if (type === "object" || definition.properties) {
    return Object.fromEntries(
      (definition.required ?? []).map((name) => [name, fixture(definition.properties?.[name] ?? true, root)]),
    )
  }
  if (type === "array") {
    const length = Math.max(definition.minItems ?? 0, Array.isArray(definition.items) ? definition.items.length : 0)
    return Array.from({ length }, (_, index) =>
      fixture(Array.isArray(definition.items) ? definition.items[index] : (definition.items ?? true), root),
    )
  }
  if (type === "number" || type === "integer") {
    const minimum = definition.minimum ?? 1
    const value =
      typeof definition.exclusiveMinimum === "number" ? Math.max(minimum, definition.exclusiveMinimum + 1) : minimum
    return definition.maximum === undefined ? value : Math.min(value, definition.maximum)
  }
  if (type === "boolean") return false
  if (type === "null") return null
  if (definition.format === "uri" || definition.format === "url") return "https://example.com"
  return "value".padEnd(definition.minLength ?? 0, "x").slice(0, definition.maxLength)
}

function context(): Tool.Context {
  return {
    sessionID: SessionID.make("ses_optional_parameters"),
    messageID: MessageID.make("msg_optional_parameters"),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    ask: () => Effect.void,
    metadata: () => Effect.void,
  }
}

describe("optional tool parameter fillers", () => {
  it.instance(
    "every registered schema accepts optional fillers, either preserved as valid values or treated as omission",
    () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const instance = yield* requireInstance
        const bridge = yield* EffectBridge.make()
        const infos = yield* registry.allInfos()
        expect(infos.some((info) => info.id === "optional_array_plugin")).toBe(true)
        expect(infos.some((info) => info.id === "sql_execute")).toBe(true)
        expect(infos.some((info) => info.id === "read")).toBe(true)
        const failures: string[] = []
        let checked = 0
        for (const info of infos) {
          const tool = yield* Effect.promise(() => Instance.restore(instance, () => bridge.promise(info.init())))
          const schema = ToolJsonSchema.fromTool({ ...tool, id: info.id })
          const decode = Schema.decodeUnknownResult(tool.parameters)
          for (const [index, branch] of branches(schema).entries()) {
            const input = fixture(branch, schema) as Record<string, unknown>
            const omitted = decode(input)
            if (Result.isFailure(omitted)) {
              failures.push(`${info.id}[${index}] invalid omission fixture: ${String(omitted.failure)}`)
              continue
            }
            const optional = Object.keys(branch.properties ?? {}).filter((name) => !branch.required?.includes(name))
            for (const filler of fillers) {
              for (const name of optional) {
                const filled = decode({ ...input, [name]: filler })
                checked++
                if (Result.isFailure(filled)) {
                  failures.push(`${info.id}[${index}].${name} rejects ${JSON.stringify(filler)}`)
                } else if (
                  JSON.stringify(filled.success) !== JSON.stringify(omitted.success) &&
                  (filled.success as Record<string, unknown>)?.[name] !== filler &&
                  JSON.stringify((filled.success as Record<string, unknown>)?.[name]) !== JSON.stringify(filler)
                ) {
                  failures.push(`${info.id}[${index}].${name} changes omission behavior for ${JSON.stringify(filler)}`)
                }
              }
              const filled = decode({ ...input, ...Object.fromEntries(optional.map((name) => [name, filler])) })
              if (Result.isFailure(filled)) {
                failures.push(`${info.id}[${index}] rejects all optionals set to ${JSON.stringify(filler)}`)
              }
            }
          }
        }
        expect(checked).toBeGreaterThan(0)
        expect(failures).toEqual([])
      }),
  )

  it.instance("legacy and native execution preserve defaults for fillers without relaxing required arrays", () =>
    Effect.gen(function* () {
      const calls: unknown[] = []
      const legacyParameters = z.object({
        required: z.array(z.string()).min(1),
        text: z.string(),
        labels: z.array(z.string()).min(1).optional(),
        limit: z.number().optional().default(3),
        enabled: z.boolean().optional().default(true),
      })
      const nativeParameters = Schema.Struct({
        required: Schema.NonEmptyArray(Schema.String),
        text: Schema.String,
        labels: Schema.optional(Schema.NonEmptyArray(Schema.String)),
        limit: Schema.Number.pipe(Schema.optional, Schema.withDecodingDefaultType(Effect.succeed(3))),
        enabled: Schema.Boolean.pipe(Schema.optional, Schema.withDecodingDefaultType(Effect.succeed(true))),
      })
      expect(legacyParameters.safeParse({ required: ["kept"], text: "", labels: [] }).success).toBe(false)
      expect(
        Result.isFailure(Schema.decodeUnknownResult(nativeParameters)({ required: ["kept"], text: "", labels: [] })),
      ).toBe(true)
      const legacy = yield* Tool.define("optional_array_legacy", {
        description: "Synthetic optional parameters",
        parameters: legacyParameters,
        execute: async (args) => {
          calls.push(args)
          return { title: "ok", output: "ok", metadata: { truncated: false } }
        },
      })
      const native = yield* Tool.define(
        "optional_array_native",
        Effect.succeed({
          description: "Synthetic optional parameters",
          parameters: nativeParameters,
          execute: (args: typeof nativeParameters.Type) =>
            Effect.sync(() => {
              calls.push(args)
              return { title: "ok", output: "ok", metadata: { truncated: false } }
            }),
        }),
      )
      for (const info of [legacy, native]) {
        const tool = yield* info.init()
        const execute = tool.execute as (args: unknown, ctx: Tool.Context) => ReturnType<typeof tool.execute>
        for (const filler of fillers) {
          const input = { required: ["kept"], text: "", labels: filler, limit: filler, enabled: filler }
          // A numeric zero is a valid `limit` on its own, so it is kept; other fillers fall back to defaults.
          const expected = { required: ["kept"], text: "", limit: filler === 0 ? 0 : 3, enabled: true }
          expect(Schema.decodeUnknownSync(tool.parameters)(input)).toEqual(expected)
          yield* execute(input, context())
          expect(calls.at(-1)).toEqual(expected)
          expect(Result.isFailure(Schema.decodeUnknownResult(tool.parameters)({ required: filler, text: "" }))).toBe(
            true,
          )
        }
        const supplied = { required: ["kept"], text: "", labels: ["selected"], limit: 7, enabled: false }
        yield* execute(supplied, context())
        expect(calls.at(-1)).toEqual(supplied)
        for (const invalid of [{}, { ...supplied, labels: [42] }, { ...supplied, limit: "invalid" }]) {
          const before = calls.length
          expect(Exit.isFailure(yield* execute(invalid, context()).pipe(Effect.exit))).toBe(true)
          expect(calls).toHaveLength(before)
        }
      }
    }),
  )

  it.instance("plugin execution receives the same decoded defaults as omitted arguments", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const info = (yield* registry.allInfos()).find((info) => info.id === "optional_array_plugin")!
      const tool = yield* info.init()
      const decode = Schema.decodeUnknownSync(tool.parameters)
      for (const filler of fillers) {
        const input = { labels: filler, limit: filler }
        // Zero is a valid `limit` for this plugin, so it is kept; other fillers fall back to the default.
        const expected = { limit: filler === 0 ? 0 : 3 }
        expect(decode(input)).toEqual(expected)
        yield* tool.execute(input, context())
        expect(pluginCalls.at(-1)).toEqual(expected)
      }
    }),
  )

  it.instance("optional enum fillers do not select discriminated union branches", () =>
    Effect.gen(function* () {
      const legacy = yield* Tool.define("optional_union_legacy", {
        description: "Synthetic discriminated parameters",
        parameters: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("left"), mode: z.enum(["fast", "slow"]).optional() }),
          z.object({ kind: z.literal("right"), text: z.string() }),
        ]),
        execute: async () => ({ title: "ok", output: "ok", metadata: { truncated: false } }),
      })
      const native = yield* Tool.define(
        "optional_union_native",
        Effect.succeed({
          description: "Synthetic discriminated parameters",
          parameters: Schema.Union([
            Schema.Struct({ kind: Schema.Literal("left"), mode: Schema.optional(Schema.Literals(["fast", "slow"])) }),
            Schema.Struct({ kind: Schema.Literal("right"), text: Schema.String }),
          ]),
          execute: () => Effect.succeed({ title: "ok", output: "ok", metadata: { truncated: false } }),
        }),
      )
      const failures: string[] = []
      for (const info of [legacy, native]) {
        const tool = yield* info.init()
        const decode = Schema.decodeUnknownResult(tool.parameters)
        const omitted = decode({ kind: "left" })
        expect(Result.isSuccess(omitted)).toBe(true)
        for (const mode of fillers) {
          const filled = decode({ kind: "left", mode })
          if (Result.isFailure(filled) || JSON.stringify(filled.success) !== JSON.stringify({ kind: "left" })) {
            failures.push(`${info.id} rejects optional mode filler ${JSON.stringify(mode)}`)
          }
        }
        expect(Schema.decodeUnknownSync(tool.parameters)({ kind: "right", text: "" })).toEqual({
          kind: "right",
          text: "",
        })
        expect(Schema.decodeUnknownSync(tool.parameters)({ kind: "left", mode: "fast" })).toEqual({
          kind: "left",
          mode: "fast",
        })
      }
      expect(failures).toEqual([])
    }),
  )
  it.instance("schema-valid empty and zero values are preserved; fillers are stripped only when validation fails", () =>
    Effect.gen(function* () {
      const legacy = yield* Tool.define("optional_valid_legacy", {
        description: "Synthetic intentional values",
        parameters: z.object({
          max_entries: z.number().min(0).optional().default(20),
          description: z.string().optional(),
          integration_ids: z.array(z.string()).optional(),
          labels: z.array(z.string()).min(1).optional(),
          limit: z.number().min(1).optional().default(3),
        }),
        execute: async () => ({ title: "ok", output: "ok", metadata: { truncated: false } }),
      })
      const native = yield* Tool.define(
        "optional_valid_native",
        Effect.succeed({
          description: "Synthetic intentional values",
          parameters: Schema.Struct({
            max_entries: Schema.Number.pipe(Schema.optional, Schema.withDecodingDefaultType(Effect.succeed(20))),
            description: Schema.optional(Schema.String),
            integration_ids: Schema.optional(Schema.Array(Schema.String)),
            labels: Schema.optional(Schema.NonEmptyArray(Schema.String)),
          }),
          execute: () => Effect.succeed({ title: "ok", output: "ok", metadata: { truncated: false } }),
        }),
      )
      for (const info of [legacy, native]) {
        const tool = yield* info.init()
        const decode = Schema.decodeUnknownSync(tool.parameters) as (input: unknown) => Record<string, unknown>
        // Valid as sent: intentional values survive.
        expect(decode({ max_entries: 0, description: "", integration_ids: [] })).toMatchObject({
          max_entries: 0,
          description: "",
          integration_ids: [],
        })
        // Invalid as sent (labels: []): only the rejected filler is removed.
        const retried = decode({ max_entries: 0, description: "", integration_ids: [], labels: [] })
        expect(retried.max_entries).toBe(0)
        // Fillers that are valid on their own are kept; only the rejected one is dropped.
        expect(retried.description).toBe("")
        expect(retried.integration_ids).toEqual([])
        expect(retried).not.toHaveProperty("labels")
      }
      // A filler the schema itself rejects (limit: 0) falls back to the default.
      const legacyTool = yield* legacy.init()
      expect(Schema.decodeUnknownSync(legacyTool.parameters)({ limit: 0 })).toMatchObject({ limit: 3 })
    }),
  )
})
