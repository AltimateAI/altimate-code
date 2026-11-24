import { describe, test, expect, spyOn, afterEach } from "bun:test"
import path from "node:path"
import { promises as fs } from "node:fs"
import { finderSystemPrompt } from "../../src/altimate/review/ai-review"
import { Dispatcher } from "../../src/altimate/native"
import { tmpdir } from "../fixture/fixture"

describe("ALTIMATE_REVIEW_AI_SYSTEM_PROMPT_FILE", () => {
  let spy: ReturnType<typeof spyOn> | undefined
  afterEach(() => spy?.mockRestore())

  test("unset: the core prompt", async () => {
    spy = spyOn(Dispatcher, "call").mockResolvedValue({ success: true, data: { prompt: "CORE" } } as any)
    expect(await finderSystemPrompt({})).toBe("CORE")
    expect(spy).toHaveBeenCalledWith("altimate_core.review_ai_prompt", {})
  })

  test("set: the file's text replaces the core prompt, core not asked", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "p.txt")
    await fs.writeFile(file, "FILE PROMPT")
    spy = spyOn(Dispatcher, "call").mockResolvedValue({ success: true, data: { prompt: "CORE" } } as any)
    expect(await finderSystemPrompt({ ALTIMATE_REVIEW_AI_SYSTEM_PROMPT_FILE: file })).toBe("FILE PROMPT")
    expect(spy).not.toHaveBeenCalled()
  })

  test("an empty or missing file is an error, not a fallback", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "empty.txt")
    await fs.writeFile(file, "  \n")
    await expect(finderSystemPrompt({ ALTIMATE_REVIEW_AI_SYSTEM_PROMPT_FILE: file })).rejects.toThrow("is empty")
    await expect(finderSystemPrompt({ ALTIMATE_REVIEW_AI_SYSTEM_PROMPT_FILE: path.join(tmp.path, "none.txt") })).rejects.toThrow()
  })
})
