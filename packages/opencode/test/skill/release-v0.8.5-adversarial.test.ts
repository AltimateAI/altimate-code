/**
 * Adversarial and end-to-end coverage for the v0.8.5 composite-action repair.
 */

import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import YAML from "yaml"
import { tmpdir } from "../fixture/fixture"

const repoRoot = path.resolve(import.meta.dir, "../../../..")
const actionPath = path.join(repoRoot, "github/review/action.yml")

type ActionStep = {
  name?: string
  run?: string
  shell?: string
  env?: Record<string, string>
}

async function actionSteps(): Promise<ActionStep[]> {
  const action = YAML.parse(await fs.readFile(actionPath, "utf8"))
  return action.runs.steps
}

async function actionScript(name: string): Promise<string> {
  const step = (await actionSteps()).find((item) => item.name === name)
  expect(step?.run).toBeString()
  return step!.run!
}

async function runBash(script: string, env: Record<string, string>) {
  const proc = Bun.spawn(["bash", "-c", script], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

describe("v0.8.5 adversarial - composite action", () => {
  test("the action is valid composite-action YAML with bash run steps", async () => {
    const action = YAML.parse(await fs.readFile(actionPath, "utf8"))
    expect(action.runs.using).toBe("composite")
    expect(action.runs.steps.length).toBeGreaterThan(0)
    for (const step of action.runs.steps as ActionStep[]) {
      if (step.run) expect(step.shell).toBe("bash")
    }
  })

  test("a semver action ref pins the matching binary without consulting latest", async () => {
    await using tmp = await tmpdir()
    const bin = path.join(tmp.path, "bin")
    const output = path.join(tmp.path, "github-output")
    const curlMarker = path.join(tmp.path, "curl-called")
    await fs.mkdir(bin)
    await Bun.write(path.join(bin, "curl"), `#!/usr/bin/env bash\ntouch "$CURL_MARKER"\nexit 99\n`)
    await fs.chmod(path.join(bin, "curl"), 0o755)

    const result = await runBash(await actionScript("Get altimate-code version"), {
      ACTION_REF: "v0.8.5",
      GITHUB_OUTPUT: output,
      CURL_MARKER: curlMarker,
      PATH: `${bin}:${process.env.PATH}`,
    })

    expect(result.exitCode).toBe(0)
    expect(await fs.readFile(output, "utf8")).toBe("version=0.8.5\n")
    expect(
      await fs
        .stat(curlMarker)
        .then(() => true)
        .catch(() => false),
    ).toBe(false)
  })

  test("the non-semver action ref fallback bounds the release lookup", async () => {
    await using tmp = await tmpdir()
    const bin = path.join(tmp.path, "bin")
    const output = path.join(tmp.path, "github-output")
    const argsPath = path.join(tmp.path, "curl-args")
    await fs.mkdir(bin)
    await Bun.write(
      path.join(bin, "curl"),
      `#!/usr/bin/env bash\nprintf '%s\\0' "$@" > "$CURL_ARGS"\nprintf '{"tag_name":"v0.8.5"}\\n'\n`,
    )
    await fs.chmod(path.join(bin, "curl"), 0o755)

    const result = await runBash(await actionScript("Get altimate-code version"), {
      ACTION_REF: "main",
      CURL_ARGS: argsPath,
      GITHUB_OUTPUT: output,
      PATH: `${bin}:${process.env.PATH}`,
    })

    expect(result.exitCode, result.stderr).toBe(0)
    expect(await fs.readFile(output, "utf8")).toBe("version=0.8.5\n")
    const curlArgs = (await fs.readFile(argsPath, "utf8")).split("\0").filter(Boolean)
    expect(curlArgs).toContain("--connect-timeout")
    expect(curlArgs).toContain("5")
    expect(curlArgs).toContain("--max-time")
    expect(curlArgs).toContain("15")
  })

  test("hostile refs and paths are forwarded as data, never evaluated by bash", async () => {
    await using tmp = await tmpdir()
    const bin = path.join(tmp.path, "bin")
    const capture = path.join(tmp.path, "args")
    const sentinel = path.join(tmp.path, "injected")
    await fs.mkdir(bin)
    await Bun.write(path.join(bin, "altimate"), `#!/usr/bin/env bash\nprintf '%s\\0' "$@" > "$CAPTURE"\n`)
    await fs.chmod(path.join(bin, "altimate"), 0o755)

    const manifest = `target/manifest $(touch ${sentinel}) .json`
    const base = `main; touch ${sentinel}`
    const head = `HEAD && touch ${sentinel}`
    const result = await runBash(await actionScript("Run dbt PR review"), {
      CAPTURE: capture,
      PATH: `${bin}:${process.env.PATH}`,
      IN_MODE: "comment",
      IN_MANIFEST: manifest,
      IN_SEVERITY: "suggestion",
      IN_BASE: base,
      IN_HEAD: head,
      IN_POST: "true",
      GITHUB_TOKEN: "",
      GITHUB_REPOSITORY: "AltimateAI/example",
      GITHUB_EVENT_PATH: "",
      ALTIMATE_REVIEW_SIGNING_KEY: "",
    })

    expect(result.exitCode).toBe(0)
    expect(
      await fs
        .stat(sentinel)
        .then(() => true)
        .catch(() => false),
    ).toBe(false)
    const args = (await fs.readFile(capture, "utf8")).split("\0").filter(Boolean)
    expect(args).toEqual([
      "review",
      "--mode",
      "comment",
      "--manifest",
      manifest,
      "--severity",
      "suggestion",
      "--base",
      base,
      "--head",
      head,
      "--post",
    ])
  })

  test("hosted credentials are written owner-only and never printed", async () => {
    await using tmp = await tmpdir()
    const githubEnv = path.join(tmp.path, "github-env")
    const secret = "alt-secret-that-must-not-leak"
    const result = await runBash(await actionScript("Configure advisory reviewer model + credentials"), {
      HOME: tmp.path,
      GITHUB_ENV: githubEnv,
      IN_ALT_KEY: secret,
      IN_ALT_INSTANCE: "demo",
      IN_ALT_URL: "https://api.example.test",
      IN_MODEL: "",
      IN_MODEL_API_KEY: "",
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout + result.stderr).not.toContain(secret)
    const credentialPath = path.join(tmp.path, ".altimate/altimate.json")
    expect((await fs.stat(credentialPath)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await fs.readFile(credentialPath, "utf8"))).toEqual({
      altimateUrl: "https://api.example.test",
      altimateInstanceName: "demo",
      altimateApiKey: secret,
    })
  })

  test("invalid credential combinations fail without leaking secrets", async () => {
    await using tmp = await tmpdir()
    const secret = "must-not-appear-in-logs"
    const result = await runBash(await actionScript("Configure advisory reviewer model + credentials"), {
      HOME: tmp.path,
      GITHUB_ENV: path.join(tmp.path, "github-env"),
      IN_ALT_KEY: secret,
      IN_ALT_INSTANCE: "",
      IN_ALT_URL: "https://api.example.test",
      IN_MODEL: "",
      IN_MODEL_API_KEY: "",
    })

    expect(result.exitCode).toBe(1)
    expect(result.stdout + result.stderr).not.toContain(secret)
    expect(result.stdout + result.stderr).toContain("altimate_instance is empty")
    expect(
      await fs
        .stat(path.join(tmp.path, ".altimate/altimate.json"))
        .then(() => true)
        .catch(() => false),
    ).toBe(false)
  })

  test("the committed archive contains regular, non-empty action dependencies", async () => {
    await using tmp = await tmpdir()
    const archive = path.join(tmp.path, "release.tar")
    const extracted = path.join(tmp.path, "extracted")
    await fs.mkdir(extracted)
    await $`git archive --format=tar --output=${archive} HEAD`.cwd(repoRoot).quiet()
    await $`tar -xf ${archive} -C ${extracted}`.quiet()

    for (const name of ["button-dark.svg", "button-light.svg", "icon.png"]) {
      const asset = path.join(extracted, "sdks/vscode/images", name)
      const stat = await fs.lstat(asset)
      expect(stat.isSymbolicLink()).toBe(false)
      expect(stat.isFile()).toBe(true)
      expect(stat.size).toBeGreaterThan(0)
    }
    expect((await fs.stat(path.join(extracted, "github/review/action.yml"))).size).toBeGreaterThan(0)
  })

  test("docs point at the action patch, not the already-published broken tag", async () => {
    const changelog = await fs.readFile(path.join(repoRoot, "CHANGELOG.md"), "utf8")
    // Match whether the entry is still "Unreleased" or has been date-stamped at release.
    const version = changelog.match(/^## \[(\d+\.\d+\.\d+)\] - (?:Unreleased|\d{4}-\d{2}-\d{2})$/m)?.[1]
    expect(version).toBe("0.8.5")

    for (const relative of ["docs/docs/usage/dbt-pr-review.md", "github/review/examples/altimate-ingestion.yml"]) {
      const content = await fs.readFile(path.join(repoRoot, relative), "utf8")
      expect(content).toContain(`AltimateAI/altimate-code/github/review@v${version}`)
      expect(content).not.toContain("AltimateAI/altimate-code/github/review@v0.8.4")
    }
  })

  test("the release lookup authenticates the api when a github token is present", async () => {
    await using tmp = await tmpdir()
    const bin = path.join(tmp.path, "bin")
    const output = path.join(tmp.path, "github-output")
    const argsPath = path.join(tmp.path, "curl-args")
    await fs.mkdir(bin)
    await Bun.write(
      path.join(bin, "curl"),
      `#!/usr/bin/env bash\nprintf '%s\\0' "$@" > "$CURL_ARGS"\nprintf '{"tag_name":"v0.8.5"}\\n'\n`,
    )
    await fs.chmod(path.join(bin, "curl"), 0o755)

    const result = await runBash(await actionScript("Get altimate-code version"), {
      ACTION_REF: "main",
      GITHUB_TOKEN: "ghs-test-token",
      CURL_ARGS: argsPath,
      GITHUB_OUTPUT: output,
      PATH: `${bin}:${process.env.PATH}`,
    })

    expect(result.exitCode, result.stderr).toBe(0)
    const curlArgs = (await fs.readFile(argsPath, "utf8")).split("\0").filter(Boolean)
    expect(curlArgs).toContain("-H")
    expect(curlArgs).toContain("Authorization: Bearer ghs-test-token")
  })

  test("the release lookup omits auth and still succeeds when no token is present", async () => {
    await using tmp = await tmpdir()
    const bin = path.join(tmp.path, "bin")
    const output = path.join(tmp.path, "github-output")
    const argsPath = path.join(tmp.path, "curl-args")
    await fs.mkdir(bin)
    await Bun.write(
      path.join(bin, "curl"),
      `#!/usr/bin/env bash\nprintf '%s\\0' "$@" > "$CURL_ARGS"\nprintf '{"tag_name":"v0.8.5"}\\n'\n`,
    )
    await fs.chmod(path.join(bin, "curl"), 0o755)

    // An empty token must not crash under `set -u` (the ${AUTH[@]+...} idiom)
    // and must not attach an Authorization header.
    const result = await runBash(await actionScript("Get altimate-code version"), {
      ACTION_REF: "main",
      GITHUB_TOKEN: "",
      CURL_ARGS: argsPath,
      GITHUB_OUTPUT: output,
      PATH: `${bin}:${process.env.PATH}`,
    })

    expect(result.exitCode, result.stderr).toBe(0)
    expect(await fs.readFile(output, "utf8")).toBe("version=0.8.5\n")
    const curlArgs = (await fs.readFile(argsPath, "utf8")).split("\0").filter(Boolean)
    expect(curlArgs).not.toContain("-H")
    expect(curlArgs.some((arg) => arg.startsWith("Authorization:"))).toBe(false)
  })

  test("the cache step is skipped for the floating latest version", async () => {
    const action = YAML.parse(await fs.readFile(actionPath, "utf8"))
    const cache = action.runs.steps.find((step: { name?: string }) => step.name === "Cache altimate-code")
    expect(cache?.if).toBe("steps.version.outputs.version != 'latest'")
  })

  test("the hosted credential write keeps the api key out of the jq argv", async () => {
    await using tmp = await tmpdir()
    const bin = path.join(tmp.path, "bin")
    const argsPath = path.join(tmp.path, "jq-args")
    const secret = "argv-secret-must-not-appear"
    await fs.mkdir(bin)
    // Fake jq captures its argv (and writes nothing), so we can assert the
    // secret is delivered via the environment, not the process arg list.
    await Bun.write(path.join(bin, "jq"), `#!/usr/bin/env bash\nprintf '%s\\0' "$@" > "$JQ_ARGS"\n`)
    await fs.chmod(path.join(bin, "jq"), 0o755)

    const result = await runBash(await actionScript("Configure advisory reviewer model + credentials"), {
      HOME: tmp.path,
      GITHUB_ENV: path.join(tmp.path, "github-env"),
      JQ_ARGS: argsPath,
      IN_ALT_KEY: secret,
      IN_ALT_INSTANCE: "demo",
      IN_ALT_URL: "https://api.example.test",
      IN_MODEL: "",
      IN_MODEL_API_KEY: "",
      PATH: `${bin}:${process.env.PATH}`,
    })

    expect(result.exitCode, result.stderr).toBe(0)
    const jqArgs = (await fs.readFile(argsPath, "utf8")).split("\0").filter(Boolean)
    expect(jqArgs.some((arg) => arg.includes(secret))).toBe(false)
    expect(jqArgs).toContain("{altimateUrl:$url, altimateInstanceName:$inst, altimateApiKey:$ENV.IN_ALT_KEY}")
  })
})

describe("v0.8.5 end-to-end - real review pipeline", () => {
  test("reviews a changed dbt model from git with a valid manifest", async () => {
    await using tmp = await tmpdir({ git: true })
    const modelPath = path.join(tmp.path, "models/orders.sql")
    const manifestPath = path.join(tmp.path, "target/manifest.json")
    await fs.mkdir(path.dirname(modelPath), { recursive: true })
    await fs.mkdir(path.dirname(manifestPath), { recursive: true })
    await Bun.write(path.join(tmp.path, "dbt_project.yml"), "name: demo\nversion: 1.0.0\nprofile: demo\n")
    await Bun.write(modelPath, "select 1 as order_id\n")
    await Bun.write(
      manifestPath,
      JSON.stringify({
        metadata: { adapter_type: "duckdb" },
        nodes: {
          "model.demo.orders": {
            unique_id: "model.demo.orders",
            resource_type: "model",
            name: "orders",
            original_file_path: "models/orders.sql",
            config: { materialized: "table" },
            depends_on: { nodes: [] },
            columns: { order_id: { name: "order_id", data_type: "integer" } },
          },
        },
        sources: {},
      }),
    )
    await $`git add dbt_project.yml models/orders.sql target/manifest.json`.cwd(tmp.path).quiet()
    await $`git commit -m base`.cwd(tmp.path).quiet()
    await Bun.write(modelPath, "select 1 as order_id, 'paid' as status\n")

    const runnerPath = path.join(tmp.path, "run-review-e2e.ts")
    await Bun.write(
      runnerPath,
      `
        import { collectChangedFiles } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "packages/opencode/src/altimate/review/git.ts")).href)}
        import { reviewPullRequest } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "packages/opencode/src/altimate/review/run.ts")).href)}

        const cwd = process.argv[2]
        const changed = await collectChangedFiles({ cwd, base: "HEAD" })
        if (JSON.stringify(changed.map((file) => file.path)) !== JSON.stringify(["models/orders.sql"])) {
          throw new Error("changed files mismatch: " + JSON.stringify(changed))
        }
        const result = await reviewPullRequest({
          cwd,
          base: "HEAD",
          manifestPath: "target/manifest.json",
          mode: "comment",
          noAi: true,
        })
        console.log(JSON.stringify({
          degraded: result.summary.degraded,
          manifestHash: result.manifestHash,
          verdict: result.verdict,
        }))
      `,
    )
    const proc = Bun.spawn(["bun", runnerPath, tmp.path], {
      cwd: path.join(repoRoot, "packages/opencode"),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    expect(exitCode, stderr).toBe(0)
    const result = JSON.parse(stdout)
    expect(result.degraded).toBe(false)
    expect(result.manifestHash).toMatch(/^[a-f0-9]{16}$/)
    expect(["APPROVE", "COMMENT"]).toContain(result.verdict)
  })
})
