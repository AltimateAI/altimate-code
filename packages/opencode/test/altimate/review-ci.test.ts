import { describe, test, expect, afterEach } from "bun:test"
import { resolveGitHubTarget } from "../../src/altimate/review/post-github"
import { ReviewCommand } from "../../src/cli/cmd/review"
import { buildReviewSchemaContext } from "../../src/altimate/review/schema-context"

const ENV_KEYS = ["GITHUB_TOKEN", "GH_TOKEN", "GITHUB_REPOSITORY", "GITHUB_EVENT_PATH", "ALTIMATE_PR_NUMBER"]
const saved: Record<string, string | undefined> = {}
for (const k of ENV_KEYS) saved[k] = process.env[k]

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
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
