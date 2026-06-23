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
