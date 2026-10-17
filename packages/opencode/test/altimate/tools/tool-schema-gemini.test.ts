import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import type { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { ProviderTransform } from "@/provider/transform"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { TestConfig } from "../../fixture/config"
import { disposeAllInstances } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"

const it = testEffect(
  LayerNode.buildLayer(LayerNode.group([ToolRegistry.node, Agent.node]), {
    replacements: [
      LayerNode.replace(Config.node, TestConfig.layer()),
      LayerNode.replace(RuntimeFlags.node, RuntimeFlags.layer({ enableParallel: false })),
    ],
  }),
)

afterEach(disposeAllInstances)

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// Gemini rejects a function declaration whose enum (or const) contains an empty string:
// "function_declarations[i].parameters...enum[0]: cannot be empty".
function emptyEnumValues(schema: unknown, location = "#"): string[] {
  if (Array.isArray(schema)) return schema.flatMap((child, index) => emptyEnumValues(child, `${location}/${index}`))
  if (!isObject(schema)) return []
  const found: string[] = []
  if (Array.isArray(schema.enum) && schema.enum.some((value) => String(value) === "")) found.push(`${location}/enum`)
  if (schema.const === "") found.push(`${location}/const`)
  for (const [key, child] of Object.entries(schema)) {
    if (key === "enum" || key === "const" || key === "default") continue
    found.push(...emptyEnumValues(child, `${location}/${key}`))
  }
  return found
}

function model(providerID: ProviderID): Provider.Model {
  const id = "gemini-4-argon"
  return {
    id: ModelID.make(id),
    providerID,
    api: { id, npm: providerID === ProviderID.google ? "@ai-sdk/google" : "@ai-sdk/google-vertex", url: "https://example.invalid" },
    name: id,
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 1_000_000, output: 64_000 },
    status: "active",
    release_date: "2026-01-01",
    options: {},
    headers: {},
  }
}

describe("Gemini tool JSON schemas", () => {
  for (const providerID of [ProviderID.google, ProviderID.googleVertex]) {
    for (const name of ["analyst", "builder"]) {
      it.instance(`${providerID}: no registered ${name} tool declares an empty-string enum or const`, () =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const agents = yield* Agent.Service
          const agent = yield* agents.get(name)
          if (!agent) throw new Error(`${name} agent not found`)
          const target = model(providerID)
          const tools = yield* registry.tools({ providerID, modelID: target.id, agent })
          expect(tools.some((tool) => tool.id === "answer_commit")).toBe(name === "analyst")
          const errors = tools.flatMap((tool) =>
            emptyEnumValues(ProviderTransform.schema(target, ToolJsonSchema.fromTool(tool))).map(
              (location) => `${tool.id}: ${location}`,
            ),
          )
          expect(errors).toEqual([])
        }),
      )
    }
  }

  test("drops empty-string enum and const values but keeps the remaining enum", () => {
    const result = ProviderTransform.schema(model(ProviderID.googleVertex), {
      type: "object",
      properties: {
        unresolved: { anyOf: [{ type: "object", properties: {} }, { type: "string", enum: [""] }] },
        blank: { type: "string", const: "" },
        mode: { type: "string", enum: ["", "fast", "slow"] },
      },
    } as any) as any
    expect(result.properties.unresolved.anyOf[1]).toEqual({ type: "string" })
    expect(result.properties.blank).toEqual({ type: "string" })
    expect(result.properties.mode.enum).toEqual(["fast", "slow"])
  })

  test("keeps an untyped node a string when its empty const or enum is dropped", () => {
    const result = ProviderTransform.schema(model(ProviderID.googleVertex), {
      type: "object",
      properties: {
        constOnly: { anyOf: [{ const: "" }, { type: "number" }] },
        enumOnly: { enum: [""] },
        nullable: { type: ["string", "null"], const: "" },
        emptyEnum: { type: "string", enum: [] },
      },
    } as any) as any
    expect(result.properties.constOnly.anyOf[0]).toEqual({ type: "string" })
    expect(result.properties.enumOnly).toEqual({ type: "string" })
    expect(result.properties.nullable).toEqual({ anyOf: [{ type: "string" }], nullable: true })
    expect(result.properties.emptyEnum.enum).toEqual([])
  })
})
