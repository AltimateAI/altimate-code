// altimate_change - new file
import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../../fixture/fixture"

const entry = path.resolve(import.meta.dir, "../../../src/index.ts")

async function run(cwd: string, args: string[], preload?: string) {
  const child = Bun.spawn(["bun", "run", "--conditions=browser", ...(preload ? ["--preload", preload] : []), entry, "learn", "import-reviews", ...args], {
    cwd,
    env: { ...process.env, ALTIMATE_DISABLE_TELEMETRY: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", NO_COLOR: "1", ALTIMATE_LEARN_MODEL: "" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { stdout, stderr, code }
}

/** Keep parsing, project config and model choice real; inspect the import boundary without calling GitHub or a model. */
async function fixture(cwd: string, failures = 0) {
  const file = path.join(cwd, "review-import-preload.ts")
  const module = JSON.stringify(path.resolve(import.meta.dir, "../../../src/altimate/learn/import-reviews.ts"))
  await fs.writeFile(file, `
import { mock } from "bun:test"
mock.module(${module}, () => ({
  importReviews: async (options, deps) => {
    const model = await deps.resolveModel()
    deps.out("IMPORT_OPTIONS: " + JSON.stringify({ options, model: model.providerID + "/" + model.modelID, isTTY: deps.isTTY }))
    return { failures: ${failures} }
  },
}))
`)
  return file
}

function imported(stdout: string) {
  const line = stdout.split("\n").find((line) => line.startsWith("IMPORT_OPTIONS: "))
  expect(line).toBeDefined()
  return JSON.parse(line!.slice("IMPORT_OPTIONS: ".length))
}

describe("learn import-reviews CLI", () => {
  test("help documents access, bot filters, consent and limits", async () => {
    await using dir = await tmpdir({ git: true })
    const result = await run(dir.path, ["--help"])
    expect(result.code).toBe(0)
    const help = (result.stdout + result.stderr).replace(/\s+/g, " ")
    for (const text of ["--repo", "--since", "--limit", "--include-bots", "--bots", "--model", "--yes", "--dry-run", "--max-reflections", "GitHub Enterprise", "learn.review_bots", "redacted review comments", "learn promote"])
      expect(help).toContain(text)
  }, 60_000)

  test("defaults and config model reach the importer without resolving a provider", async () => {
    await using dir = await tmpdir({ git: true, config: { learn: { model: "unconfigured/model" } } })
    const result = await run(dir.path, [], await fixture(dir.path))
    expect(result.code).toBe(0)
    expect(imported(result.stdout)).toEqual({
      options: {
        root: dir.path, name: "team-playbook", since: "30d", limit: 50,
        includeBots: false, maxReflections: 20, maxStored: 1000, yes: false, dryRun: false,
      },
      model: "unconfigured/model", isTTY: false,
    })
  }, 60_000)

  test("passes flags, configured bots and the explicit model override", async () => {
    await using dir = await tmpdir({ git: true })
    await fs.writeFile(path.join(dir.path, "opencode.json"), JSON.stringify({ learn: {
      model: "config/model", review_bots: ["team-review-bot", "second-reviewer"], max_stored: 17,
    } }))
    const result = await run(dir.path, [
      "--name", "custom", "--repo", "owner/repository", "--since", "14d", "--limit", "7",
      "--include-bots", "--bots", " cli-bot ,another-bot,", "--model", "explicit/model",
      "--yes", "--dry-run", "--max-reflections", "3",
    ], await fixture(dir.path))
    expect(result.code).toBe(0)
    expect(imported(result.stdout)).toEqual({
      options: {
        root: dir.path, name: "custom", repo: "owner/repository", since: "14d", limit: 7,
        includeBots: true, bots: ["cli-bot", "another-bot"], reviewBots: ["team-review-bot", "second-reviewer"],
        maxReflections: 3, maxStored: 17, yes: true, dryRun: true,
      },
      model: "explicit/model", isTTY: false,
    })
  }, 60_000)

  test("rejects invalid model syntax before import", async () => {
    await using dir = await tmpdir({ git: true })
    const result = await run(dir.path, ["--model", "invalid", "--dry-run"], await fixture(dir.path))
    expect(result.code).not.toBe(0)
    expect(result.stdout + result.stderr).toContain("Invalid model (expected provider/model)")
    expect(result.stdout).not.toContain("IMPORT_OPTIONS:")
  }, 60_000)

  test("rejects a non-array review_bots config instead of dropping it", async () => {
    await using dir = await tmpdir({ git: true })
    await fs.writeFile(path.join(dir.path, "opencode.json"), JSON.stringify({ learn: { review_bots: "team-review-bot" } }))
    const result = await run(dir.path, ["--model", "fake/model", "--dry-run"], await fixture(dir.path))
    expect(result.code).not.toBe(0)
    expect(result.stdout + result.stderr).toContain("review_bots")
    expect(result.stdout).not.toContain("IMPORT_OPTIONS:")
  }, 60_000)

  test("reflection failures return a failing exit code with continuation guidance", async () => {
    await using dir = await tmpdir({ git: true })
    const result = await run(dir.path, ["--model", "fake/model", "--yes"], await fixture(dir.path, 1))
    expect(result.code).not.toBe(0)
    expect(result.stdout + result.stderr).toContain("Review reflection failed; signals remain queued")
    expect(result.stdout + result.stderr).toContain("learn import-reviews")
  }, 60_000)
})
