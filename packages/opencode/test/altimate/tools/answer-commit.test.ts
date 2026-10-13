import { describe, expect, test } from "bun:test"
import Ajv2020 from "ajv/dist/2020"
import { rejects } from "node:assert/strict"
import { Effect } from "effect"
import { AnswerCommit } from "../../../src/altimate/tools/answer-commit"
import * as answerCommitModule from "../../../src/altimate/tools/answer-commit"
import { MessageID, SessionID } from "../../../src/session/schema"
import { ToolJsonSchema } from "../../../src/tool/json-schema"
import { initTool, toolInfo } from "../tool-fixture"

test("answer_commit exposes the namespace projection", () => {
  expect(answerCommitModule).toHaveProperty("AnswerCommit.AnswerCommitTool", AnswerCommit.AnswerCommitTool)
  expect(answerCommitModule).toHaveProperty("AnswerCommit.renderAnswer", AnswerCommit.renderAnswer)
})

describe("answer_commit boolean tolerance", () => {
  test.each([true, "true", "TRUE", "TrUe", 1])("answer_only %s suppresses basis and labels", async (answer_only) => {
    const payload = {
      answer_only,
      basis: "Counted records at record grain using records.id.",
      fields: [{ name: "Count", value: 2 }],
    }
    expect(AnswerCommit.renderAnswer(payload)).toBe("2")
    const tool = await initTool(AnswerCommit.AnswerCommitTool)
    expect((await tool.execute(payload, context)).output).toBe("2")
  })

  test.each([false, "false", "FALSE", "FaLsE", 0])("answer_only %s renders the basis", async (answer_only) => {
    const basis = "Counted records at record grain using records.id."
    const payload = { answer_only, basis, fields: [{ name: "Count", value: 2 }] }
    expect(AnswerCommit.renderAnswer(payload)).toBe(`${basis}\n\n**Answer:** Count: 2`)
    const tool = await initTool(AnswerCommit.AnswerCommitTool)
    expect((await tool.execute(payload, context)).output).toBe(`${basis}\n\n**Answer:** Count: 2`)
  })

  test.each(["yes", "no", "1", "0", 2, -1])("rejects invalid answer_only %s", async (answer_only) => {
    const payload = {
      answer_only,
      basis: "Counted records at record grain using records.id.",
      fields: [{ name: "", value: 2 }],
    }
    expect(() => AnswerCommit.renderAnswer(payload)).toThrow(/answer_only.*boolean/i)
    const tool = await initTool(AnswerCommit.AnswerCommitTool)
    await rejects(tool.execute(payload, context), /answer_only.*boolean/i)
  })

  test("keeps the advertised answer_only value boolean", async () => {
    const tool = await initTool(AnswerCommit.AnswerCommitTool)
    expect(tool.jsonSchema?.properties?.answer_only).toMatchObject({ anyOf: [{ type: "boolean" }, {}, {}, {}, {}] })
  })
})

describe("answer_commit required basis", () => {
  test.each([undefined, false, "false", 0, null, "", [], {}, true, "true", "TRUE", "TrUe", 1].map((value) => [value]))(
    "answer_only %j requires basis for every answer shape",
    async (answer_only) => {
      const tool = await initTool(AnswerCommit.AnswerCommitTool)
      for (const shape of [
        { fields: [{ name: "", value: 2 }] },
        { rows: { columns: ["Count"], values: [[2]] } },
        { unresolved: { reason: "No matching records." } },
      ]) {
        const payload = { ...shape, answer_only }
        const error = /basis.*required.*population.*grain.*source object\/column.*caveats/i
        expect(() => AnswerCommit.renderAnswer(payload)).toThrow(error)
        await rejects(tool.execute(payload, context), error)
      }
    },
  )

  test.each([undefined, null, "", " \t\r\n ", [], {}].map((value) => [value]))(
    "basis filler %j cannot replace a required basis",
    async (basis) => {
      const payload = { fields: [{ name: "", value: 2 }], basis }
      expect(() => AnswerCommit.renderAnswer(payload)).toThrow(/basis.*required/i)
      const tool = await initTool(AnswerCommit.AnswerCommitTool)
      await rejects(tool.execute(payload, context), /basis.*required/i)
    },
  )

  test.each([undefined, null, "", " \t\r\n ", [], {}].map((value) => [value]))(
    "answer_only rejects absent basis %j",
    async (basis) => {
      const payload = { answer_only: "true", fields: [{ name: "Count", value: 2 }], basis }
      expect(() => AnswerCommit.renderAnswer(payload)).toThrow(/basis.*required/i)
      const tool = await initTool(AnswerCommit.AnswerCommitTool)
      await rejects(tool.execute(payload, context), /basis.*required/i)
    },
  )

  test("description and schema explain the basis requirement and attribution source", async () => {
    const tool = await initTool(AnswerCommit.AnswerCommitTool)
    expect(tool.description).toContain(
      "Always supply `basis`; it is never shown when the request asks for only the answer",
    )
    expect(tool.description).toContain(
      "one or two sentences, at most 400 characters, naming population, grain, the source object/column that supplies the requested entity or value, and caveats",
    )
    expect(tool.description).toContain(
      "Resolve policy eligibility separately from metric and entity attribution: a rule about a related object does not change which object supplies the requested entity. Say in `basis` which source object and column supply it.",
    )
    expect(structuredClone(tool.jsonSchema?.properties?.basis)).toMatchObject({
      type: "string",
      description: expect.stringMatching(
        /always required.*one or two sentences, at most 400 characters.*population.*grain.*source object\/column.*caveats.*never rendered with answer_only/i,
      ),
    })
    expect(tool.jsonSchema?.required).toContain("basis")
  })
})

describe("answer_commit validation repair", () => {
  test.each([
    ["invalid boolean", { answer_only: "yes", fields: [{ name: "", value: 2 }] }, /answer_only/],
    ["missing basis", { fields: [{ name: "", value: 2 }] }, /basis/],
    [
      "answer_only fields missing basis",
      { answer_only: true, fields: [{ name: "Id", value: "requested-id" }] },
      /basis/,
    ],
    [
      "answer_only rows missing basis",
      { answer_only: true, rows: { columns: ["Id"], values: [["requested-id"]] } },
      /basis/,
    ],
    [
      "answer_only unresolved missing basis",
      { answer_only: true, unresolved: { reason: "No matching records." } },
      /basis/,
    ],
    ["missing value", { fields: [{ name: "Count" }] }, /fields.*value/],
    ["missing shape", { basis: "Counted records at record grain using records.id." }, /fields, rows, or unresolved/],
  ] as [string, unknown, RegExp][])(
    "%s returns a one-line error and a valid repair example",
    async (_name, payload, expected) => {
      const tool = await initTool(AnswerCommit.AnswerCommitTool)
      for (const execute of [() => AnswerCommit.renderAnswer(payload), () => tool.execute(payload, context)]) {
        let message = ""
        try {
          await execute()
        } catch (error) {
          message = error instanceof Error ? error.message : String(error)
        }
        const lines = message.split("\n")
        expect(lines[0]).toMatch(expected)
        expect(lines[1]).toStartWith("Minimal valid example: ")
        const exampleText = lines[1]!.match(/^Minimal valid example: `(.*)`\.?$/)?.[1]
        expect(exampleText).toBeDefined()
        const example = JSON.parse(exampleText!)
        expect(AnswerCommit.renderAnswer(example)).toBeString()
        expect((await tool.execute(example, context)).output).toBe(AnswerCommit.renderAnswer(example))
      }
    },
  )
})

test("answer_commit executes synchronously with native Effect permissions", async () => {
  const info = await toolInfo(AnswerCommit.AnswerCommitTool)
  const tool = await Effect.runPromise(info.init())
  const asks: unknown[] = []
  const result = Effect.runSync(
    tool.execute(
      { fields: [{ name: "Count", value: 2 }], basis: "Counted records at record grain using records.id." },
      {
        ...context,
        sessionID: SessionID.make("ses_test"),
        messageID: MessageID.make("msg_test"),
        metadata: () => Effect.void,
        ask: (input) => Effect.sync(() => void asks.push(input)),
      },
    ),
  )
  expect(result.output).toBe("Counted records at record grain using records.id.\n\n**Answer:** Count: 2")
  expect(asks).toEqual([{ permission: "answer_commit", patterns: ["*"], always: ["*"], metadata: {} }])
})

const recordBasis = "Used all records at record grain from records.value."

// altimate_change start - preserve the requested tabular output format
describe("answer_commit row formats", () => {
  test.each([
    {
      name: "csv quotes commas, quotes and newlines and includes headers",
      rows: {
        format: "csv",
        columns: ['Name, "label"', "Value"],
        values: [
          ['West, "Co"', null],
          ["line\r\nbreak", " 001.20|\\ "],
        ],
      },
      expected: '"Name, ""label""",Value\n"West, ""Co""",\n"line\r\nbreak", 001.20|\\ ',
    },
    {
      name: "tsv quotes tabs, quotes and newlines and includes headers",
      rows: {
        format: "tsv",
        columns: ["Name\tlabel", "Value"],
        values: [
          ["West\tCo", null],
          ['a"b', "line\nbreak"],
          ["line\rbreak", "comma, unchanged"],
        ],
      },
      expected: '"Name\tlabel"\tValue\n"West\tCo"\t\n"a""b"\t"line\nbreak"\n"line\rbreak"\tcomma, unchanged',
    },
    {
      name: "lines renders a single-column list without headers",
      rows: { format: "lines", columns: ["Name"], values: [["West"], ["East"]] },
      expected: "West\nEast",
    },
    {
      name: "lines separates two-column cells with one space",
      rows: {
        format: "lines",
        columns: ["Name", "Count"],
        values: [
          ["West|\\", 5],
          ["East", "001.20"],
          ["Missing", null],
        ],
        precision: { Count: 2 },
      },
      expected: "West|\\ 5.00\nEast 001.20\nMissing null",
    },
    {
      name: "csv applies precision to numeric cells and preserves strings",
      rows: {
        format: "csv",
        columns: ["Count", "Rate", "Unspecified"],
        values: [
          [5, 1.234, 2.5],
          ["005.00", "1.2300", null],
        ],
        precision: { Count: 2, Rate: 1 },
      },
      expected: "Count,Rate,Unspecified\n5.00,1.2,2.5\n005.00,1.2300,",
    },
    {
      name: "default remains markdown",
      rows: {
        columns: ["Name", "Count"],
        values: [
          ["West|\\", 5],
          ["East", null],
        ],
      },
      expected: "| Name | Count |\n|---|---|\n| West\\|\\\\ | 5 |\n| East | null |",
    },
    {
      name: "explicit markdown retains table rendering",
      rows: { format: "markdown", columns: ["Count"], values: [[5]], precision: { Count: 2 } },
      expected: "| Count |\n|---|\n| 5.00 |",
    },
  ])("$name", async ({ rows, expected }) => {
    const tool = await initTool(AnswerCommit.AnswerCommitTool)
    for (const answer_only of [true, false]) {
      const payload = { basis: recordBasis, answer_only, rows: { ...rows, note: "Result note." } }
      const output = answer_only ? expected : `${recordBasis}\n\n**Answer:**\n${expected}\nResult note.`
      expect(AnswerCommit.renderAnswer(payload)).toBe(output)
      expect((await tool.execute(payload, context)).output).toBe(output)
    }
  })

  test("description and schema advertise the tabular formats", async () => {
    const tool = await initTool(AnswerCommit.AnswerCommitTool)
    expect(tool.description).toMatch(/when the request names a tabular format, set rows.format accordingly/i)
    expect(structuredClone(tool.jsonSchema?.properties?.rows)).toMatchObject({
      anyOf: expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            format: expect.objectContaining({
              anyOf: expect.arrayContaining([{ type: "string", enum: ["markdown", "csv", "tsv", "lines"] }]),
              description: expect.stringMatching(/markdown.*default.*csv.*tsv.*lines/i),
            }),
          }),
        }),
      ]),
    })
  })

  test.each(["csv", "tsv", "lines"])("%s retains the rendered-size cap", async (format) => {
    const tool = await initTool(AnswerCommit.AnswerCommitTool)
    const payload = {
      basis: recordBasis,
      answer_only: true,
      rows: { format, columns: ["Value"], values: [['"'.repeat(format === "lines" ? 60_001 : 30_000)]] },
    }
    const error = /60,000 characters.*aggregate.*narrow/i
    expect(() => AnswerCommit.renderAnswer(payload)).toThrow(error)
    await rejects(tool.execute(payload, context), error)
  })
})
// altimate_change end

describe("answer_commit numeric safety", () => {
  test("description explains numeric precision and exact decimal strings", async () => {
    const tool = await initTool(AnswerCommit.AnswerCommitTool)
    expect(tool.description).toContain(
      "Numbers are accepted up to 15 significant digits; any decimal that must be reproduced exactly (more digits, trailing zeros, or currency strings) must be passed as a string.",
    )
  })

  test.each(["9007199254740993", "-9007199254740993", "1e30"])("rejects unsafe field number %s", async (value) => {
    const payload = JSON.parse(`{"fields":[{"name":"Count","value":${value}}]}`)
    expect(() => AnswerCommit.renderAnswer(payload)).toThrow(/fields.*value.*safe.*string/i)
    const tool = await initTool(AnswerCommit.AnswerCommitTool)
    await rejects(tool.execute(payload, context), /fields.*value.*safe.*string/i)
  })

  test.each(["9007199254740993", "-9007199254740993", "1e30"])("rejects unsafe table number %s", async (value) => {
    const payload = JSON.parse(`{"rows":{"columns":["Count"],"values":[[${value}]]}}`)
    expect(() => AnswerCommit.renderAnswer(payload)).toThrow(/rows.*values.*safe.*string/i)
    const tool = await initTool(AnswerCommit.AnswerCommitTool)
    await rejects(tool.execute(payload, context), /rows.*values.*safe.*string/i)
  })

  test.each(["1234567890123456.7", "9007199254740991.1", "-1234567890123456.7", "0.1234567890123456"])(
    "rejects precision-losing parsed number %s in fields and rows",
    async (literal) => {
      const value = JSON.parse(literal)
      const tool = await initTool(AnswerCommit.AnswerCommitTool)
      for (const shape of [
        { fields: [{ name: "", value }] },
        { rows: { columns: ["Value"], values: [[value]] } },
      ]) {
        const payload = { basis: recordBasis, ...shape }
        const error = /15 significant digits.*exact value as a string/i
        expect(() => AnswerCommit.renderAnswer(payload)).toThrow(error)
        await rejects(tool.execute(payload, context), error)
      }
    },
  )

  test.each([
    999999999999999,
    -999999999999999,
    46919.15,
    12,
    0.1,
    -3.5e-7,
    1.25,
    "9007199254740993",
    "-9007199254740993",
    "1234567890123456.7",
    "9007199254740991.1",
  ])(
    "preserves safe numbers and numeric strings: %s",
    async (value) => {
      const tool = await initTool(AnswerCommit.AnswerCommitTool)
      const fields = { basis: recordBasis, fields: [{ name: "", value }] }
      const rows = { basis: recordBasis, rows: { columns: ["Count"], values: [[value]] } }
      expect(AnswerCommit.renderAnswer(fields)).toBe(`${recordBasis}\n\n**Answer:** ${value}`)
      expect((await tool.execute(fields, context)).output).toBe(`${recordBasis}\n\n**Answer:** ${value}`)
      expect(AnswerCommit.renderAnswer(rows)).toBe(`${recordBasis}\n\n**Answer:**\n| Count |\n|---|\n| ${value} |`)
      expect((await tool.execute(rows, context)).output).toBe(
        `${recordBasis}\n\n**Answer:**\n| Count |\n|---|\n| ${value} |`,
      )
    },
  )
})

describe("answer_commit display precision", () => {
  test("description and field and row schemas state the allowed precision range", async () => {
    const tool = await initTool(AnswerCommit.AnswerCommitTool)
    const range = /integer from 0 to 10 \(inclusive\)/i
    expect(tool.description).toMatch(range)
    expect(structuredClone(tool.jsonSchema?.properties?.fields)).toMatchObject({
      anyOf: expect.arrayContaining([
        expect.objectContaining({
          items: expect.objectContaining({
            properties: expect.objectContaining({
              precision: expect.objectContaining({ description: expect.stringMatching(range) }),
            }),
          }),
        }),
      ]),
    })
    expect(structuredClone(tool.jsonSchema?.properties?.rows)).toMatchObject({
      anyOf: expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            precision: expect.objectContaining({ description: expect.stringMatching(range) }),
          }),
        }),
      ]),
    })
  })

  test.each([-1, 11, 14, 1.5, "2", true])("invalid precision %j names the allowed range", async (precision) => {
    const tool = await initTool(AnswerCommit.AnswerCommitTool)
    for (const shape of [
      { fields: [{ name: "", value: 1.5, precision }] },
      { rows: { columns: ["Value"], values: [[5]], precision: { Value: precision } } },
    ]) {
      const payload = { basis: recordBasis, ...shape }
      const error = /precision.*integer from 0 to 10 \(inclusive\)/i
      expect(() => AnswerCommit.renderAnswer(payload)).toThrow(error)
      await rejects(tool.execute(payload, context), error)
    }
  })

  test.each([
    ["numeric integers use fixed decimals", 5, 2, "5.00"],
    ["without precision uses the shortest numeric form", 5, undefined, "5"],
    ["numeric strings retain trailing zeros", "5.00", 0, "5.00"],
    ["numeric strings retain leading zeros", "001.20", 10, "001.20"],
    ["text is unchanged", "unchanged", 2, "unchanged"],
    ["null is unchanged", null, 2, "null"],
    ["zero precision rounds numeric cells", 1.6, 0, "2"],
    ["maximum precision includes ten decimals", 5, 10, "5.0000000000"],
  ] as [string, string | number | null, number | undefined, string][])(
    "rows %s",
    async (_name, value, precision, rendered) => {
      const payload = {
        basis: recordBasis,
        rows: {
          columns: ["Value"],
          values: [[value]],
          ...(precision === undefined ? {} : { precision: { Value: precision } }),
        },
      }
      const expected = `${recordBasis}\n\n**Answer:**\n| Value |\n|---|\n| ${rendered} |`
      expect(AnswerCommit.renderAnswer(payload)).toBe(expected)
      const tool = await initTool(AnswerCommit.AnswerCommitTool)
      expect((await tool.execute(payload, context)).output).toBe(expected)
    },
  )

  test("row precision applies independently by column name", async () => {
    const payload = {
      basis: recordBasis,
      answer_only: true,
      rows: {
        columns: ["Quantity", "Rate", "Unspecified"],
        values: [
          [5, 1.234, 5],
          ["5.00", null, "001.20"],
        ],
        precision: { Rate: 1, Quantity: 2 },
      },
    }
    const expected = "| Quantity | Rate | Unspecified |\n|---|---|---|\n| 5.00 | 1.2 | 5 |\n| 5.00 | null | 001.20 |"
    expect(AnswerCommit.renderAnswer(payload)).toBe(expected)
    const tool = await initTool(AnswerCommit.AnswerCommitTool)
    expect((await tool.execute(payload, context)).output).toBe(expected)
  })

  test.each([{ revenue: 2 }, { revenue: 2, Missing: 1 }])(
    "row precision rejects unknown column names %j and lists available columns",
    async (precision) => {
      const payload = {
        basis: recordBasis,
        rows: { columns: ["Revenue"], values: [[5]], precision },
      }
      const error = `Unknown rows.precision keys: ${JSON.stringify(Object.keys(precision))}; available columns: ["Revenue"]`
      expect(() => AnswerCommit.renderAnswer(payload)).toThrow(error)
      const tool = await initTool(AnswerCommit.AnswerCommitTool)
      await rejects(tool.execute(payload, context), (cause) => cause instanceof Error && cause.message.includes(error))
    },
  )

  test("row precision requires unique column labels", async () => {
    const payload = {
      basis: recordBasis,
      rows: { columns: ["Amount", "Amount"], values: [[5, 1.234]], precision: { Amount: 2 } },
    }
    const error = /precision requires unique column labels/i
    expect(() => AnswerCommit.renderAnswer(payload)).toThrow(error)
    const tool = await initTool(AnswerCommit.AnswerCommitTool)
    await rejects(tool.execute(payload, context), error)
  })

  test("duplicate row column labels render unchanged without precision", async () => {
    const payload = {
      basis: recordBasis,
      answer_only: true,
      rows: { columns: ["Amount", "Amount"], values: [[5, 1.234]] },
    }
    const expected = "| Amount | Amount |\n|---|---|\n| 5 | 1.234 |"
    expect(AnswerCommit.renderAnswer(payload)).toBe(expected)
    const tool = await initTool(AnswerCommit.AnswerCommitTool)
    expect((await tool.execute(payload, context)).output).toBe(expected)
  })

  test("row precision accepts exact column names", async () => {
    const payload = {
      basis: recordBasis,
      answer_only: true,
      rows: { columns: ["Revenue"], values: [[5]], precision: { Revenue: 2 } },
    }
    const expected = "| Revenue |\n|---|\n| 5.00 |"
    expect(AnswerCommit.renderAnswer(payload)).toBe(expected)
    const tool = await initTool(AnswerCommit.AnswerCommitTool)
    expect((await tool.execute(payload, context)).output).toBe(expected)
  })
})

describe("answer_commit rendered length limit", () => {
  const cap = 60_000
  const error = /60,000 characters.*aggregate.*narrow.*write the full table to a file.*commit the summary/i

  test("rejects rows whose rendered text exceeds the cap", async () => {
    const tool = await initTool(AnswerCommit.AnswerCommitTool)
    const payload = {
      basis: recordBasis,
      answer_only: true,
      rows: { columns: ["Value"], values: [["x".repeat(cap)]] },
    }
    expect(() => AnswerCommit.renderAnswer(payload)).toThrow(error)
    await rejects(tool.execute(payload, context), error)
  })

  test.each([cap - 1, cap])("accepts rows with %i rendered characters", async (length) => {
    const tool = await initTool(AnswerCommit.AnswerCommitTool)
    const overhead = "| Value |\n|---|\n|  |".length
    const payload = {
      basis: recordBasis,
      answer_only: true,
      rows: { columns: ["Value"], values: [["x".repeat(length - overhead)]] },
    }
    const rendered = AnswerCommit.renderAnswer(payload)
    expect(rendered.length).toBe(length)
    expect((await tool.execute(payload, context)).output).toBe(rendered)
  })

  test("counts escaped table cells and rendered basis toward the cap", async () => {
    const tool = await initTool(AnswerCommit.AnswerCommitTool)
    const payload = {
      basis: recordBasis,
      rows: { columns: ["Value"], values: [["|".repeat(cap / 2)]] },
    }
    expect(() => AnswerCommit.renderAnswer(payload)).toThrow(error)
    await rejects(tool.execute(payload, context), error)
  })

  test("applies the rendered cap to fields and unresolved answers", async () => {
    const tool = await initTool(AnswerCommit.AnswerCommitTool)
    for (const shape of [
      { fields: [{ name: "", value: "x".repeat(cap) }] },
      { unresolved: { reason: "x".repeat(cap) } },
    ]) {
      const payload = { basis: recordBasis, ...shape }
      expect(() => AnswerCommit.renderAnswer(payload)).toThrow(error)
      await rejects(tool.execute(payload, context), error)
    }
  })

  test("documents the rendered character cap and recovery in the tool description", async () => {
    const tool = await initTool(AnswerCommit.AnswerCommitTool)
    expect(tool.description).toMatch(error)
  })
})

describe("renderAnswer golden text", () => {
  const cases: [string, unknown, string][] = [
    [
      "single unnamed field",
      { basis: recordBasis, fields: [{ name: "", value: "West" }] },
      `${recordBasis}\n\n**Answer:** West`,
    ],
    [
      "single named field",
      { basis: recordBasis, fields: [{ name: "Region", value: "West" }] },
      `${recordBasis}\n\n**Answer:** Region: West`,
    ],
    [
      "single empty name with units",
      { basis: recordBasis, fields: [{ name: "", value: "42", units: "widgets" }] },
      `${recordBasis}\n\n**Answer:** 42 widgets`,
    ],
    [
      "single whitespace-only name with units",
      { basis: recordBasis, fields: [{ name: " \t\r\n ", value: "42", units: "widgets" }] },
      `${recordBasis}\n\n**Answer:** 42 widgets`,
    ],
    [
      "single Answer name with units",
      { basis: recordBasis, fields: [{ name: "Answer", value: "42", units: "widgets" }] },
      `${recordBasis}\n\n**Answer:** 42 widgets`,
    ],
    [
      "single padded mixed-case answer name with units",
      { basis: recordBasis, fields: [{ name: " aNsWeR ", value: "42", units: "widgets" }] },
      `${recordBasis}\n\n**Answer:** 42 widgets`,
    ],
    [
      "single uppercase result name with units",
      { basis: recordBasis, fields: [{ name: "RESULT", value: "42", units: "widgets" }] },
      `${recordBasis}\n\n**Answer:** 42 widgets`,
    ],
    [
      "single padded mixed-case value name with units",
      { basis: recordBasis, fields: [{ name: " vAlUe ", value: "42", units: "widgets" }] },
      `${recordBasis}\n\n**Answer:** 42 widgets`,
    ],
    [
      "single real name with units keeps its label",
      { basis: recordBasis, fields: [{ name: "Widget count", value: "42", units: "widgets" }] },
      `${recordBasis}\n\n**Answer:** Widget count: 42 widgets`,
    ],
    [
      "multiple fields keep generic labels",
      {
        basis: recordBasis,
        fields: [
          { name: "Answer", value: "42", units: "widgets" },
          { name: "RESULT", value: 2 },
          { name: " vAlUe ", value: 3 },
          { name: "", value: 4 },
        ],
      },
      `${recordBasis}\n\n**Answer:** Answer: 42 widgets; RESULT: 2;  vAlUe : 3; 4`,
    ],
    [
      "basis and units",
      { basis: "Summed completed orders.", fields: [{ name: "Revenue", value: 42, units: "USD" }] },
      "Summed completed orders.\n\n**Answer:** Revenue: 42 USD",
    ],
    [
      "multiple fields",
      {
        basis: recordBasis,
        fields: [
          { name: "Orders", value: 3 },
          { name: "Revenue", value: 12.5, units: "USD" },
        ],
      },
      `${recordBasis}\n\n**Answer:** Orders: 3; Revenue: 12.5 USD`,
    ],
    [
      "fixed numeric precision",
      { basis: recordBasis, fields: [{ name: "Rate", value: 1.2, precision: 3 }] },
      `${recordBasis}\n\n**Answer:** Rate: 1.200`,
    ],
    [
      "zero precision",
      { basis: recordBasis, fields: [{ name: "Rate", value: 1.6, precision: 0 }] },
      `${recordBasis}\n\n**Answer:** Rate: 2`,
    ],
    [
      "maximum precision",
      { basis: recordBasis, fields: [{ name: "", value: 0.5, precision: 10 }] },
      `${recordBasis}\n\n**Answer:** 0.5000000000`,
    ],
    [
      "integers stay integers",
      { basis: recordBasis, fields: [{ name: "", value: 7, precision: 2 }] },
      `${recordBasis}\n\n**Answer:** 7`,
    ],
    [
      "zero is a value",
      { basis: recordBasis, fields: [{ name: "", value: 0, precision: 2 }] },
      `${recordBasis}\n\n**Answer:** 0`,
    ],
    [
      "precision leaves text intact",
      { basis: recordBasis, fields: [{ name: "", value: "001.20", precision: 1 }] },
      `${recordBasis}\n\n**Answer:** 001.20`,
    ],
    [
      "answer_only single field",
      {
        basis: "Summed all orders at order grain using orders.amount.",
        answer_only: true,
        fields: [{ name: "Revenue", value: 1.2, units: "USD", precision: 2 }],
      },
      "1.20 USD",
    ],
    [
      "answer_only multiple fields",
      {
        answer_only: true,
        basis: "Counted all orders at order grain using orders.id and summed orders.amount for revenue.",
        fields: [
          { name: "Orders", value: 3 },
          { name: "Revenue", value: 12, units: "USD" },
        ],
      },
      "3; 12 USD",
    ],
    [
      "rows with basis",
      {
        basis: recordBasis,
        rows: {
          columns: ["Region", "Orders"],
          values: [
            ["West", 3],
            ["East", 2],
          ],
        },
      },
      `${recordBasis}\n\n**Answer:**\n| Region | Orders |\n|---|---|\n| West | 3 |\n| East | 2 |`,
    ],
    [
      "rows with basis and note",
      {
        basis: "Grouped completed orders.",
        rows: { columns: ["Region", "Orders"], values: [["West", 3]], note: "Includes all regions." },
      },
      "Grouped completed orders.\n\n**Answer:**\n| Region | Orders |\n|---|---|\n| West | 3 |\nIncludes all regions.",
    ],
    [
      "answer_only rows omit basis and note",
      {
        answer_only: true,
        basis: "Grouped completed orders.",
        rows: { columns: ["Orders"], values: [[3]], note: "This note is omitted." },
      },
      "| Orders |\n|---|\n| 3 |",
    ],
    [
      "null and empty table cells",
      { basis: recordBasis, rows: { columns: ["Value"], values: [[null], [""]] } },
      `${recordBasis}\n\n**Answer:**\n| Value |\n|---|\n| null |\n|  |`,
    ],
    [
      "table cells preserve their boundaries",
      { basis: recordBasis, rows: { columns: ["A|B"], values: [["first\nsecond|third"]] } },
      `${recordBasis}\n\n**Answer:**\n| A\\|B |\n|---|\n| first second\\|third |`,
    ],
    [
      "table headers and cells escape backslashes before pipes",
      {
        basis: recordBasis,
        rows: { columns: [String.raw`A\|B`, String.raw`C\\|D`], values: [[String.raw`a\|b`, String.raw`c\\|d`]] },
      },
      [
        recordBasis,
        "",
        "**Answer:**",
        String.raw`| A\\\|B | C\\\\\|D |`,
        "|---|---|",
        String.raw`| a\\\|b | c\\\\\|d |`,
      ].join("\n"),
    ],
    [
      "table headers and cells flatten all line endings to spaces",
      { basis: recordBasis, rows: { columns: ["A\r\nB\rC\nD"], values: [["a\r\nb\rc\nd"]] } },
      `${recordBasis}\n\n**Answer:**\n| A B C D |\n|---|\n| a b c d |`,
    ],
    [
      "unresolved with basis",
      { basis: "Checked the requested period.", unresolved: { reason: "No matching rows." } },
      "Checked the requested period.\n\n**Answer:** unable to determine — No matching rows.",
    ],
    [
      "answer_only unresolved retains its status and hides the supplied basis",
      { answer_only: true, basis: recordBasis, unresolved: { reason: "No matching rows." } },
      "unable to determine — No matching rows.",
    ],
    [
      "two sentences and a decimal",
      { basis: "The rate is 1.25. There are two orders!", fields: [{ name: "", value: 2 }] },
      "The rate is 1.25. There are two orders!\n\n**Answer:** 2",
    ],
    [
      "unpunctuated basis",
      { basis: "From completed orders", fields: [{ name: "", value: 2 }] },
      "From completed orders\n\n**Answer:** 2",
    ],
    [
      "unused object and string fillers",
      {
        fields: [{ name: "", value: 2, units: "", precision: "" }],
        rows: {},
        unresolved: "",
        basis: recordBasis,
        readings: [],
        answer_only: "",
      },
      `${recordBasis}\n\n**Answer:** 2`,
    ],
    [
      "unused array fillers",
      {
        answer_only: true,
        fields: [],
        rows: { columns: ["Count"], values: [[2]], note: "" },
        unresolved: {},
        basis: recordBasis,
        readings: "",
      },
      "| Count |\n|---|\n| 2 |",
    ],
    [
      "whitespace-only units are absent",
      { basis: recordBasis, fields: [{ name: "", value: 2, units: " \t\r\n " }] },
      `${recordBasis}\n\n**Answer:** 2`,
    ],
    [
      "whitespace-only note is absent",
      { basis: recordBasis, rows: { columns: ["Count"], values: [[2]], note: " \t\r\n " } },
      `${recordBasis}\n\n**Answer:**\n| Count |\n|---|\n| 2 |`,
    ],
    [
      "advisory readings do not render",
      {
        basis: recordBasis,
        fields: [{ name: "", value: 2 }],
        readings: [{ clause: "month", reading: "calendar month", result_summary: "2", decided_by: "request" }],
      },
      `${recordBasis}\n\n**Answer:** 2`,
    ],
  ]

  test.each(cases)("%s", async (_name, payload, expected) => {
    expect(AnswerCommit.renderAnswer(payload)).toBe(expected)
    const tool = await initTool(AnswerCommit.AnswerCommitTool)
    expect((await tool.execute(payload, context)).output).toBe(expected)
  })
})

describe("renderAnswer strict-schema null fillers", () => {
  test.each(["precision", "units"])("null %s is absent", (key) => {
    expect(AnswerCommit.renderAnswer({ basis: recordBasis, fields: [{ name: "", value: 1.25, [key]: null }] })).toBe(
      `${recordBasis}\n\n**Answer:** 1.25`,
    )
  })

  test.each(["readings", "answer_only"])("null %s is absent", (key) => {
    expect(AnswerCommit.renderAnswer({ basis: recordBasis, fields: [{ name: "Count", value: 2 }], [key]: null })).toBe(
      `${recordBasis}\n\n**Answer:** Count: 2`,
    )
  })

  test("null note is absent", () => {
    expect(
      AnswerCommit.renderAnswer({ basis: recordBasis, rows: { columns: ["Count"], values: [[2]], note: null } }),
    ).toBe(`${recordBasis}\n\n**Answer:**\n| Count |\n|---|\n| 2 |`)
  })
})

describe("renderAnswer basis length bound", () => {
  test("accepts a two-sentence basis containing U.S. and e.g.", async () => {
    const basis = "Counted U.S. orders at order grain from orders.id. Excluded cancelled orders, e.g. pending refunds."
    const payload = { basis, fields: [{ name: "", value: 2 }] }
    const expected = `${basis}\n\n**Answer:** 2`
    expect(AnswerCommit.renderAnswer(payload)).toBe(expected)
    const tool = await initTool(AnswerCommit.AnswerCommitTool)
    expect((await tool.execute(payload, context)).output).toBe(expected)
  })

  test.each(["First. Second? Third!", "one.\ntwo.\nthree.", "One.\n\nTwo.\n\nThree."])(
    "accepts punctuation within the length bound: %s",
    (basis) => {
      expect(AnswerCommit.renderAnswer({ basis, fields: [{ name: "", value: 2 }] })).toBe(`${basis}\n\n**Answer:** 2`)
    },
  )

  test("accepts exactly 400 basis characters", async () => {
    expect(answerCommitModule.MAX_BASIS_CHARACTERS).toBe(400)
    const basis = "x".repeat(400)
    const payload = { basis, fields: [{ name: "", value: 2 }] }
    const expected = `${basis}\n\n**Answer:** 2`
    expect(AnswerCommit.renderAnswer(payload)).toBe(expected)
    const tool = await initTool(AnswerCommit.AnswerCommitTool)
    expect((await tool.execute(payload, context)).output).toBe(expected)
  })

  test.each(["x".repeat(401), ` ${"x".repeat(399)} `])(
    "rejects 401 raw basis characters with the named bound",
    async (basis) => {
      const tool = await initTool(AnswerCommit.AnswerCommitTool)
      for (const answer_only of [false, true]) {
        const payload = { basis, answer_only, fields: [{ name: "", value: 2 }] }
        expect(() => AnswerCommit.renderAnswer(payload)).toThrow(/basis.*400 characters/i)
        await rejects(tool.execute(payload, context), /basis.*400 characters/i)
      }
    },
  )
})

describe("renderAnswer structural validation", () => {
  test("optional array fillers accept only empty arrays", async () => {
    expect(
      AnswerCommit.renderAnswer({
        answer_only: true,
        fields: [{ name: "", value: 2, precision: [], units: [] }],
        basis: recordBasis,
      }),
    ).toBe("2")
    for (const filler of [[null], [0], [""], [{}], [[]]]) {
      expect(() => AnswerCommit.renderAnswer({ fields: [{ name: "", value: 2, precision: filler }] })).toThrow(
        /precision/i,
      )
      expect(() => AnswerCommit.renderAnswer({ fields: [{ name: "", value: 2, units: filler }] })).toThrow(/units/i)
      expect(() => AnswerCommit.renderAnswer({ fields: [{ name: "", value: 2 }], basis: filler })).toThrow(/basis/i)
    }

    // Empty tuples parse the same fillers but emit invalid draft 2020-12 prefixItems.
    const info = await toolInfo(AnswerCommit.AnswerCommitTool)
    const tool = await Effect.runPromise(info.init())
    const ajv = new Ajv2020({ strict: false, validateFormats: false })
    expect(ajv.validateSchema(ToolJsonSchema.fromTool({ id: info.id, ...tool }))).toBe(true)
  })

  test.each([
    ["empty value", { fields: [{ name: "Count", value: "" }] }, /fields.*value.*non-empty/i],
    ["blank value", { fields: [{ name: "Count", value: "  " }] }, /fields.*value.*non-empty/i],
    ["whitespace-only value", { fields: [{ name: "Count", value: " \t\r\n " }] }, /fields.*value.*non-empty/i],
    [
      "whitespace-only name in multiple fields",
      {
        fields: [
          { name: " \t\r\n ", value: 2 },
          { name: "Count", value: 3 },
        ],
      },
      /fields.*name.*non-empty/i,
    ],
    ["multiple values in one field", { fields: [{ name: "Count", value: [1, 2] }] }, /fields.*value.*one/i],
    ["missing value", { fields: [{ name: "Count" }] }, /fields.*value/i],
    ["null field value", { fields: [{ name: "Count", value: null }] }, /fields.*value/i],
    ["ragged rows", { rows: { columns: ["A", "B"], values: [[1, 2], [3]] } }, /rows.*1.*2.*cells/i],
    ["no columns", { rows: { columns: [], values: [[1]] } }, /rows.*columns/i],
    ["no rows", { rows: { columns: ["A"], values: [] } }, /rows.*values/i],
    ["negative precision", { fields: [{ name: "", value: 1.5, precision: -1 }] }, /precision/i],
    ["excessive precision", { fields: [{ name: "", value: 1.5, precision: 11 }] }, /precision/i],
    ["fractional precision", { fields: [{ name: "", value: 1.5, precision: 1.5 }] }, /precision/i],
    ["empty reason", { unresolved: { reason: "" } }, /unresolved.*reason/i],
    ["no answer shape", { basis: recordBasis }, /exactly one of fields, rows, or unresolved/i],
    [
      "only fillers",
      { basis: recordBasis, fields: [], rows: {}, unresolved: "" },
      /exactly one of fields, rows, or unresolved/i,
    ],
    [
      "fields and rows",
      { basis: recordBasis, fields: [{ name: "", value: 1 }], rows: { columns: ["A"], values: [[1]] } },
      /exactly one of fields, rows, or unresolved/i,
    ],
    [
      "fields and unresolved",
      { basis: recordBasis, fields: [{ name: "", value: 1 }], unresolved: { reason: "Missing" } },
      /exactly one of fields, rows, or unresolved/i,
    ],
    [
      "rows and unresolved",
      { basis: recordBasis, rows: { columns: ["A"], values: [[1]] }, unresolved: { reason: "Missing" } },
      /exactly one of fields, rows, or unresolved/i,
    ],
  ] as [string, unknown, RegExp][])("rejects %s", (_name, payload, error) => {
    expect(() => AnswerCommit.renderAnswer(payload)).toThrow(error)
  })
})

const context = {
  sessionID: "test-session",
  messageID: "test-message",
  agent: "analyst",
  abort: new AbortController().signal,
  messages: [],
}

test("answer_commit returns only the rendered answer and advisory metadata", async () => {
  const tool = await initTool(AnswerCommit.AnswerCommitTool)
  const readings = [{ clause: "month", reading: "calendar month", result_summary: "2", decided_by: "request" }]
  const asks: unknown[] = []
  const result = await tool.execute(
    { fields: [{ name: "", value: 2 }], rows: {}, unresolved: "", basis: recordBasis, readings },
    {
      ...context,
      ask: (input: unknown) => {
        asks.push(input)
      },
    },
  )
  expect(result.output).toBe(`${recordBasis}\n\n**Answer:** 2`)
  expect(result.metadata.readings).toEqual(readings)
  expect(asks).toEqual([{ permission: "answer_commit", patterns: ["*"], always: ["*"], metadata: {} }])
})

test("answer_commit exposes a serializable object input schema", async () => {
  const tool = await initTool(AnswerCommit.AnswerCommitTool)
  expect(tool.jsonSchema?.type).toBe("object")
  expect(Object.keys(tool.jsonSchema?.properties ?? {})).toEqual([
    "fields",
    "rows",
    "unresolved",
    "basis",
    "answer_only",
    "readings",
  ])
})

test("answer_commit description defines final-call timing and exact reply", async () => {
  const tool = await initTool(AnswerCommit.AnswerCommitTool)
  expect(tool.description).toContain("LAST tool call")
  expect(tool.description).toContain("once the answer is decided")
  expect(tool.description).toContain("reply with exactly the returned text and nothing else")
})

// altimate_change start - preserve every requested item in compound answers
test("answer_commit description and fields schema require one field per requested item", async () => {
  const tool = await initTool(AnswerCommit.AnswerCommitTool)
  expect(tool.description).toContain("one field per item the request asks for")
  expect(tool.description).toContain("never collapse a compound request")
  expect(structuredClone(tool.jsonSchema?.properties?.fields)).toMatchObject({
    description: "One entry per item the request asks for, in the order asked.",
  })
})
// altimate_change end

test("answer_commit description defines answer_only and unused properties", async () => {
  const tool = await initTool(AnswerCommit.AnswerCommitTool)
  expect(tool.description).toContain("only the answer or a specific format")
  expect(tool.description).toContain("exactly the value(s) or table, with no basis, field names, note, or answer label")
  expect(tool.description).toContain("Omit unused optional properties")
})

test("answer_commit description preserves the top-N boundary-tie contract", async () => {
  const tool = await initTool(AnswerCommit.AnswerCommitTool)
  expect(tool.description).toContain("When the request names N, rows.values must contain exactly N concrete rows")
  expect(tool.description).toContain("even with a tie at the top-N boundary; note the tie briefly in rows.note")
})

test("answer_commit rows schema documents the requested count and boundary-tie note", async () => {
  const tool = await initTool(AnswerCommit.AnswerCommitTool)
  // Bun's asymmetric matchers mutate nested values; preserve the shared tool schema.
  expect(structuredClone(tool.jsonSchema?.properties?.rows)).toMatchObject({
    anyOf: expect.arrayContaining([
      expect.objectContaining({
        properties: expect.objectContaining({
          values: expect.objectContaining({
            description:
              "Concrete result rows; when the request names N, the row count must equal N, even with a tie at the top-N boundary",
          }),
          note: expect.objectContaining({
            description: "Brief result note, including any tie at the top-N boundary; omitted when answer_only is true",
          }),
        }),
      }),
    ]),
  })
})

test("answer_commit description excludes JSON-schema requests", async () => {
  const tool = await initTool(AnswerCommit.AnswerCommitTool)
  expect(tool.description).toContain("not available for JSON-schema requests; use StructuredOutput instead")
})

test("answer_commit accepts null optional fields through the tool wrapper", async () => {
  const tool = await initTool(AnswerCommit.AnswerCommitTool)
  const result = await tool.execute(
    {
      fields: [{ name: "", value: 1.25, precision: null, units: null }],
      basis: recordBasis,
      readings: null,
      answer_only: null,
    },
    context,
  )
  expect(result.output).toBe(`${recordBasis}\n\n**Answer:** 1.25`)
  expect(result.metadata.readings).toEqual([])
})

test("answer_commit names invalid field values through the tool wrapper", async () => {
  const tool = await initTool(AnswerCommit.AnswerCommitTool)
  await expect(tool.execute({ fields: [{ name: "Count", value: "" }] }, context)).rejects.toThrow(
    /fields.*value.*non-empty/i,
  )
})

test("answer_commit refuses direct execution by another agent", async () => {
  const tool = await initTool(AnswerCommit.AnswerCommitTool)
  await expect(
    tool.execute({ basis: recordBasis, fields: [{ name: "", value: 2 }] }, { ...context, agent: "builder" }),
  ).rejects.toThrow(/only.*analyst/i)
})
