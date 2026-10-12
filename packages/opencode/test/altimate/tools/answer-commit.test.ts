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
  test.each([undefined, false, "false", 0, null, "", [], {}].map((value) => [value]))(
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
    "answer_only allows absent basis %j",
    async (basis) => {
      const payload = { answer_only: "true", fields: [{ name: "Count", value: 2 }], basis }
      expect(AnswerCommit.renderAnswer(payload)).toBe("2")
      const tool = await initTool(AnswerCommit.AnswerCommitTool)
      expect((await tool.execute(payload, context)).output).toBe("2")
    },
  )

  test("description and schema explain the basis requirement and attribution source", async () => {
    const tool = await initTool(AnswerCommit.AnswerCommitTool)
    expect(tool.description).toContain("basis is required unless answer_only is true")
    expect(tool.description).toContain(
      "one or two sentences naming population, grain, the source object/column that supplies the requested entity or value, and caveats",
    )
    expect(tool.description).toContain(
      "Resolve policy eligibility separately from metric and entity attribution: a rule about a related object does not change which object supplies the requested entity. Say in `basis` which source object and column supply it.",
    )
    expect(structuredClone(tool.jsonSchema?.properties?.basis)).toMatchObject({
      description: expect.stringMatching(
        /required unless answer_only.*population.*grain.*source object\/column.*caveats/i,
      ),
    })
  })
})

describe("answer_commit validation repair", () => {
  test.each([
    ["invalid boolean", { answer_only: "yes", fields: [{ name: "", value: 2 }] }, /answer_only/],
    ["missing basis", { fields: [{ name: "", value: 2 }] }, /basis/],
    ["missing value", { fields: [{ name: "Count" }] }, /fields.*value/],
    ["missing shape", {}, /fields, rows, or unresolved/],
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

describe("answer_commit numeric safety", () => {
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

  test.each([Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 1.25, "9007199254740993", "-9007199254740993"])(
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
        basis: "This basis is omitted.",
        answer_only: true,
        fields: [{ name: "Revenue", value: 1.2, units: "USD", precision: 2 }],
      },
      "1.20 USD",
    ],
    [
      "answer_only multiple fields",
      {
        answer_only: true,
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
      "answer_only unresolved without basis",
      { answer_only: true, unresolved: { reason: "No matching rows." } },
      "unable to determine — No matching rows.",
    ],
    [
      "unresolved with basis",
      { basis: "Checked the requested period.", unresolved: { reason: "No matching rows." } },
      "Checked the requested period.\n\n**Answer:** unable to determine — No matching rows.",
    ],
    [
      "answer_only unresolved retains its status without a label or basis",
      { answer_only: true, basis: "Checked the requested period.", unresolved: { reason: "No matching rows." } },
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
        basis: [],
        readings: "",
      },
      "| Count |\n|---|\n| 2 |",
    ],
    [
      "whitespace-only basis is absent with answer_only",
      { answer_only: true, basis: " \t\r\n ", fields: [{ name: "", value: 2 }] },
      "2",
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

  test("null basis is absent with answer_only", () => {
    expect(AnswerCommit.renderAnswer({ answer_only: true, fields: [{ name: "Count", value: 2 }], basis: null })).toBe(
      "2",
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

describe("renderAnswer basis sentence boundaries", () => {
  test.each(["e.g.", "i.e.", "etc.", "Dr.", "vs.", "approx."])("does not count %s as a sentence end", (word) => {
    const basis = `Used ${word} Completed orders. Count is 2.`
    expect(AnswerCommit.renderAnswer({ basis, fields: [{ name: "", value: 2 }] })).toBe(`${basis}\n\n**Answer:** 2`)
  })

  test("does not count decimals as sentence ends", () => {
    const basis = "The mean is 3.5 and the median is 2.5. Count is 2."
    expect(AnswerCommit.renderAnswer({ basis, fields: [{ name: "", value: 2 }] })).toBe(`${basis}\n\n**Answer:** 2`)
  })

  test("punctuation followed by lowercase text counts as a sentence boundary", () => {
    const basis = "Count? maybe! still checking. Count is 2."
    expect(() => AnswerCommit.renderAnswer({ basis, fields: [{ name: "", value: 2 }] })).toThrow(/basis.*2 sentences/i)
  })

  test("caps lowercase sentences separated by newlines", () => {
    expect(() => AnswerCommit.renderAnswer({ basis: "one.\ntwo.\nthree.", fields: [{ name: "", value: 2 }] })).toThrow(
      /basis.*2 sentences/i,
    )
  })

  test.each(["2 orders", '"two orders"'])("counts sentence boundaries before %s", (next) => {
    const basis = `First. ${next}. Third.`
    expect(() => AnswerCommit.renderAnswer({ basis, fields: [{ name: "", value: 2 }] })).toThrow(/basis.*2 sentences/i)
  })

  test.each([".", "?", "!"])("caps sentences separated by %s and uppercase text", (punctuation) => {
    const basis = `First${punctuation} Second${punctuation} Third${punctuation}`
    expect(() => AnswerCommit.renderAnswer({ basis, fields: [{ name: "", value: 2 }] })).toThrow(/basis.*2 sentences/i)
  })

  test("abbreviations and decimals do not hide a third sentence", () => {
    expect(() =>
      AnswerCommit.renderAnswer({
        basis: "Used e.g. Orders. Mean is 3.5. Count is 2.",
        fields: [{ name: "", value: 2 }],
      }),
    ).toThrow(/basis.*2 sentences/i)
  })

  test("paragraph breaks count as sentence boundaries", () => {
    expect(() =>
      AnswerCommit.renderAnswer({ basis: "One.\n\nTwo.\n\nThree.", fields: [{ name: "", value: 2 }] }),
    ).toThrow(/basis.*2 sentences/i)
  })
})

describe("renderAnswer structural validation", () => {
  test("optional array fillers accept only empty arrays", async () => {
    expect(
      AnswerCommit.renderAnswer({
        answer_only: true,
        fields: [{ name: "", value: 2, precision: [], units: [] }],
        basis: [],
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
    ["three sentences", { basis: "First. Second? Third!", fields: [{ name: "", value: 1 }] }, /basis.*2 sentences/i],
    [
      "unpunctuated third sentence",
      { basis: "First. Second! Third", fields: [{ name: "", value: 1 }] },
      /basis.*2 sentences/i,
    ],
    ["negative precision", { fields: [{ name: "", value: 1.5, precision: -1 }] }, /precision/i],
    ["excessive precision", { fields: [{ name: "", value: 1.5, precision: 11 }] }, /precision/i],
    ["fractional precision", { fields: [{ name: "", value: 1.5, precision: 1.5 }] }, /precision/i],
    ["empty reason", { unresolved: { reason: "" } }, /unresolved.*reason/i],
    ["no answer shape", {}, /exactly one of fields, rows, or unresolved/i],
    ["only fillers", { fields: [], rows: {}, unresolved: "" }, /exactly one of fields, rows, or unresolved/i],
    [
      "fields and rows",
      { fields: [{ name: "", value: 1 }], rows: { columns: ["A"], values: [[1]] } },
      /exactly one of fields, rows, or unresolved/i,
    ],
    [
      "fields and unresolved",
      { fields: [{ name: "", value: 1 }], unresolved: { reason: "Missing" } },
      /exactly one of fields, rows, or unresolved/i,
    ],
    [
      "rows and unresolved",
      { rows: { columns: ["A"], values: [[1]] }, unresolved: { reason: "Missing" } },
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

test("answer_commit description gives the user output schema precedence", async () => {
  const tool = await initTool(AnswerCommit.AnswerCommitTool)
  expect(tool.description).toContain("not automatically removed when a user output schema is set")
  expect(tool.description).toContain("the user schema takes precedence")
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
