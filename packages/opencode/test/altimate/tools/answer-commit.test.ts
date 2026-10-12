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

test("answer_commit executes synchronously with native Effect permissions", async () => {
  const info = await toolInfo(AnswerCommit.AnswerCommitTool)
  const tool = await Effect.runPromise(info.init())
  const asks: unknown[] = []
  const result = Effect.runSync(
    tool.execute(
      { fields: [{ name: "Count", value: 2 }] },
      {
        ...context,
        sessionID: SessionID.make("ses_test"),
        messageID: MessageID.make("msg_test"),
        metadata: () => Effect.void,
        ask: (input) => Effect.sync(() => void asks.push(input)),
      },
    ),
  )
  expect(result.output).toBe("**Answer:** Count: 2")
  expect(asks).toEqual([{ permission: "answer_commit", patterns: ["*"], always: ["*"], metadata: {} }])
})

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
      const fields = { fields: [{ name: "", value }] }
      const rows = { rows: { columns: ["Count"], values: [[value]] } }
      expect(AnswerCommit.renderAnswer(fields)).toBe(`**Answer:** ${value}`)
      expect((await tool.execute(fields, context)).output).toBe(`**Answer:** ${value}`)
      expect(AnswerCommit.renderAnswer(rows)).toBe(`**Answer:**\n| Count |\n|---|\n| ${value} |`)
      expect((await tool.execute(rows, context)).output).toBe(`**Answer:**\n| Count |\n|---|\n| ${value} |`)
    },
  )
})

describe("renderAnswer golden text", () => {
  const cases: [string, unknown, string][] = [
    ["single unnamed field", { fields: [{ name: "", value: "West" }] }, "**Answer:** West"],
    ["single named field", { fields: [{ name: "Region", value: "West" }] }, "**Answer:** Region: West"],
    [
      "basis and units",
      { basis: "Summed completed orders.", fields: [{ name: "Revenue", value: 42, units: "USD" }] },
      "Summed completed orders.\n\n**Answer:** Revenue: 42 USD",
    ],
    [
      "multiple fields",
      {
        fields: [
          { name: "Orders", value: 3 },
          { name: "Revenue", value: 12.5, units: "USD" },
        ],
      },
      "**Answer:** Orders: 3; Revenue: 12.5 USD",
    ],
    ["fixed numeric precision", { fields: [{ name: "Rate", value: 1.2, precision: 3 }] }, "**Answer:** Rate: 1.200"],
    ["zero precision", { fields: [{ name: "Rate", value: 1.6, precision: 0 }] }, "**Answer:** Rate: 2"],
    ["maximum precision", { fields: [{ name: "", value: 0.5, precision: 10 }] }, "**Answer:** 0.5000000000"],
    ["integers stay integers", { fields: [{ name: "", value: 7, precision: 2 }] }, "**Answer:** 7"],
    ["zero is a value", { fields: [{ name: "", value: 0, precision: 2 }] }, "**Answer:** 0"],
    ["precision leaves text intact", { fields: [{ name: "", value: "001.20", precision: 1 }] }, "**Answer:** 001.20"],
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
      "rows without basis",
      {
        rows: {
          columns: ["Region", "Orders"],
          values: [
            ["West", 3],
            ["East", 2],
          ],
        },
      },
      "**Answer:**\n| Region | Orders |\n|---|---|\n| West | 3 |\n| East | 2 |",
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
      { rows: { columns: ["Value"], values: [[null], [""]] } },
      "**Answer:**\n| Value |\n|---|\n| null |\n|  |",
    ],
    [
      "table cells preserve their boundaries",
      { rows: { columns: ["A|B"], values: [["first\nsecond|third"]] } },
      "**Answer:**\n| A\\|B |\n|---|\n| first second\\|third |",
    ],
    [
      "table headers and cells escape backslashes before pipes",
      { rows: { columns: [String.raw`A\|B`, String.raw`C\\|D`], values: [[String.raw`a\|b`, String.raw`c\\|d`]] } },
      ["**Answer:**", String.raw`| A\\\|B | C\\\\\|D |`, "|---|---|", String.raw`| a\\\|b | c\\\\\|d |`].join("\n"),
    ],
    [
      "table headers and cells flatten all line endings to spaces",
      { rows: { columns: ["A\r\nB\rC\nD"], values: [["a\r\nb\rc\nd"]] } },
      "**Answer:**\n| A B C D |\n|---|\n| a b c d |",
    ],
    [
      "unresolved without basis",
      { unresolved: { reason: "No matching rows." } },
      "**Answer:** unable to determine — No matching rows.",
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
        basis: "",
        readings: [],
        answer_only: "",
      },
      "**Answer:** 2",
    ],
    [
      "unused array fillers",
      { fields: [], rows: { columns: ["Count"], values: [[2]], note: "" }, unresolved: {}, basis: [], readings: "" },
      "**Answer:**\n| Count |\n|---|\n| 2 |",
    ],
    ["whitespace-only basis is absent", { basis: " \t\r\n ", fields: [{ name: "", value: 2 }] }, "**Answer:** 2"],
    ["whitespace-only units are absent", { fields: [{ name: "", value: 2, units: " \t\r\n " }] }, "**Answer:** 2"],
    [
      "whitespace-only note is absent",
      { rows: { columns: ["Count"], values: [[2]], note: " \t\r\n " } },
      "**Answer:**\n| Count |\n|---|\n| 2 |",
    ],
    [
      "advisory readings do not render",
      {
        fields: [{ name: "", value: 2 }],
        readings: [{ clause: "month", reading: "calendar month", result_summary: "2", decided_by: "request" }],
      },
      "**Answer:** 2",
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
    expect(AnswerCommit.renderAnswer({ fields: [{ name: "", value: 1.25, [key]: null }] })).toBe("**Answer:** 1.25")
  })

  test.each(["basis", "readings", "answer_only"])("null %s is absent", (key) => {
    expect(AnswerCommit.renderAnswer({ fields: [{ name: "Count", value: 2 }], [key]: null })).toBe(
      "**Answer:** Count: 2",
    )
  })

  test("null note is absent", () => {
    expect(AnswerCommit.renderAnswer({ rows: { columns: ["Count"], values: [[2]], note: null } })).toBe(
      "**Answer:**\n| Count |\n|---|\n| 2 |",
    )
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
    expect(AnswerCommit.renderAnswer({ fields: [{ name: "", value: 2, precision: [], units: [] }], basis: [] })).toBe(
      "**Answer:** 2",
    )
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
    ["whitespace-only name", { fields: [{ name: " \t\r\n ", value: 2 }] }, /fields.*name.*non-empty/i],
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
    { fields: [{ name: "", value: 2 }], rows: {}, unresolved: "", basis: "", readings },
    {
      ...context,
      ask: (input: unknown) => {
        asks.push(input)
      },
    },
  )
  expect(result.output).toBe("**Answer:** 2")
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
  expect(tool.jsonSchema?.properties?.rows).toMatchObject({
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
      basis: null,
      readings: null,
      answer_only: null,
    },
    context,
  )
  expect(result.output).toBe("**Answer:** 1.25")
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
  await expect(tool.execute({ fields: [{ name: "", value: 2 }] }, { ...context, agent: "builder" })).rejects.toThrow(
    /only.*analyst/i,
  )
})
