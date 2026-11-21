import { describe, test, expect } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { gitCommandUsesNetwork } from "@opencode-ai/core/git"
import { git } from "../../src/util/git"

describe("git() utility", () => {
  test("runs a simple git command and returns stdout", async () => {
    await using tmp = await tmpdir({ git: true })

    const result = await git(["rev-parse", "--is-inside-work-tree"], { cwd: tmp.path })
    expect(result.exitCode).toBe(0)
    expect(result.text().trim()).toBe("true")
  })

  test("returns non-zero exit code for unknown git subcommand", async () => {
    await using tmp = await tmpdir({ git: true })

    const result = await git(["not-a-real-subcommand"], { cwd: tmp.path })
    expect(result.exitCode).not.toBe(0)
  })

  test("stderr is populated on error", async () => {
    await using tmp = await tmpdir({ git: true })

    const result = await git(["checkout", "nonexistent-branch-xyz"], { cwd: tmp.path })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.length).toBeGreaterThan(0)
  })

  test("passes custom env vars through to git process", async () => {
    await using tmp = await tmpdir({ git: true })

    // Use GIT_CONFIG_COUNT to inject a config value that only exists via env
    const result = await git(["config", "--get", "test.injected"], {
      cwd: tmp.path,
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "test.injected",
        GIT_CONFIG_VALUE_0: "from-env",
      },
    })
    expect(result.exitCode).toBe(0)
    expect(result.text().trim()).toBe("from-env")
  })

  test("returns exitCode 1 and empty stdout when cwd does not exist", async () => {
    const result = await git(["status"], { cwd: "/tmp/nonexistent-dir-" + Math.random().toString(36) })
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout.length).toBe(0)
  })

  // altimate_change start — offline mode refuses remote Git commands and keeps local ones
  test("offline refuses remote commands without spawning git and still runs local ones", async () => {
    await using tmp = await tmpdir({ git: true })
    const previous = process.env.ALTIMATE_OFFLINE
    process.env.ALTIMATE_OFFLINE = "1"
    try {
      const fetched = await git(["fetch", "origin"], { cwd: tmp.path })
      expect(fetched.exitCode).toBe(1)
      expect(fetched.stdout.length).toBe(0)
      expect(fetched.stderr.toString()).toContain("Git remote operations require an online run.")
      const local = await git(["rev-parse", "--is-inside-work-tree"], { cwd: tmp.path })
      expect(local.text().trim()).toBe("true")
    } finally {
      if (previous === undefined) delete process.env.ALTIMATE_OFFLINE
      else process.env.ALTIMATE_OFFLINE = previous
    }
  })

  test("offline treats submodule clones, LFS transfers and remote archives as network commands", () => {
    for (const args of [["submodule", "update", "--init"], ["submodule", "update", "--recursive", "--no-fetch"], ["submodule", "add", "url"], ["remote", "add", "-f", "o", "url"], ["lfs", "fetch"], ["lfs", "pull"], ["archive", "--remote=origin", "HEAD"], ["-C", "x", "fetch"]])
      expect(gitCommandUsesNetwork(args)).toBe(true)
    for (const args of [["submodule", "foreach", "git", "status"], ["remote", "add", "o", "url"], ["lfs", "ls-files"], ["archive", "HEAD"], ["status"], ["remote", "show", "-n", "origin"]])
      expect(gitCommandUsesNetwork(args)).toBe(false)
  })
  // altimate_change end
})
