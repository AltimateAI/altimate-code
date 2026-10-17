import { afterEach, describe, expect, test } from "bun:test"
import Ajv2020 from "ajv/dist/2020"
import path from "node:path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { PermissionNext } from "@/permission/next"
import type { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { ProviderTransform } from "@/provider/transform"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { TestConfig } from "../../fixture/config"
import { disposeAllInstances } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"

const fixture = (enableParallel: boolean) =>
  testEffect(
    LayerNode.buildLayer(LayerNode.group([ToolRegistry.node, Agent.node]), {
      replacements: [
        LayerNode.replace(Config.node, TestConfig.layer()),
        LayerNode.replace(RuntimeFlags.node, RuntimeFlags.layer({ enableParallel })),
      ],
    }),
  )

afterEach(disposeAllInstances)

const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false })
const formats = new Set([
  "date-time",
  "date",
  "time",
  "duration",
  "email",
  "idn-email",
  "hostname",
  "idn-hostname",
  "ipv4",
  "ipv6",
  "uri",
  "uri-reference",
  "iri",
  "iri-reference",
  "uuid",
  "uri-template",
  "json-pointer",
  "relative-json-pointer",
  "regex",
])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// altimate_change start — text_label must not advertise empty-string label sentinels.
function schemaErrors(schema: object | boolean, rejectEmptySentinels = false): string[] {
  // altimate_change end
  const errors = ajv.validateSchema(schema) ? [] : [ajv.errorsText(ajv.errors, { separator: "\n" })]
  function visit(value: unknown, location = "#") {
    if (!isObject(value)) return
    for (const keyword of ["$schema", "nullable"]) {
      if (keyword in value) errors.push(`${location}/${keyword} is not supported by Anthropic`)
    }
    for (const keyword of ["exclusiveMinimum", "exclusiveMaximum"]) {
      if (typeof value[keyword] === "boolean") errors.push(`${location}/${keyword} must be numeric`)
    }
    if (typeof value.format === "string" && !formats.has(value.format)) {
      errors.push(`${location}/format is not a standard format: ${value.format}`)
    }
    // altimate_change start — reject empty sentinel schemas in model-facing tools.
    if (rejectEmptySentinels) {
      if (value.const === "") errors.push(`${location}/const must not be an empty string`)
      if (Array.isArray(value.enum) && value.enum.includes("")) {
        errors.push(`${location}/enum must not contain an empty string`)
      }
    }
    // altimate_change end
    if (
      "additionalProperties" in value &&
      typeof value.additionalProperties !== "boolean" &&
      !isObject(value.additionalProperties)
    ) {
      errors.push(`${location}/additionalProperties must be boolean or a schema`)
    }
    // Walk schema positions only: property names and enum/default values may contain these keywords.
    for (const keyword of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]) {
      if (!isObject(value[keyword])) continue
      for (const [name, child] of Object.entries(value[keyword])) visit(child, `${location}/${keyword}/${name}`)
    }
    for (const keyword of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
      if (!Array.isArray(value[keyword])) continue
      value[keyword].forEach((child, index) => visit(child, `${location}/${keyword}/${index}`))
    }
    for (const keyword of [
      "items",
      "contains",
      "additionalProperties",
      "unevaluatedProperties",
      "unevaluatedItems",
      "propertyNames",
      "not",
      "if",
      "then",
      "else",
      "contentSchema",
    ]) {
      visit(value[keyword], `${location}/${keyword}`)
    }
  }
  visit(schema)
  return errors
}

function model(providerID: ProviderID): Provider.Model {
  const id = providerID === ProviderID.amazonBedrock ? "global.anthropic.claude-opus-5-5" : "claude-opus-5-5"
  return {
    id: ModelID.make(id),
    providerID,
    api: { id, npm: `@ai-sdk/${providerID}`, url: "https://example.invalid" },
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
    limit: { context: 200_000, output: 32_000 },
    status: "active",
    release_date: "2026-01-01",
    options: {},
    headers: {},
  }
}

describe("Anthropic tool JSON schemas", () => {
  for (const enableParallel of [false, true]) {
    const it = fixture(enableParallel)
    for (const providerID of [ProviderID.anthropic, ProviderID.amazonBedrock]) {
      for (const name of ["analyst", "builder"]) {
        it.instance(
          `${providerID}, search ${enableParallel ? "enabled" : "disabled"}: every registered ${name} tool satisfies draft 2020-12 and Anthropic restrictions`,
          () =>
            Effect.gen(function* () {
              const registry = yield* ToolRegistry.Service
              const agents = yield* Agent.Service
              const agent = yield* agents.get(name)
              if (!agent) throw new Error(`${name} agent not found`)
              const target = model(providerID)
              const tools = yield* registry.tools({ providerID, modelID: target.id, agent })
              expect(tools.map((tool) => tool.id)).toEqual(expect.arrayContaining(["sql_check", "sql_execute", "read"]))
              // altimate_change start — validate the labeling schema with each Anthropic provider.
              expect(tools.some((tool) => tool.id === "text_label")).toBe(
                name === "analyst" && process.env.ALTIMATE_TEXT_LABEL !== "0",
              )
              // altimate_change end
              expect(tools.some((tool) => tool.id === "answer_commit")).toBe(name === "analyst")

              // Match prompt.ts / session/tools.ts conversion. Both SDK providers forward this schema unchanged.
              // Also retain the legacy LLM.stream permission-filtered insertion order for offline diagnostics.
              const disabled = PermissionNext.disabled(
                tools.map((tool) => tool.id),
                agent.permission,
              )
              let requestIndex = 0
              const schemas = tools.map((tool, registryIndex) => ({
                name: tool.id,
                registryIndex,
                requestIndex: tool.id === "invalid" || disabled.has(tool.id) ? null : requestIndex++,
                schema: JSON.parse(JSON.stringify(ProviderTransform.schema(target, ToolJsonSchema.fromTool(tool)))),
              }))
              const dump = process.env.TOOL_SCHEMA_DUMP_DIR
              if (dump) {
                yield* Effect.promise(() =>
                  Bun.write(
                    path.join(dump, `${providerID}-${name}${enableParallel ? "-search" : ""}.json`),
                    JSON.stringify(schemas, null, 2),
                  ),
                )
              }
              // Validate every registered tool, including ones hidden by this agent's permissions.
              // altimate_change start — reject empty label sentinels without changing other tools' filler contracts.
              const errors = schemas.flatMap((tool) =>
                schemaErrors(tool.schema, tool.name === "text_label").map((error) => `${tool.name}: ${error}`),
              )
              // altimate_change end
              expect(errors).toEqual([])
            }),
        )
      }
    }
  }

  // altimate_change start — the text-label flag controls registration, including the lookup catalogue.
  fixture(false).instance("text_label is allowed for analyst by default and not registered when disabled", () =>
    Effect.gen(function* () {
      const previous = process.env.ALTIMATE_TEXT_LABEL
      try {
        delete process.env.ALTIMATE_TEXT_LABEL
        const registry = yield* ToolRegistry.Service
        const agents = yield* Agent.Service
        const analyst = yield* agents.get("analyst")
        if (!analyst) throw new Error("analyst agent not found")
        const target = model(ProviderID.anthropic)
        const enabled = yield* registry.tools({ providerID: target.providerID, modelID: target.id, agent: analyst })
        expect(enabled.map((tool) => tool.id)).toContain("text_label")
        expect(PermissionNext.disabled(["text_label"], analyst.permission).has("text_label")).toBe(false)
        const builder = yield* agents.get("builder")
        const builderTools = yield* registry.tools({ providerID: target.providerID, modelID: target.id, agent: builder })
        expect(builderTools.map((tool) => tool.id)).not.toContain("text_label")

        process.env.ALTIMATE_TEXT_LABEL = "0"
        expect(yield* registry.ids()).not.toContain("text_label")
        const disabled = yield* registry.tools({ providerID: target.providerID, modelID: target.id, agent: analyst })
        expect(disabled.map((tool) => tool.id)).not.toContain("text_label")
      } finally {
        if (previous === undefined) delete process.env.ALTIMATE_TEXT_LABEL
        else process.env.ALTIMATE_TEXT_LABEL = previous
      }
    }),
  )
  // altimate_change end

  test.each(["@ai-sdk/anthropic", "@ai-sdk/amazon-bedrock", "@ai-sdk/google-vertex/anthropic"])(
    "%s removes only the root dialect declaration without mutating the input",
    (npm) => {
      const target = model(ProviderID.anthropic)
      target.api.npm = npm
      const expected = {
        type: "object" as const,
        properties: {
          $schema: { type: "string" as const },
          value: { type: "number" as const, exclusiveMinimum: 0 },
          empty: { type: "array" as const, items: {}, minItems: 0, maxItems: 0 },
        },
        required: ["value"],
        additionalProperties: false,
      }
      const input = { $schema: "https://json-schema.org/draft/2020-12/schema", ...expected }
      const original = structuredClone(input)
      expect(ProviderTransform.schema(target, input)).toEqual(expected)
      expect(input).toEqual(original)
    },
  )

  test("rejects empty tuple prefixItems and nested Anthropic-incompatible keywords", () => {
    for (const fragment of [
      { type: "array", prefixItems: [] },
      { $schema: "https://json-schema.org/draft/2020-12/schema" },
      { nullable: true },
      { type: "number", exclusiveMinimum: true },
      { type: "number", exclusiveMaximum: false },
      { type: "string", format: "custom-format" },
      { type: "object", additionalProperties: [] },
      // altimate_change start — empty model-facing label sentinels are forbidden.
      { type: "string", const: "" },
      { type: "string", enum: [""] },
      // altimate_change end
    ]) {
      // altimate_change start — exercise the text_label schema restrictions as well.
      expect(
        schemaErrors({ type: "object", properties: { value: { anyOf: [fragment] } } }, true).length,
      ).toBeGreaterThan(0)
      // altimate_change end
    }
  })

  test("allows type arrays, compositions, standard formats, and keyword-like data", () => {
    expect(
      schemaErrors({
        type: "object",
        properties: {
          nullable: { type: ["string", "null"] },
          $schema: { type: "string", format: "uri" },
          value: { anyOf: [{ type: "number", exclusiveMinimum: 0 }, { type: "null" }] },
          choice: { oneOf: [{ const: 1 }, { const: 2 }] },
          payload: { enum: [{ nullable: true, $schema: "literal data" }] },
          labels: { type: "object", additionalProperties: { type: "string" } },
        },
        additionalProperties: false,
      }),
    ).toEqual([])
  })
})
