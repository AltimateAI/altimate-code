import { describe, test, expect, spyOn, afterEach } from "bun:test"
import path from "node:path"
import os from "node:os"
import { promises as fs, existsSync, mkdtempSync, rmSync } from "node:fs"
import { finderSystemPrompt } from "../../src/altimate/review/ai-review"
import { Dispatcher } from "../../src/altimate/native"
import { tmpdir } from "../fixture/fixture"

// Whether the temp directory's file system ignores case: a probe directory is found under its upper-case name.
const caseSensitiveTmp = (() => {
  const probe = mkdtempSync(path.join(os.tmpdir(), "case-probe-"))
  try {
    return !existsSync(path.join(path.dirname(probe), path.basename(probe).toUpperCase()))
  } finally {
    rmSync(probe, { recursive: true, force: true })
  }
})()

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

  test("a path inside the work tree is refused even when it is a symlink to a file outside", async () => {
    await using repo = await tmpdir({ git: true })
    await using outside = await tmpdir()
    const target = path.join(outside.path, "p.md")
    await fs.writeFile(target, "RUNNER FILE")
    // The PR commits the configured path as a link to a file outside the checkout.
    const fileLink = path.join(repo.path, "review-prompt.md")
    await fs.symlink(target, fileLink)
    // ...or links a directory on the configured path to a directory outside.
    const dirLink = path.join(repo.path, "prompts")
    await fs.symlink(outside.path, dirLink)
    for (const file of [fileLink, path.join(dirLink, "p.md")])
      await expect(finderSystemPrompt({ ALTIMATE_REVIEW_AI_SYSTEM_PROMPT_FILE: file }, repo.path)).rejects.toThrow("inside the git work tree")
  })

  test("an outside alias that resolves through a link in the work tree and back out is refused", async () => {
    await using repo = await tmpdir({ git: true })
    await using outside = await tmpdir()
    const targetDir = path.join(outside.path, "target")
    await fs.mkdir(targetDir)
    await fs.writeFile(path.join(targetDir, "p.md"), "RUNNER FILE")
    // The PR controls `repo/hop`, which points back outside; the configured alias points at it.
    await fs.symlink(targetDir, path.join(repo.path, "hop"))
    const alias = path.join(outside.path, "alias")
    await fs.symlink(path.join(repo.path, "hop"), alias)
    // A relative link through the work tree is followed the same way.
    const relAlias = path.join(outside.path, "rel-alias")
    await fs.symlink(path.relative(outside.path, path.join(repo.path, "hop")), relAlias)
    for (const file of [path.join(alias, "p.md"), path.join(relAlias, "p.md")])
      await expect(finderSystemPrompt({ ALTIMATE_REVIEW_AI_SYSTEM_PROMPT_FILE: file }, repo.path)).rejects.toThrow("inside the git work tree")
    // The same file named directly is read.
    expect(await finderSystemPrompt({ ALTIMATE_REVIEW_AI_SYSTEM_PROMPT_FILE: path.join(targetDir, "p.md") }, repo.path)).toBe("RUNNER FILE")
  })

  // Only a case-insensitive file system (macOS, Windows) resolves the other spelling; elsewhere the test is skipped.
  test.skipIf(caseSensitiveTmp)("a work tree spelled in another case (case-insensitive file systems) is still found", async () => {
    await using repo = await tmpdir({ git: true })
    await using outside = await tmpdir()
    const variant = path.join(path.dirname(repo.path), path.basename(repo.path).toUpperCase())
    expect(variant).not.toBe(repo.path)
    expect(await fs.stat(variant).then(() => true, () => false)).toBe(true)
    const targetDir = path.join(outside.path, "d2")
    await fs.mkdir(targetDir)
    await fs.writeFile(path.join(targetDir, "f"), "RUNNER FILE")
    await fs.symlink(targetDir, path.join(repo.path, "link"))
    // The in-tree link named through the other spelling of the work tree...
    const direct = path.join(variant, "link", "f")
    // ...and an outside alias whose target is written in the other spelling.
    const alias = path.join(outside.path, "aliasCase")
    await fs.symlink(path.join(variant, "link"), alias)
    for (const file of [direct, path.join(alias, "f")])
      await expect(finderSystemPrompt({ ALTIMATE_REVIEW_AI_SYSTEM_PROMPT_FILE: file }, repo.path)).rejects.toThrow("inside the git work tree")
  })

  test("a symlink loop is refused", async () => {
    await using repo = await tmpdir({ git: true })
    await using outside = await tmpdir()
    const a = path.join(outside.path, "a")
    const b = path.join(outside.path, "b")
    await fs.symlink(b, a)
    await fs.symlink(a, b)
    await expect(finderSystemPrompt({ ALTIMATE_REVIEW_AI_SYSTEM_PROMPT_FILE: a }, repo.path)).rejects.toThrow(
      "ALTIMATE_REVIEW_AI_SYSTEM_PROMPT_FILE",
    )
  })

  test("a nested checkout does not hide the enclosing work tree", async () => {
    await using repo = await tmpdir({ git: true })
    const nested = path.join(repo.path, "vendor", "dbt")
    await fs.mkdir(path.join(nested, ".git"), { recursive: true })
    const file = path.join(repo.path, "review-prompt.md")
    await fs.writeFile(file, "PR PROMPT")
    const cwd = process.cwd()
    process.chdir(nested)
    try {
      // The error names the enclosing work tree the file was found in.
      const outer = await fs.realpath(repo.path)
      await expect(finderSystemPrompt({ ALTIMATE_REVIEW_AI_SYSTEM_PROMPT_FILE: file }, nested)).rejects.toThrow(
        `inside the git work tree ${outer};`,
      )
    } finally {
      process.chdir(cwd)
    }
  })

  test("a missing file is an error naming the variable", async () => {
    await using tmp = await tmpdir()
    await using repo = await tmpdir({ git: true })
    await expect(
      finderSystemPrompt({ ALTIMATE_REVIEW_AI_SYSTEM_PROMPT_FILE: path.join(tmp.path, "none.txt") }, repo.path),
    ).rejects.toThrow("ALTIMATE_REVIEW_AI_SYSTEM_PROMPT_FILE")
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
