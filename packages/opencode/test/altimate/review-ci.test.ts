import { $ } from "bun"
import { describe, test, expect, afterEach, mock, spyOn } from "bun:test"
import path from "node:path"
import { resolveGitHubTarget } from "../../src/altimate/review/post-github"
import * as PostGitHub from "../../src/altimate/review/post-github"
import { defaultBaseRef } from "../../src/altimate/review/git"
import * as ReviewRun from "../../src/altimate/review/run"
import { ReviewCommand } from "../../src/cli/cmd/review"
import { buildReviewSchemaContext } from "../../src/altimate/review/schema-context"
import { Telemetry } from "../../src/altimate/telemetry"
import { Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Instance } from "../../src/project/instance"
import { buildEnvelope } from "../../src/altimate/review/verdict"
import { makeFinding } from "../../src/altimate/review/finding"
import { REVIEW_MARKER } from "../../src/altimate/review/format"
import { tmpdir } from "../fixture/fixture"
import YAML from "yaml"

const ENV_KEYS = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_REPOSITORY",
  "GITHUB_EVENT_PATH",
  "ALTIMATE_PR_NUMBER",
  "ALTIMATE_REVIEW_AI_MODEL",
  "ALTIMATE_REVIEW_AI_REASONING",
  "ALTIMATE_REVIEW_AI_TIMEOUT_SECONDS",
  "OPENCODE_CONFIG_CONTENT",
]
const saved: Record<string, string | undefined> = {}
for (const k of ENV_KEYS) saved[k] = process.env[k]
const savedExitCode = process.exitCode

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  mock.restore()
  Telemetry.setContext({ sessionId: "", projectId: "" })
  // Bun retains a previously assigned numeric exit code when it is reset to
  // undefined, so explicitly restore the successful process default.
  process.exitCode = savedExitCode ?? 0
})

describe("review CLI command", () => {
  test("is registered as `review`", () => {
    expect(ReviewCommand.command).toBe("review")
    expect(typeof ReviewCommand.handler).toBe("function")
  })

  test("boolean-negation:false does not break other declared boolean flags (PR #1027 consensus MINOR #5)", async () => {
    // The B1 fix disables yargs' `--no-<option>` auto-negation on the review
    // command via `parserConfiguration({ "boolean-negation": false })`, so
    // `--no-ai` binds to the declared `noAi` boolean. That setting is
    // command-global — if a future boolean flag is added, its `--no-<flag>`
    // form silently changes shape. This regression asserts every currently
    // declared boolean parses to the expected type + default.
    const yargsMod = await import("yargs")
    // Build the command's yargs builder in isolation (no execution) and
    // check the parsed argv shape for each boolean flag's on/off/default
    // forms. Uses parseAsync so the whole builder chain runs.
    const buildBase = () => (ReviewCommand.builder as any)(yargsMod.default([]).exitProcess(false).help(false))
    const parse = async (args: string[]) => {
      const parsed = await buildBase().parseAsync(args)
      return parsed
    }

    const flags: Array<{ name: string; long: string; camel: string; default?: boolean }> = [
      { name: "json", long: "--json", camel: "json", default: false },
      { name: "post", long: "--post", camel: "post", default: false },
      { name: "no-ai", long: "--no-ai", camel: "noAi", default: false },
      { name: "explain-tier", long: "--explain-tier", camel: "explainTier", default: false },
    ]

    for (const f of flags) {
      // Default (flag absent).
      const defaultParsed = await parse([])
      expect((defaultParsed as any)[f.camel]).toBe(f.default ?? false)
      // Bare form flips to true (the whole point of B1).
      const bareParsed = await parse([f.long])
      expect((bareParsed as any)[f.camel]).toBe(true)
      // Explicit `=false` still works.
      const explicitFalse = await parse([`${f.long}=false`])
      expect((explicitFalse as any)[f.camel]).toBe(false)
    }
  })

  test("sets project context before the CLI emits review_run", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "README.md"), "before\n")
    await $`git add README.md`.cwd(tmp.path).quiet()
    await $`git commit -m fixture`.cwd(tmp.path).quiet()
    await Bun.write(path.join(tmp.path, "README.md"), "after\n")

    let projectIdAtRun = ""
    spyOn(process.stdout, "write").mockImplementation(() => true)
    spyOn(Telemetry, "track").mockImplementation((event) => {
      if (event.type === "review_run" && event.invocation === "cli") {
        projectIdAtRun = Telemetry.getContext().projectId
      }
    })

    await (ReviewCommand.handler as any)({
      cwd: tmp.path,
      base: "HEAD",
      mode: "comment",
      post: false,
      json: true,
      noAi: true,
      explainTier: false,
    })

    expect(projectIdAtRun).not.toBe("")
  })

  test("passes pull request title and capped body from the GitHub event", async () => {
    await using tmp = await tmpdir({ git: true })
    const eventPath = path.join(tmp.path, "event.json")
    const body = "intent ".repeat(700)
    await Bun.write(eventPath, JSON.stringify({ pull_request: { title: "Keep customer grain", body } }))
    process.env.GITHUB_EVENT_PATH = eventPath

    const review = spyOn(ReviewRun, "reviewPullRequest").mockResolvedValue(
      buildEnvelope({ findings: [], tier: "trivial", mode: "comment" }),
    )
    spyOn(process.stdout, "write").mockImplementation(() => true)

    await (ReviewCommand.handler as any)({
      cwd: tmp.path,
      base: "HEAD",
      mode: "comment",
      post: false,
      json: true,
      noAi: true,
      explainTier: false,
    })

    expect(review).toHaveBeenCalledTimes(1)
    expect(review.mock.calls[0][0]).toMatchObject({
      prTitle: "Keep customer grain",
      prBody: body.slice(0, 4_000),
    })
  })

  test("passes the AI model flag ahead of the environment and disables session fallback", async () => {
    await using tmp = await tmpdir({ git: true })
    process.env.ALTIMATE_REVIEW_AI_MODEL = "environment/model"
    const review = spyOn(ReviewRun, "reviewPullRequest").mockResolvedValue(
      buildEnvelope({ findings: [], tier: "trivial", mode: "comment" }),
    )
    spyOn(process.stdout, "write").mockImplementation(() => true)

    await (ReviewCommand.handler as any)({
      cwd: tmp.path,
      base: "HEAD",
      mode: "comment",
      post: false,
      json: true,
      noAi: false,
      aiModel: "flag/model",
      explainTier: false,
    })
    expect(review.mock.calls[0][0]).toMatchObject({ aiModel: "flag/model", allowSessionModel: false })

    review.mockClear()
    await (ReviewCommand.handler as any)({
      cwd: tmp.path,
      base: "HEAD",
      mode: "comment",
      post: false,
      json: true,
      noAi: false,
      explainTier: false,
    })
    expect(review.mock.calls[0][0]).toMatchObject({ aiModel: "environment/model", allowSessionModel: false })

    review.mockClear()
    delete process.env.ALTIMATE_REVIEW_AI_MODEL
    await (ReviewCommand.handler as any)({
      cwd: tmp.path,
      base: "HEAD",
      mode: "comment",
      post: false,
      json: true,
      noAi: false,
      aiModel: " \t ",
      explainTier: false,
    })
    expect(review.mock.calls[0][0]).toMatchObject({ aiModel: undefined, allowSessionModel: false })

    review.mockClear()
    process.env.ALTIMATE_REVIEW_AI_MODEL = " \n "
    await (ReviewCommand.handler as any)({
      cwd: tmp.path,
      base: "HEAD",
      mode: "comment",
      post: false,
      json: true,
      noAi: false,
      explainTier: false,
    })
    expect(review.mock.calls[0][0]).toMatchObject({ aiModel: undefined, allowSessionModel: false })
  })

  test("passes AI timeout precedence and the explicit output budget", async () => {
    await using tmp = await tmpdir({ git: true })
    process.env.ALTIMATE_REVIEW_AI_TIMEOUT_SECONDS = "240"
    const review = spyOn(ReviewRun, "reviewPullRequest").mockResolvedValue(
      buildEnvelope({ findings: [], tier: "trivial", mode: "comment" }),
    )
    spyOn(process.stdout, "write").mockImplementation(() => true)

    const baseArgs = {
      cwd: tmp.path,
      base: "HEAD",
      mode: "comment",
      post: false,
      json: true,
      noAi: false,
      explainTier: false,
    }
    await (ReviewCommand.handler as any)({
      ...baseArgs,
      aiTimeout: 180,
      aiMaxOutputTokens: 12_288,
    })
    expect(review.mock.calls[0][0]).toMatchObject({
      aiTimeoutMs: 180_000,
      aiMaxOutputTokens: 12_288,
    })

    review.mockClear()
    await (ReviewCommand.handler as any)(baseArgs)
    expect(review.mock.calls[0][0]).toMatchObject({ aiTimeoutMs: 240_000 })
    expect(review.mock.calls[0][0].aiMaxOutputTokens).toBeUndefined()

    review.mockClear()
    delete process.env.ALTIMATE_REVIEW_AI_TIMEOUT_SECONDS
    await (ReviewCommand.handler as any)(baseArgs)
    expect(review.mock.calls[0][0].aiTimeoutMs).toBeUndefined()
  })

  test("passes AI reasoning with flag, environment, config fallback precedence and validates values", async () => {
    await using tmp = await tmpdir({ git: true })
    process.env.ALTIMATE_REVIEW_AI_REASONING = "low"
    const review = spyOn(ReviewRun, "reviewPullRequest").mockResolvedValue(
      buildEnvelope({ findings: [], tier: "trivial", mode: "comment" }),
    )
    spyOn(process.stdout, "write").mockImplementation(() => true)
    const baseArgs = {
      cwd: tmp.path,
      base: "HEAD",
      mode: "comment",
      post: false,
      json: true,
      noAi: false,
      explainTier: false,
    }

    await (ReviewCommand.handler as any)({ ...baseArgs, aiReasoning: "high" })
    expect(review.mock.calls[0][0].aiReasoningEffort).toBe("high")

    review.mockClear()
    await (ReviewCommand.handler as any)({ ...baseArgs, aiReasoning: " \t " })
    expect(review.mock.calls[0][0].aiReasoningEffort).toBe("low")

    review.mockClear()
    process.env.ALTIMATE_REVIEW_AI_REASONING = " \n "
    await (ReviewCommand.handler as any)(baseArgs)
    // Undefined delegates to reviewPullRequest's repository-config fallback.
    expect(review.mock.calls[0][0].aiReasoningEffort).toBeUndefined()

    await expect((ReviewCommand.handler as any)({ ...baseArgs, aiReasoning: "maximum" })).rejects.toThrow(
      "--ai-reasoning / ALTIMATE_REVIEW_AI_REASONING must be one of: none, minimal, low, medium, high",
    )
  })

  test("prints the summary and exits successfully when GitHub rejects posting with 403", async () => {
    await using tmp = await tmpdir({ git: true })
    for (const k of ENV_KEYS) delete process.env[k]
    process.env.GITHUB_TOKEN = "token"
    process.env.GITHUB_REPOSITORY = "owner/repo"
    process.env.ALTIMATE_PR_NUMBER = "7"
    process.exitCode = undefined
    // A fork pull request: the token is read-only, so a 403 on post is expected.
    const eventPath = path.join(tmp.path, "event.json")
    await Bun.write(
      eventPath,
      JSON.stringify({
        pull_request: { head: { repo: { fork: true, full_name: "someone/repo" } }, base: { repo: { full_name: "owner/repo" } } },
      }),
    )
    process.env.GITHUB_EVENT_PATH = eventPath

    const env = buildEnvelope({ findings: [], tier: "trivial", mode: "comment" })
    spyOn(ReviewRun, "reviewPullRequest").mockResolvedValue(env)
    spyOn(PostGitHub, "postGitHubReview").mockRejectedValue(
      Object.assign(new Error("Resource not accessible by integration"), { status: 403 }),
    )
    const stdout: string[] = []
    const stderr: string[] = []
    const events: Telemetry.Event[] = []
    spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      stdout.push(String(chunk))
      return true
    }) as any)
    spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      stderr.push(String(chunk))
      return true
    }) as any)
    spyOn(Telemetry, "track").mockImplementation((event) => events.push(event))

    await (ReviewCommand.handler as any)({
      cwd: tmp.path,
      mode: "comment",
      post: true,
      json: true,
      noAi: true,
      explainTier: false,
    })

    expect(stderr.join("")).toContain("could not post the review: 403 (fork pull request, read-only token); printing summary instead")
    // Under --json stdout stays machine-readable: the human summary goes to stderr.
    expect(stderr.join("")).toContain(REVIEW_MARKER)
    expect(stdout.join("")).not.toContain(REVIEW_MARKER)
    expect(() => JSON.parse(stdout.join("").trim())).not.toThrow()
    expect(events.filter((event) => event.type === "review_post_outcome")).toMatchObject([{ outcome: "forbidden" }])
    expect(process.exitCode ?? 0).toBe(0)
  })

  test("a 403 on a same-repository pull request is a misconfiguration and still fails", async () => {
    await using tmp = await tmpdir({ git: true })
    for (const k of ENV_KEYS) delete process.env[k]
    delete process.env.GITHUB_EVENT_PATH
    process.env.GITHUB_TOKEN = "token"
    process.env.GITHUB_REPOSITORY = "owner/repo"
    process.env.ALTIMATE_PR_NUMBER = "7"
    process.exitCode = undefined

    spyOn(ReviewRun, "reviewPullRequest").mockResolvedValue(buildEnvelope({ findings: [], tier: "trivial", mode: "comment" }))
    spyOn(PostGitHub, "postGitHubReview").mockRejectedValue(Object.assign(new Error("Forbidden"), { status: 403 }))
    spyOn(process.stdout, "write").mockImplementation(() => true)
    spyOn(process.stderr, "write").mockImplementation(() => true)
    const events: Telemetry.Event[] = []
    spyOn(Telemetry, "track").mockImplementation((event) => events.push(event))

    await expect(
      (ReviewCommand.handler as any)({ cwd: tmp.path, mode: "comment", post: true, json: false, noAi: true, explainTier: false }),
    ).rejects.toThrow("Forbidden")
    expect(events.filter((event) => event.type === "review_post_outcome")).toMatchObject([{ outcome: "summary_failed" }])
  })

  test("retains the gate verdict exit code when forbidden posting falls back to stdout", async () => {
    await using tmp = await tmpdir({ git: true })
    for (const k of ENV_KEYS) delete process.env[k]
    process.env.GITHUB_TOKEN = "token"
    process.env.GITHUB_REPOSITORY = "owner/repo"
    process.env.ALTIMATE_PR_NUMBER = "7"
    process.exitCode = undefined

    const blocking = makeFinding({
      severity: "critical",
      category: "contract_violation",
      title: "Breaking contract change",
      body: "A contracted column was removed.",
      file: "models/orders.sql",
      ruleKey: "breaking-contract",
    })
    const env = buildEnvelope({ findings: [blocking], tier: "full", mode: "gate" })
    expect(env.verdict).toBe("REQUEST_CHANGES")
    const eventPath = path.join(tmp.path, "event.json")
    await Bun.write(
      eventPath,
      JSON.stringify({ pull_request: { head: { repo: { fork: true, full_name: "someone/repo" } }, base: { repo: { full_name: "owner/repo" } } } }),
    )
    process.env.GITHUB_EVENT_PATH = eventPath
    spyOn(ReviewRun, "reviewPullRequest").mockResolvedValue(env)
    spyOn(PostGitHub, "postGitHubReview").mockRejectedValue(Object.assign(new Error("Forbidden"), { status: 403 }))
    spyOn(process.stdout, "write").mockImplementation(() => true)
    spyOn(process.stderr, "write").mockImplementation(() => true)

    await (ReviewCommand.handler as any)({
      cwd: tmp.path,
      mode: "gate",
      post: true,
      json: false,
      noAi: true,
      explainTier: false,
    })

    expect(Number(process.exitCode)).toBe(2)
  })
})

describe("reviewPullRequest head handling", () => {
  test("treats an empty review head as omitted", async () => {
    await using tmp = await tmpdir({ git: true })
    delete process.env.GITHUB_EVENT_PATH
    await Bun.write(path.join(tmp.path, "README.md"), "before\n")
    await $`git add README.md`.cwd(tmp.path).quiet()
    await $`git commit -m fixture`.cwd(tmp.path).quiet()
    await Bun.write(path.join(tmp.path, "README.md"), "after\n")

    const env = await ReviewRun.reviewPullRequest({ cwd: tmp.path, head: "", noAi: true })

    expect(env.summary.emptyScope).toBe(true)
  })

  test("uses the pull request base ref from GITHUB_EVENT_PATH when it resolves", async () => {
    await using tmp = await tmpdir({ git: true })
    await $`git update-ref refs/remotes/origin/release HEAD`.cwd(tmp.path).quiet()
    const eventPath = path.join(tmp.path, "event.json")
    await Bun.write(eventPath, JSON.stringify({ pull_request: { base: { ref: "release" } } }))
    process.env.GITHUB_EVENT_PATH = eventPath

    const expected = (await $`git merge-base HEAD origin/release`.cwd(tmp.path).quiet().text()).trim()
    expect(await defaultBaseRef(tmp.path)).toBe(expected)
  })

  test("computes the pull request fork point from a caller-supplied head", async () => {
    await using tmp = await tmpdir({ git: true })
    const root = (await $`git rev-parse HEAD`.cwd(tmp.path).quiet().text()).trim()

    await Bun.write(path.join(tmp.path, "release.txt"), "release\n")
    await $`git add release.txt`.cwd(tmp.path).quiet()
    await $`git commit -m release`.cwd(tmp.path).quiet()
    const release = (await $`git rev-parse HEAD`.cwd(tmp.path).quiet().text()).trim()
    await $`git update-ref refs/remotes/origin/release ${release}`.cwd(tmp.path).quiet()

    await Bun.write(path.join(tmp.path, "current.txt"), "current\n")
    await $`git add current.txt`.cwd(tmp.path).quiet()
    await $`git commit -m current`.cwd(tmp.path).quiet()
    await $`git update-ref refs/heads/custom-head ${root}`.cwd(tmp.path).quiet()

    const eventPath = path.join(tmp.path, "event.json")
    await Bun.write(eventPath, JSON.stringify({ pull_request: { base: { ref: "release" } } }))
    process.env.GITHUB_EVENT_PATH = eventPath

    expect(await defaultBaseRef(tmp.path)).toBe(release)
    expect(await defaultBaseRef(tmp.path, "custom-head")).toBe(root)
  })

  test("the composite action fetches and derives the merge-base from its effective head", async () => {
    const action = await Bun.file(path.resolve(import.meta.dir, "../../../../github/review/action.yml")).text()
    expect(action).toContain('if [[ "$IN_HEAD" == -* ]]')
    expect(action).toContain("echo \"::error::Custom head must not start with '-': $IN_HEAD\" >&2")
    expect(action).toContain('git rev-parse --verify --quiet "$IN_HEAD^{commit}"')
    expect(action).toContain('git fetch --no-tags origin -- "$IN_HEAD"')
    expect(action).toContain("git update-ref refs/altimate/review-head FETCH_HEAD")
    expect(action).toContain('echo "HEAD_REF=refs/altimate/review-head" >> "$GITHUB_ENV"')
    expect(action).not.toContain("+refs/heads/${IN_HEAD}:refs/remotes/origin/${IN_HEAD}")
    expect(action).toContain('echo "HEAD_REF=$IN_HEAD" >> "$GITHUB_ENV"')
    expect(action).toContain('echo "Unable to fetch custom head \'$IN_HEAD\' from origin" >&2')
    expect(action).toContain('git merge-base "origin/$PR_BASE_REF" "${HEAD_REF:-$PR_HEAD_SHA}"')
    expect(action).toContain('args+=(--head "${HEAD_REF:-$PR_HEAD_SHA}")')
    expect(action).toContain('args+=(--ai-timeout "$ALTIMATE_ACTION_AI_TIMEOUT_SECONDS")')
    expect(action).toContain('args+=(--ai-reasoning "$ALTIMATE_ACTION_AI_REASONING")')
  })
})

describe("advisory model configuration", () => {
  test("declares, validates, and exports the optional AI reasoning input without a default", async () => {
    await using tmp = await tmpdir()
    const actionText = await Bun.file(path.resolve(import.meta.dir, "../../../../github/review/action.yml")).text()
    const action = YAML.parse(actionText) as {
      inputs: Record<string, { description: string; required: boolean; default?: string }>
      runs: { steps: Array<{ name?: string; run?: string }> }
    }
    expect(action.inputs.ai_reasoning).toEqual({
      description:
        "Optional reasoning level for the advisory reviewer: none, minimal, low, medium or high. Unset leaves the model default (altimate-base thinks before answering).",
      required: false,
    })
    const script = action.runs.steps.find(
      (step) => step.name === "Configure advisory reviewer model + credentials",
    )?.run
    expect(script).toBeString()

    const run = async (reasoning: string, index: string) => {
      const githubEnv = path.join(tmp.path, `github-env-reasoning-${index}`)
      const proc = Bun.spawn(["bash", "-c", script!], {
        env: {
          ...process.env,
          HOME: tmp.path,
          GITHUB_ENV: githubEnv,
          IN_ALT_KEY: "",
          IN_ALT_INSTANCE: "",
          IN_ALT_URL: "",
          IN_GATEWAY_KEY: "",
          IN_GATEWAY_URL: "",
          IN_MODEL: "",
          IN_MODEL_API_KEY: "",
          IN_AI_MODEL: "",
          IN_AI_REASONING: reasoning,
          IN_AI_TIMEOUT_SECONDS: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return { githubEnv, stdout, stderr, exitCode }
    }

    for (const value of ["none", "minimal", "low", "medium", "high"]) {
      const result = await run(value, value)
      expect(result.exitCode).toBe(0)
      expect(await Bun.file(result.githubEnv).text()).toContain(`ALTIMATE_ACTION_AI_REASONING=${value}`)
    }

    const invalid = await run("maximum", "invalid")
    expect(invalid.exitCode).toBe(1)
    expect(invalid.stdout + invalid.stderr).toContain(
      "::error::ai_reasoning must be one of: none, minimal, low, medium or high.",
    )
  })

  test("normalizes gateway URLs before appending the OpenAI-compatible /v1 path", async () => {
    await using tmp = await tmpdir()
    const actionText = await Bun.file(path.resolve(import.meta.dir, "../../../../github/review/action.yml")).text()
    const action = YAML.parse(actionText) as { runs: { steps: Array<{ name?: string; run?: string }> } }
    const script = action.runs.steps.find(
      (step) => step.name === "Configure advisory reviewer model + credentials",
    )?.run
    expect(script).toBeString()

    for (const [index, gatewayUrl] of [
      "https://gateway.example.com",
      "https://gateway.example.com/",
      "https://gateway.example.com/v1",
      "https://gateway.example.com/v1/",
    ].entries()) {
      const githubEnv = path.join(tmp.path, `github-env-${index}`)
      const proc = Bun.spawn(["bash", "-c", script!], {
        env: {
          ...process.env,
          HOME: tmp.path,
          GITHUB_ENV: githubEnv,
          IN_ALT_KEY: "",
          IN_ALT_INSTANCE: "",
          IN_ALT_URL: "",
          IN_GATEWAY_KEY: "gateway-key",
          IN_GATEWAY_URL: gatewayUrl,
          IN_MODEL: "",
          IN_MODEL_API_KEY: "",
          IN_AI_MODEL: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      expect({ stdout, stderr, exitCode }).toMatchObject({ exitCode: 0 })
      const configLine = (await Bun.file(githubEnv).text())
        .split("\n")
        .find((line) => line.startsWith("OPENCODE_CONFIG_CONTENT="))
      expect(configLine).toBeString()
      const config = JSON.parse(configLine!.slice("OPENCODE_CONFIG_CONTENT=".length))
      expect(config.provider["altimate-gateway"].options.baseURL).toBe("https://gateway.example.com/v1")
      expect(await Bun.file(githubEnv).text()).toContain("ALTIMATE_ACTION_AI_TIMEOUT_SECONDS=900")
    }
  })

  test("resolves an altimate-gateway provider from OPENCODE_CONFIG_CONTENT without network access", async () => {
    await using tmp = await tmpdir()
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      provider: {
        "altimate-gateway": {
          npm: "@ai-sdk/openai-compatible",
          name: "Altimate Gateway",
          options: {
            baseURL: "https://gateway.example.com/v1",
            apiKey: "test-gateway-key",
          },
          models: {
            "altimate-base": { name: "altimate-base" },
            "altimate-pro": { name: "altimate-pro" },
          },
        },
      },
    })
    const fetch = spyOn(globalThis as any, "fetch").mockRejectedValue(new Error("unexpected network request"))

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        try {
          const model = await Provider.getModel(
            ProviderID.make("altimate-gateway"),
            ModelID.make("altimate-base"),
          )
          expect(String(model.providerID)).toBe("altimate-gateway")
          expect(String(model.id)).toBe("altimate-base")
          expect(model.api.npm).toBe("@ai-sdk/openai-compatible")
          const providers = await Provider.list()
          expect(providers["altimate-gateway"].options.baseURL).toBe("https://gateway.example.com/v1")
        } finally {
          await Instance.dispose()
        }
      },
    })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe("resolveGitHubTarget", () => {
  test("returns undefined without token/repo", async () => {
    for (const k of ENV_KEYS) delete process.env[k]
    expect(await resolveGitHubTarget()).toBeUndefined()
  })

  test("resolves owner/repo/pr from env (ALTIMATE_PR_NUMBER fallback)", async () => {
    for (const k of ENV_KEYS) delete process.env[k]
    process.env["GITHUB_TOKEN"] = "tok"
    process.env["GITHUB_REPOSITORY"] = "AltimateAI/altimate-bigquery-demo"
    process.env["ALTIMATE_PR_NUMBER"] = "42"
    const t = await resolveGitHubTarget()
    expect(t).toEqual({ token: "tok", owner: "AltimateAI", repo: "altimate-bigquery-demo", prNumber: 42 })
  })

  test("returns undefined when PR number cannot be resolved", async () => {
    for (const k of ENV_KEYS) delete process.env[k]
    process.env["GITHUB_TOKEN"] = "tok"
    process.env["GITHUB_REPOSITORY"] = "o/r"
    expect(await resolveGitHubTarget()).toBeUndefined()
  })
})

describe("buildReviewSchemaContext", () => {
  test("builds {tables, version} from manifest models + sources", () => {
    const ctx = buildReviewSchemaContext(
      [
        {
          name: "stg_orders",
          columns: [
            { name: "order_id", data_type: "int64" },
            { name: "amount", data_type: "numeric" },
          ],
        },
      ],
      [{ name: "raw_orders", columns: [{ name: "id", data_type: "int64" }] }],
    )
    expect(ctx?.version).toBe("1")
    expect(ctx?.tables["stg_orders"].columns).toEqual([
      { name: "order_id", type: "int64" },
      { name: "amount", type: "numeric" },
    ])
    expect(ctx?.tables["raw_orders"].columns[0]).toEqual({ name: "id", type: "int64" })
  })

  test("registers bare + alias + schema + database qualified keys", () => {
    const ctx = buildReviewSchemaContext([
      { name: "stg_orders", alias: "orders", schema_name: "analytics", database: "prod", columns: [{ name: "id" }] },
    ])
    // dbt ref() compiles to fully-qualified relations — every form must resolve.
    for (const key of [
      "stg_orders",
      "orders",
      "analytics.stg_orders",
      "analytics.orders",
      "prod.analytics.stg_orders",
      "prod.analytics.orders",
    ]) {
      expect(ctx!.tables[key]).toBeDefined()
    }
  })

  test("skips column-less nodes", () => {
    const ctx = buildReviewSchemaContext([
      { name: "m", columns: [{ name: "c" }] },
      { name: "empty", columns: [] },
    ])
    expect(Object.keys(ctx!.tables)).toEqual(["m"])
  })

  test("returns undefined when no node has columns", () => {
    expect(buildReviewSchemaContext([{ name: "x" }], undefined)).toBeUndefined()
  })

  test("derives primary_key from an explicit node.primary_key (for fan-out / L037)", () => {
    const ctx = buildReviewSchemaContext([
      { name: "dim", columns: [{ name: "id" }, { name: "name" }], primary_key: ["id"] },
    ])
    expect(ctx!.tables["dim"].primary_key).toEqual(["id"])
  })

  test("derives primary_key from column-level primary_key contract constraints", () => {
    const ctx = buildReviewSchemaContext([
      {
        name: "events",
        columns: [
          { name: "event_id", constraints: [{ type: "primary_key" }] },
          { name: "user_id" },
        ],
      },
    ])
    expect(ctx!.tables["events"].primary_key).toEqual(["event_id"])
  })

  test("omits primary_key when none is declared (L037 then stays silent)", () => {
    const ctx = buildReviewSchemaContext([{ name: "t", columns: [{ name: "a" }, { name: "b" }] }])
    expect(ctx!.tables["t"].primary_key).toBeUndefined()
  })
})
