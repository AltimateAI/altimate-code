// altimate_change — end-to-end review telemetry.
//
// Opt-in via ALTIMATE_E2E=1. Runs a real `altimate-code review` process against a real git repo
// with its telemetry endpoint pointed at a local sink, and asserts the envelopes that actually
// arrive over HTTP.
//
// This is the only test that can prove the central design claim: caller attribution works because
// these events declare no `source` field, so the envelope's process-level value survives
// serialization. A Telemetry.track spy cannot see that, and a unit test cannot prove the flag set
// by a caller's environment reaches a separate process at all.
//
// No PTY needed, unlike the onboarding funnel tests — review is a one-shot command.
import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const enabled = process.env.ALTIMATE_E2E === "1"

type Captured = { name: string; properties: Record<string, string>; measurements: Record<string, number> }

function startSink() {
  const envelopes: Captured[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (!req.url.endsWith("/v2/track")) return new Response("", { status: 404 })
      for (const item of (await req.json()) as any[]) {
        const base = item?.data?.baseData ?? {}
        envelopes.push({
          name: String(base.name ?? ""),
          properties: base.properties ?? {},
          measurements: base.measurements ?? {},
        })
      }
      return new Response("", { status: 200 })
    },
  })
  return { envelopes, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

/** A git repo with one committed dbt model and an uncommitted change to review. */
async function fixtureRepo(home: string) {
  const repo = await mkdtemp(path.join(tmpdir(), "review-e2e-repo-"))
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo, env: { ...process.env, HOME: home } })
  git("init", "-q")
  git("config", "user.email", "e2e@example.invalid")
  git("config", "user.name", "e2e")
  await mkdir(path.join(repo, "models"), { recursive: true })
  await writeFile(path.join(repo, "dbt_project.yml"), "name: e2e\nversion: '1.0'\nprofile: e2e\n")
  await writeFile(path.join(repo, "models/orders.sql"), "select 1 as id\n")
  git("add", "-A")
  git("commit", "-qm", "init")
  await writeFile(path.join(repo, "models/orders.sql"), "select 1 as id, 2 as amount\n")
  return repo
}

describe.skipIf(!enabled)("review telemetry (e2e)", () => {
  test(
    "a real review run reports its caller, and the caller set no CLI flag to do it",
    async () => {
      const sink = startSink()
      // Throwaway HOME so the run cannot read or write the developer's real credentials or
      // machine-id.
      const home = await mkdtemp(path.join(tmpdir(), "review-e2e-home-"))
      const repo = await fixtureRepo(home)

      try {
        const proc = Bun.spawn(
          [process.execPath, "run", "--conditions=browser", "src/index.ts", "review", "--cwd", repo],
          {
            // Run from packages/opencode so bun picks up the workspace bunfig.toml for the JSX
            // runtime, exactly as the `dev` script does.
            cwd: path.resolve(import.meta.dir, "../.."),
            stdout: "pipe",
            stderr: "pipe",
            env: {
              ...process.env,
              HOME: home,
              APPLICATIONINSIGHTS_CONNECTION_STRING: `InstrumentationKey=e2e;IngestionEndpoint=${sink.url}`,
              ALTIMATE_TELEMETRY_DISABLED: "false",
              // The whole point: only the caller's environment is set. Nothing in the CLI knows
              // about this value.
              ALTIMATE_CLI_CLIENT: "plugin:claude-code",
            },
          },
        )
        // No sleep needed: the CLI awaits Telemetry.shutdown() in its top-level finally,
        // shutdown() awaits flush(), flush() awaits the sink's HTTP response, and the sink records
        // the envelopes before responding. By the time exit resolves, the request has completed.
        expect(await proc.exited).toBe(0)

        const run = sink.envelopes.find((e) => e.name === "review_run")
        expect(run).toBeDefined()

        // Attribution with no attribution code — this is the claim the design rests on.
        expect(run!.properties.source).toBe("plugin:claude-code")

        expect(run!.properties.invocation).toBe("cli")
        expect(run!.properties.status).toBe("completed")
        expect(run!.properties.verdict).toBeTruthy()
        expect(typeof run!.measurements.duration_ms).toBe("number")

        // Zero-filled across the enum. The field is declared Record<string, number> and the
        // envelope's object branch stringifies it on the way out — the sibling map-shaped fields
        // (sql_quality.by_category, dbt_materialization_dist) declare `string` and stringify at
        // the call site instead. Wire bytes are identical; the two shapes are not.
        const byCategory = JSON.parse(run!.properties.by_category)
        expect(Object.keys(byCategory).length).toBe(14)

        // Publication is its own event and reports honestly that none was requested.
        const post = sink.envelopes.find((e) => e.name === "review_post_outcome")
        expect(post).toBeDefined()
        expect(post!.properties.outcome).toBe("not_requested")

        // Findings are about customer schema; none of it may reach telemetry.
        const serialized = JSON.stringify(sink.envelopes)
        for (const leak of ["orders.sql", "as amount", repo]) {
          expect(serialized).not.toContain(leak)
        }
      } finally {
        sink.stop()
        await rm(home, { recursive: true, force: true }).catch(() => {})
        await rm(repo, { recursive: true, force: true }).catch(() => {})
      }
    },
    180_000,
  )

  test(
    "a completed review always carries exactly one post outcome, even when the run dies after it",
    async () => {
      const sink = startSink()
      const home = await mkdtemp(path.join(tmpdir(), "review-e2e-home-"))
      const repo = await fixtureRepo(home)

      try {
        // `--output` into a directory that does not exist. The write sits between the completed
        // review and the post attempt, and before the fix it threw there with `review_run:
        // completed` already emitted and no post event at all — indistinguishable, downstream,
        // from a dropped event or an older client.
        const proc = Bun.spawn(
          [
            process.execPath,
            "run",
            "--conditions=browser",
            "src/index.ts",
            "review",
            "--cwd",
            repo,
            "--post",
            "--output",
            path.join(repo, "no-such-dir", "verdict.json"),
          ],
          {
            cwd: path.resolve(import.meta.dir, "../.."),
            stdout: "pipe",
            stderr: "pipe",
            env: {
              ...process.env,
              HOME: home,
              APPLICATIONINSIGHTS_CONNECTION_STRING: `InstrumentationKey=e2e;IngestionEndpoint=${sink.url}`,
              ALTIMATE_TELEMETRY_DISABLED: "false",
              ALTIMATE_CLI_CLIENT: "plugin:claude-code",
            },
          },
        )
        // Non-zero: the write error propagates. Telemetry still flushes from the top-level finally.
        expect(await proc.exited).not.toBe(0)

        const run = sink.envelopes.find((e) => e.name === "review_run")
        expect(run).toBeDefined()
        expect(run!.properties.status).toBe("completed")

        const posts = sink.envelopes.filter((e) => e.name === "review_post_outcome")
        expect(posts).toHaveLength(1)
        expect(posts[0]!.properties.outcome).toBe("not_attempted")

        const serialized = JSON.stringify(sink.envelopes)
        for (const leak of ["orders.sql", "as amount", repo]) {
          expect(serialized).not.toContain(leak)
        }
      } finally {
        sink.stop()
        await rm(home, { recursive: true, force: true }).catch(() => {})
        await rm(repo, { recursive: true, force: true }).catch(() => {})
      }
    },
    180_000,
  )
})
