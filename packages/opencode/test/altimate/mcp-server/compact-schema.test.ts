import { expect, test } from "bun:test"
import { compactSchema } from "../../../src/altimate/mcp-server/adapter"

const fillers = [
  { type: "null" },
  { type: "string", const: "" },
  { minItems: 0, maxItems: 0, type: "array", items: { not: {} } },
  { type: "object", properties: {}, additionalProperties: false },
]

test("collapses optional-property filler unions but keeps nullable array members", () => {
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      note: { description: "kept", anyOf: [{ type: "string" }, ...fillers] },
      cells: { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }] } },
      size: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    },
    required: ["cells"],
    additionalProperties: false,
  }
  expect(compactSchema("none", schema) as unknown).toEqual({
    type: "object",
    properties: {
      note: { type: "string", description: "kept" },
      cells: { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }] } },
      size: { type: "integer", minimum: 0 },
    },
    required: ["cells"],
  })
  // The input is not mutated.
  expect(schema.properties.note.anyOf).toHaveLength(5)
})

test("a description table naming a missing property or a required one to drop fails loudly", () => {
  const schema = {
    type: "object",
    properties: { warehouse: { type: "string" }, check: { type: "string" } },
    required: ["warehouse", "check"],
  }
  // sql_check's table lists properties this schema lacks.
  expect(() => compactSchema("sql_check", schema)).toThrow(/has no property/)
})
