import { describe, test, expect, spyOn, mock, afterEach } from "bun:test"
import { listedFiles, testGapFileList, TEST_GAP_INSTRUCTION, runAiReview, type AiReviewFile } from "../../src/altimate/review/ai-review"
import { LLM } from "../../src/session/llm"
import { Provider } from "../../src/provider/provider"

const FAKE_MODEL = { providerID: "fake", id: "m", api: { npm: "x" }, cost: {} } as unknown as Provider.Model
const file = (path: string, line = 11): AiReviewFile => ({
  path,
  status: "modified",
  model: path.split("/").pop()!.replace(/\.sql$/, ""),
  diff: `@@ -${line - 1},2 +${line - 1},3 @@\n select a,\n+  b / 100 as amount,\n from t\n`,
})

describe("test-gap instruction (ALTIMATE_REVIEW_AI_TEST_GAP=1)", () => {
  afterEach(() => mock.restore())

  test("testGapFileList lists the PR's other files, not the batch's own", () => {
    const msg = testGapFileList("BODY", [file("models/fct.sql")], ["models/fct.sql", "tests/unit/test_x.py", ".github/workflows/ci.yml"])
    expect(msg).toBe(
      "BODY\n\n## OTHER FILES THIS PR CHANGES (paths only, not shown; use them to judge test coverage)\n- tests/unit/test_x.py\n- .github/workflows/ci.yml",
    )
    expect(testGapFileList("BODY", [file("models/fct.sql")], ["models/fct.sql"])).toBe("BODY")
  })

  test("under focused batching the test-gap list skips files the focused list already names", () => {
    const files = Array.from({ length: 8 }, (_, i) => file(`models/d${i}/m${i}.sql`))
    const batch = files.slice(0, 5)
    const listed = listedFiles({ files, focused: true }, batch)
    expect(listed).toEqual(files)
    const msg = testGapFileList("BODY", listed, [...files.map((f) => f.path), "tests/unit/test_x.py"])
    expect(msg).toBe("BODY\n\n## OTHER FILES THIS PR CHANGES (paths only, not shown; use them to judge test coverage)\n- tests/unit/test_x.py")
    expect(listedFiles({ files, focused: false }, batch)).toBe(batch)
  })

  test("on: the system prompt gains the instruction and the message the file list; off: neither", async () => {
    const seen: any[] = []
    spyOn(Provider, "defaultModel").mockResolvedValue({ providerID: "fake", modelID: "m" } as any)
    spyOn(Provider, "getModel").mockResolvedValue(FAKE_MODEL as any)
    spyOn(LLM, "stream").mockImplementation(async (input: any) => {
      seen.push(input)
      return {
        fullStream: (async function* () {})(),
        text: Promise.resolve("[]"),
        finishReason: Promise.resolve("stop"),
        response: Promise.resolve({ messages: [] }),
        totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
        providerMetadata: Promise.resolve(undefined),
      } as any
    })
    const input = { files: [file("models/fct.sql")], grounding: [], prFiles: ["models/fct.sql", "tests/unit/test_x.py"] }
    const prev = process.env.ALTIMATE_REVIEW_AI_TEST_GAP
    try {
      delete process.env.ALTIMATE_REVIEW_AI_TEST_GAP
      await runAiReview(input)
      process.env.ALTIMATE_REVIEW_AI_TEST_GAP = "1"
      await runAiReview(input)
    } finally {
      if (prev === undefined) delete process.env.ALTIMATE_REVIEW_AI_TEST_GAP
      else process.env.ALTIMATE_REVIEW_AI_TEST_GAP = prev
    }
    const [off, on] = seen
    expect(off.system[0]).not.toContain(TEST_GAP_INSTRUCTION)
    expect(on.system[0].endsWith(TEST_GAP_INSTRUCTION)).toBe(true)
    expect(on.system[0].slice(0, -TEST_GAP_INSTRUCTION.length)).toBe(off.system[0])
    expect(String(off.messages[0].content)).not.toContain("OTHER FILES THIS PR CHANGES")
    expect(String(on.messages[0].content)).toContain("- tests/unit/test_x.py")
  })
})
