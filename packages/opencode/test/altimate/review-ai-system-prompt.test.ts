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
    // The review's repository: a temp git repo, so the test does not depend on running inside a checkout.
    await using repo = await tmpdir({ git: true })
    const file = path.join(tmp.path, "p.txt")
    await fs.writeFile(file, "FILE PROMPT")
    spy = spyOn(Dispatcher, "call").mockResolvedValue({ success: true, data: { prompt: "CORE" } } as any)
    expect(await finderSystemPrompt({ ALTIMATE_REVIEW_AI_SYSTEM_PROMPT_FILE: file }, repo.path)).toBe("FILE PROMPT")
    expect(spy).not.toHaveBeenCalled()
  })

  test("an empty or missing file is an error, not a fallback", async () => {
    await using tmp = await tmpdir()
    await using repo = await tmpdir({ git: true })
    const file = path.join(tmp.path, "empty.txt")
    await fs.writeFile(file, "  \n")
    await expect(finderSystemPrompt({ ALTIMATE_REVIEW_AI_SYSTEM_PROMPT_FILE: file }, repo.path)).rejects.toThrow("is empty")
    await expect(finderSystemPrompt({ ALTIMATE_REVIEW_AI_SYSTEM_PROMPT_FILE: path.join(tmp.path, "none.txt") }, repo.path)).rejects.toThrow()
  })

  test("a relative path is refused: it would resolve inside the PR checkout", async () => {
    spy = spyOn(Dispatcher, "call").mockResolvedValue({ success: true, data: { prompt: "CORE" } } as any)
    await expect(finderSystemPrompt({ ALTIMATE_REVIEW_AI_SYSTEM_PROMPT_FILE: "review-prompt.md" })).rejects.toThrow("absolute path")
    expect(spy).not.toHaveBeenCalled()
  })

  test("a file inside the git work tree, or a symlink to one, is refused", async () => {
    await using repo = await tmpdir({ git: true })
    await using outside = await tmpdir()
    const inside = path.join(repo.path, ".github", "review-prompt.md")
    await fs.mkdir(path.dirname(inside), { recursive: true })
    await fs.writeFile(inside, "PR PROMPT")
    const link = path.join(outside.path, "link.md")
    await fs.symlink(inside, link)
    for (const file of [inside, link])
      await expect(finderSystemPrompt({ ALTIMATE_REVIEW_AI_SYSTEM_PROMPT_FILE: file }, repo.path)).rejects.toThrow("inside the git work tree")
    // The same text outside the work tree is read.
    const ok = path.join(outside.path, "p.md")
    await fs.writeFile(ok, "RUNNER PROMPT")
    expect(await finderSystemPrompt({ ALTIMATE_REVIEW_AI_SYSTEM_PROMPT_FILE: ok }, repo.path)).toBe("RUNNER PROMPT")
  })

  test("a file whose name starts with `..` inside the review's repository is refused", async () => {
    await using repo = await tmpdir({ git: true })
    const file = path.join(repo.path, "..p.md")
    await fs.writeFile(file, "PR PROMPT")
    await expect(finderSystemPrompt({ ALTIMATE_REVIEW_AI_SYSTEM_PROMPT_FILE: file }, repo.path)).rejects.toThrow("inside the git work tree")
  })

  test("fails closed when neither the review's directory nor the process's resolves to a work tree", async () => {
    await using repo = await tmpdir({ git: true })
    await using elsewhere = await tmpdir()
    const file = path.join(repo.path, "p.md")
    await fs.writeFile(file, "PR PROMPT")
    const cwd = process.cwd()
    process.chdir(elsewhere.path)
    try {
      await expect(finderSystemPrompt({ ALTIMATE_REVIEW_AI_SYSTEM_PROMPT_FILE: file })).rejects.toThrow("refusing it")
      // The review's repository is checked even when the process runs elsewhere.
      await expect(finderSystemPrompt({ ALTIMATE_REVIEW_AI_SYSTEM_PROMPT_FILE: file }, repo.path)).rejects.toThrow("inside the git work tree")
    } finally {
      process.chdir(cwd)
    }
  })

  test("runReview hands the lane the review's repository", async () => {
    const { runReview } = await import("../../src/altimate/review/orchestrate")
    const { DEFAULT_REVIEW_CONFIG } = await import("../../src/altimate/review/config")
    const { DEFAULT_RUBRIC } = await import("../../src/altimate/review/rubric")
    let seen: any
    await runReview({
      changedFiles: [{ path: "models/m.sql", status: "modified", diff: "@@ -1 +1 @@\n-select 1\n+select 2\n" }],
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner: { async impact() { return { hasManifest: false } }, async grade() { return { grade: "B" } }, async check() { return { issues: [], ran: true } }, async equivalence() { return { decided: true, equivalent: true } }, async detectPii() { return { columns: [] } } } as any,
      forceTier: "full",
      reviewDir: "/repo/root",
      getContent: async () => "select 2",
      generatedAt: "2026-11-27T00:00:00Z",
      aiReview: async (input: any) => {
        seen = input
        return { findings: [], status: { state: "ok" } }
      },
    } as any)
    expect(seen.reviewDir).toBe("/repo/root")
  })
})
