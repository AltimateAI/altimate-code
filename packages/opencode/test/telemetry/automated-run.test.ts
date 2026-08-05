import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Telemetry } from "../../src/altimate/telemetry"

// A 14-day production window carried 1,020 test-process machine ids out of 3,135 total — roughly a
// third of every install and active-machine number, because a test process regenerates its machine
// id on every run. Test runners must never reach the baked-in production App Insights resource.
// CI on its own must still report: altimate-code-actions wraps this CLI, so gating on CI would
// blind a shipped product surface.

const ENV_KEYS = [
  "ALTIMATE_TELEMETRY_DISABLED",
  "ALTIMATE_TELEMETRY_FORCE",
  "APPLICATIONINSIGHTS_CONNECTION_STRING",
  "CI",
  "NODE_ENV",
  "BUN_TEST",
  "VITEST",
  "JEST_WORKER_ID",
  "GITHUB_ACTIONS",
  "BUILDKITE",
  "GITLAB_CI",
] as const

/** Run `fn` with exactly `env` set across all telemetry-relevant keys, then restore.
 *
 *  HOME/USERPROFILE are redirected to a throwaway directory as well: the non-suppressed cases
 *  reach `doInit`'s machine-id block, which reads and writes `~/.altimate/machine-id` via
 *  `os.homedir()`. Without this the suite would mint a real machine id on the developer's
 *  machine, and assertions would depend on whatever was already there.
 */
async function withEnv(env: Partial<Record<(typeof ENV_KEYS)[number], string>>, fn: () => Promise<void>) {
  const saved = new Map<string, string | undefined>()
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key])
    delete process.env[key]
  }
  const homeKeys = ["HOME", "USERPROFILE"] as const
  for (const key of homeKeys) saved.set(key, process.env[key])
  const home = await mkdtemp(path.join(tmpdir(), "telemetry-home-"))
  for (const key of homeKeys) process.env[key] = home

  Object.assign(process.env, env)
  try {
    await fn()
  } finally {
    for (const key of [...ENV_KEYS, ...homeKeys]) {
      const value = saved.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
}

/** Init telemetry, emit one event, flush, and report every outbound request. */
async function shippedRequests(): Promise<Array<string>> {
  const urls: string[] = []
  const fetchMock = spyOn(global, "fetch").mockImplementation((async (input: any) => {
    urls.push(String(input))
    return new Response("", { status: 200 })
  }) as unknown as typeof fetch)
  try {
    await Telemetry.init()
    Telemetry.track({
      type: "session_start",
      timestamp: 1000,
      session_id: "s1",
      model_id: "m1",
      provider_id: "test",
      agent: "builder",
      project_id: "proj1",
      os: "linux",
      arch: "x64",
      node_version: "v22.0.0",
    })
    await Telemetry.flush()
    return urls
  } finally {
    fetchMock.mockRestore()
  }
}

// Serial: every case mutates process-wide state — `process.env`, the global `fetch`, and the
// module-level Telemetry singleton (which `afterEach` shuts down). Bun runs a file's tests
// sequentially by default, so this is currently belt-and-braces; it stops `--concurrent` from
// silently turning these into flakes later.
describe.serial("telemetry: automated runs never reach the production sink", () => {
  afterEach(async () => {
    await Telemetry.shutdown()
    mock.restore()
  })

  for (const marker of ["BUN_TEST", "VITEST", "JEST_WORKER_ID"]) {
    test(`${marker} suppresses the baked-in connection string`, async () => {
      await withEnv({ [marker]: "true" } as any, async () => {
        expect(await shippedRequests()).toEqual([])
      })
    })
  }

  test("NODE_ENV=test suppresses the baked-in connection string", async () => {
    // This is the one that matters: `bun test` sets it, on CI and on developer machines alike.
    await withEnv({ NODE_ENV: "test" }, async () => {
      expect(await shippedRequests()).toEqual([])
    })
  })

  // CI alone must NOT suppress. altimate-code-actions wraps this CLI, so every run of that
  // shipped product sets CI/GITHUB_ACTIONS — gating on those would blind a real product surface.
  for (const marker of ["CI", "GITHUB_ACTIONS", "BUILDKITE", "GITLAB_CI"]) {
    test(`${marker} alone still reports — running in CI is legitimate product usage`, async () => {
      await withEnv({ [marker]: "true" } as any, async () => {
        expect(await shippedRequests()).not.toEqual([])
      })
    })
  }

  test("a test runner inside CI is still suppressed", async () => {
    await withEnv({ CI: "true", GITHUB_ACTIONS: "true", NODE_ENV: "test" }, async () => {
      expect(await shippedRequests()).toEqual([])
    })
  })

  test("an explicit connection string still ships — suites with their own sink keep working", async () => {
    await withEnv(
      {
        NODE_ENV: "test",
        APPLICATIONINSIGHTS_CONNECTION_STRING: "InstrumentationKey=e2e;IngestionEndpoint=https://sink.example.com",
      },
      async () => {
        expect(await shippedRequests()).toEqual(["https://sink.example.com/v2/track"])
      },
    )
  })

  test("ALTIMATE_TELEMETRY_FORCE opts an automated run back in", async () => {
    await withEnv({ NODE_ENV: "test", ALTIMATE_TELEMETRY_FORCE: "true" }, async () => {
      expect(await shippedRequests()).not.toEqual([])
    })
  })

  test("ALTIMATE_TELEMETRY_DISABLED still wins over the force flag", async () => {
    await withEnv({ ALTIMATE_TELEMETRY_DISABLED: "true", ALTIMATE_TELEMETRY_FORCE: "true" }, async () => {
      expect(await shippedRequests()).toEqual([])
    })
  })

  test("ALTIMATE_TELEMETRY_DISABLED still wins over an explicit sink", async () => {
    await withEnv(
      {
        ALTIMATE_TELEMETRY_DISABLED: "true",
        APPLICATIONINSIGHTS_CONNECTION_STRING: "InstrumentationKey=e2e;IngestionEndpoint=https://sink.example.com",
      },
      async () => {
        expect(await shippedRequests()).toEqual([])
      },
    )
  })

  test("the real test runner is detected without any env stubbing", async () => {
    // Every other case sets its env explicitly, so nothing would notice if `bun test` stopped
    // setting NODE_ENV=test — the assumption the whole gate rests on. This one deliberately
    // touches no env at all and relies on the runner's own.
    expect(process.env.NODE_ENV).toBe("test")

    const urls: string[] = []
    const fetchMock = spyOn(global, "fetch").mockImplementation((async (input: any) => {
      urls.push(String(input))
      return new Response("", { status: 200 })
    }) as unknown as typeof fetch)
    try {
      await Telemetry.init()
      Telemetry.track({
        type: "session_start",
        timestamp: 1000,
        session_id: "s1",
        model_id: "m1",
        provider_id: "test",
        agent: "builder",
        project_id: "proj1",
        os: "linux",
        arch: "x64",
        node_version: "v22.0.0",
      })
      await Telemetry.flush()
      expect(urls).toEqual([])
    } finally {
      fetchMock.mockRestore()
    }
  })

  test("an ordinary interactive run is unaffected", async () => {
    await withEnv({}, async () => {
      const urls = await shippedRequests()
      expect(urls.length).toBe(1)
      expect(urls[0]).toContain("applicationinsights.azure.com")
    })
  })
})
