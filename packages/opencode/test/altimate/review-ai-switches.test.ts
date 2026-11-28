import { describe, test, expect } from "bun:test"
import path from "node:path"
import os from "node:os"
import { promises as fs } from "node:fs"
import { execFileSync } from "node:child_process"
import { AI_SWITCH_DEFAULTS, AI_SWITCH_ENV, envSwitch, resolveAiSwitches, switchOn } from "../../src/altimate/review/ai-switches"
import { DEFAULT_REVIEW_CONFIG, aiLaneEnabled, parseReviewConfig, policyHash } from "../../src/altimate/review/config"
import { aiInputBudget } from "../../src/altimate/review/ai-review"

describe("AI switches", () => {
  test("env 1/0 override, anything else defers", () => {
    expect(envSwitch("coverage", { ALTIMATE_REVIEW_AI_COVERAGE: "1" })).toBe(true)
    expect(envSwitch("coverage", { ALTIMATE_REVIEW_AI_COVERAGE: "0" })).toBe(false)
    expect(envSwitch("coverage", { ALTIMATE_REVIEW_AI_COVERAGE: "maybe" })).toBeUndefined()
    expect(envSwitch("coverage", { ALTIMATE_REVIEW_AI_COVERAGE: "" })).toBeUndefined()
    expect(envSwitch("coverage", {})).toBeUndefined()
  })

  test("common boolean spellings are accepted, so `=false` still turns a switch off", () => {
    for (const v of ["true", "TRUE", "on", "yes", " 1 "]) expect(envSwitch("verify", { ALTIMATE_REVIEW_AI_VERIFY: v })).toBe(true)
    for (const v of ["false", "False", "off", "no", "0"]) expect(envSwitch("verify", { ALTIMATE_REVIEW_AI_VERIFY: v })).toBe(false)
    expect(resolveAiSwitches({ ai: true }, { ALTIMATE_REVIEW_AI_VERIFY: "false" }).verify).toBe(false)
  })

  test("a value that is not a boolean is ignored with a warning naming the variable", () => {
    const write0 = process.stderr.write
    let err = ""
    ;(process.stderr as any).write = (s: string) => ((err += s), true)
    try {
      expect(resolveAiSwitches({ ai: true }, { ALTIMATE_REVIEW_AI_VERIFY: "disabled" }).verify).toBe(true)
    } finally {
      ;(process.stderr as any).write = write0
    }
    expect(err).toContain("ALTIMATE_REVIEW_AI_VERIFY=disabled")
  })

  test("env wins over config, config over the default", () => {
    const cfg = { ai: { coverage: true, focused: false } }
    expect(resolveAiSwitches(cfg, {}).coverage).toBe(true)
    expect(resolveAiSwitches(cfg, { ALTIMATE_REVIEW_AI_COVERAGE: "0" }).coverage).toBe(false)
    expect(resolveAiSwitches(cfg, { ALTIMATE_REVIEW_AI_FOCUSED: "1" }).focused).toBe(true)
    expect(resolveAiSwitches({ ai: true }, {})).toEqual(AI_SWITCH_DEFAULTS)
  })

  test("without resolved switches only the env variable counts", () => {
    expect(switchOn("verify", undefined, {})).toBe(false)
    expect(switchOn("verify", undefined, { ALTIMATE_REVIEW_AI_VERIFY: "1" })).toBe(true)
    expect(switchOn("verify", { verify: false }, { ALTIMATE_REVIEW_AI_VERIFY: "1" })).toBe(false)
  })

  test("every switch has an env variable", () => {
    expect(Object.keys(AI_SWITCH_ENV).sort()).toEqual(Object.keys(AI_SWITCH_DEFAULTS).sort())
  })

  test("the input budget follows the switches", () => {
    expect(aiInputBudget({}, { coverage: true }).coverage).toBeDefined()
    expect(aiInputBudget({}, { coverage: false }).coverage).toBeUndefined()
    expect(aiInputBudget({ ALTIMATE_REVIEW_AI_FOCUSED: "1" }).focused).toBeDefined()
    expect(aiInputBudget({}, { focused: true }).focused).toBeDefined()
  })
})

describe("`ai:` in .altimate/review.yml", () => {
  test("boolean and object forms", () => {
    expect(aiLaneEnabled(parseReviewConfig("ai: false"))).toBe(false)
    expect(aiLaneEnabled(parseReviewConfig("ai: true"))).toBe(true)
    expect(aiLaneEnabled(parseReviewConfig("ai:\n  enabled: false"))).toBe(false)
    const cfg = parseReviewConfig("ai:\n  coverage: false\n  verify: true")
    expect(aiLaneEnabled(cfg)).toBe(true)
    expect(resolveAiSwitches(cfg, {}).verify).toBe(true)
    expect(resolveAiSwitches(cfg, {}).coverage).toBe(false)
  })

  test("the default policy hash is unchanged by the object form", () => {
    expect(DEFAULT_REVIEW_CONFIG.ai).toBe(true)
    expect(policyHash(parseReviewConfig("mode: comment"))).toBe(policyHash(DEFAULT_REVIEW_CONFIG))
    // The object form hashes as written: an empty object or a set switch is a different policy.
    const empty = parseReviewConfig("ai: {}")
    expect(aiLaneEnabled(empty)).toBe(true)
    expect(resolveAiSwitches(empty, {})).toEqual(AI_SWITCH_DEFAULTS)
    expect(policyHash(parseReviewConfig("ai:\n  verify: false"))).not.toBe(policyHash(DEFAULT_REVIEW_CONFIG))
  })

  test("an unknown key under `ai:` fails the load and names the key", () => {
    expect(() => parseReviewConfig("ai:\n  enable: false")).toThrow(/unrecognized_keys[\s\S]*"enable"/)
  })
})

describe("ignored env values (round 2)", () => {
  test("the warning for one value is written once per process, not once per project", () => {
    const write0 = process.stderr.write
    let err = ""
    ;(process.stderr as any).write = (s: string) => ((err += s), true)
    try {
      resolveAiSwitches({ ai: true }, { ALTIMATE_REVIEW_AI_FOCUSED: "sometimes" })
      resolveAiSwitches({ ai: true }, { ALTIMATE_REVIEW_AI_FOCUSED: "sometimes" })
    } finally {
      ;(process.stderr as any).write = write0
    }
    expect(err.split("ALTIMATE_REVIEW_AI_FOCUSED=sometimes").length - 1).toBe(1)
  })

  test("no warning when the caller passes `warn: false`", () => {
    const write0 = process.stderr.write
    let err = ""
    ;(process.stderr as any).write = (s: string) => ((err += s), true)
    try {
      const off = resolveAiSwitches({ ai: false }, { ALTIMATE_REVIEW_AI_VERIFY: "lane-off-value" }, { warn: false })
      expect(off.verify).toBe(true)
    } finally {
      ;(process.stderr as any).write = write0
    }
    expect(err).toBe("")
  })

  test("reviewPullRequest: `--no-ai` writes no warning; the same value with the lane on does", async () => {
    const { reviewPullRequest } = await import("../../src/altimate/review/run")
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "review-switch-warn-")))
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
        cwd: root,
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
      })
    const KEYS = ["ALTIMATE_REVIEW_AI_VERIFY", "ALTIMATE_REVIEW_AI_DRYRUN", "GITHUB_EVENT_PATH", "GITHUB_BASE_REF", "CI_MERGE_REQUEST_TARGET_BRANCH_NAME"]
    const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
    const write0 = process.stderr.write
    let err = ""
    try {
      await fs.mkdir(path.join(root, "models"), { recursive: true })
      await fs.writeFile(path.join(root, "dbt_project.yml"), "name: p\n")
      await fs.writeFile(path.join(root, "models", "m.sql"), "select 1 as id\n")
      git("init", "-q", "-b", "main")
      git("add", "-A")
      git("commit", "-q", "-m", "base")
      await fs.writeFile(path.join(root, "models", "m.sql"), "select 1 as id, 2 as x\n")
      git("commit", "-q", "-am", "pr")
      for (const k of KEYS) delete process.env[k]
      process.env.ALTIMATE_REVIEW_AI_VERIFY = "lane-off-e2e"
      // The dry run plans the lane without a model call.
      process.env.ALTIMATE_REVIEW_AI_DRYRUN = "1"
      ;(process.stderr as any).write = (s: string) => ((err += s), true)
      await reviewPullRequest({ cwd: root, base: "HEAD~1", head: "HEAD", noAi: true })
      expect(err).not.toContain("ALTIMATE_REVIEW_AI_VERIFY=lane-off-e2e")
      await reviewPullRequest({ cwd: root, base: "HEAD~1", head: "HEAD" })
      expect(err).toContain("ignoring ALTIMATE_REVIEW_AI_VERIFY=lane-off-e2e")
    } finally {
      ;(process.stderr as any).write = write0
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})
