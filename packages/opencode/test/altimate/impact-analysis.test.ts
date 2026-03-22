/**
 * Tests for the impact_analysis tool — DAG traversal, severity classification,
 * and report formatting.
 *
 * Mocks Dispatcher.call to supply known dbt manifests so we can verify
 * findDownstream logic without a real napi binary or dbt project.
 */
import { describe, test, expect, spyOn, afterAll, beforeEach } from "bun:test"
import * as Dispatcher from "../../src/altimate/native/dispatcher"
import { ImpactAnalysisTool } from "../../src/altimate/tools/impact-analysis"
import { SessionID, MessageID } from "../../src/session/schema"

// Disable telemetry
beforeEach(() => {
  process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
})
afterAll(() => {
  delete process.env.ALTIMATE_TELEMETRY_DISABLED
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "call_test",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

// Spy on Dispatcher.call so we control what "dbt.manifest" and "lineage.check" return
let dispatcherSpy: ReturnType<typeof spyOn>

function mockDispatcher(responses: Record<string, any>) {
  dispatcherSpy?.mockRestore()
  dispatcherSpy = spyOn(Dispatcher, "call").mockImplementation(async (method: string, params: any) => {
    if (responses[method]) return responses[method]
    throw new Error(`No mock for ${method}`)
  })
}

afterAll(() => {
  dispatcherSpy?.mockRestore()
})

describe("impact_analysis: empty / missing manifest", () => {
  test("reports NO MANIFEST when manifest has no models", async () => {
    mockDispatcher({
      "dbt.manifest": { models: [], model_count: 0, test_count: 0 },
    })
    const tool = await ImpactAnalysisTool.init()
    const result = await tool.execute(
      { model: "stg_orders", change_type: "remove", manifest_path: "target/manifest.json", dialect: "snowflake" },
      ctx,
    )
    expect(result.title).toContain("NO MANIFEST")
    expect(result.metadata.success).toBe(false)
    expect(result.output).toContain("dbt compile")
  })

  test("reports MODEL NOT FOUND when model is absent", async () => {
    mockDispatcher({
      "dbt.manifest": {
        models: [{ name: "dim_customers", depends_on: [], materialized: "table" }],
        model_count: 1,
        test_count: 0,
      },
    })
    const tool = await ImpactAnalysisTool.init()
    const result = await tool.execute(
      { model: "stg_orders", change_type: "remove", manifest_path: "target/manifest.json", dialect: "snowflake" },
      ctx,
    )
    expect(result.title).toContain("MODEL NOT FOUND")
    expect(result.metadata.success).toBe(false)
    expect(result.output).toContain("dim_customers")
  })
})

describe("impact_analysis: DAG traversal", () => {
  const linearDAG = {
    models: [
      { name: "stg_orders", depends_on: [], materialized: "view" },
      { name: "int_orders", depends_on: ["stg_orders"], materialized: "ephemeral" },
      { name: "fct_orders", depends_on: ["int_orders"], materialized: "table" },
      { name: "rpt_daily", depends_on: ["fct_orders"], materialized: "table" },
    ],
    model_count: 4,
    test_count: 5,
  }

  test("finds direct and transitive dependents in a linear chain", async () => {
    mockDispatcher({ "dbt.manifest": linearDAG })
    const tool = await ImpactAnalysisTool.init()
    const result = await tool.execute(
      { model: "stg_orders", change_type: "remove", manifest_path: "target/manifest.json", dialect: "snowflake" },
      ctx,
    )
    expect(result.metadata.success).toBe(true)
    expect(result.metadata.direct_count).toBe(1) // int_orders
    expect(result.metadata.transitive_count).toBe(2) // fct_orders, rpt_daily
    expect(result.output).toContain("int_orders")
    expect(result.output).toContain("fct_orders")
    expect(result.output).toContain("rpt_daily")
    expect(result.output).toContain("BREAKING")
  })

  test("SAFE severity when no downstream models exist", async () => {
    mockDispatcher({ "dbt.manifest": linearDAG })
    const tool = await ImpactAnalysisTool.init()
    // rpt_daily is a leaf — nothing depends on it
    const result = await tool.execute(
      { model: "rpt_daily", change_type: "modify", manifest_path: "target/manifest.json", dialect: "snowflake" },
      ctx,
    )
    expect(result.metadata.success).toBe(true)
    expect(result.metadata.severity).toBe("SAFE")
    expect(result.metadata.direct_count).toBe(0)
    expect(result.output).toContain("safe to make")
  })

  test("diamond dependency counts each model only once", async () => {
    mockDispatcher({
      "dbt.manifest": {
        models: [
          { name: "src", depends_on: [], materialized: "view" },
          { name: "left", depends_on: ["src"], materialized: "table" },
          { name: "right", depends_on: ["src"], materialized: "table" },
          { name: "merge", depends_on: ["left", "right"], materialized: "table" },
        ],
        model_count: 4,
        test_count: 0,
      },
    })
    const tool = await ImpactAnalysisTool.init()
    const result = await tool.execute(
      { model: "src", change_type: "rename", manifest_path: "target/manifest.json", dialect: "snowflake" },
      ctx,
    )
    expect(result.metadata.success).toBe(true)
    // left, right are direct; merge is transitive. merge must appear only once.
    expect(result.metadata.direct_count).toBe(2)
    expect(result.metadata.transitive_count).toBe(1)
    // Total = 3, which is LOW severity
    expect(result.metadata.severity).toBe("LOW")
  })

  test("handles dotted depends_on references (e.g. project.model)", async () => {
    mockDispatcher({
      "dbt.manifest": {
        models: [
          { name: "stg_users", depends_on: [], materialized: "view" },
          { name: "dim_users", depends_on: ["myproject.stg_users"], materialized: "table" },
        ],
        model_count: 2,
        test_count: 0,
      },
    })
    const tool = await ImpactAnalysisTool.init()
    const result = await tool.execute(
      { model: "stg_users", change_type: "retype", manifest_path: "target/manifest.json", dialect: "snowflake" },
      ctx,
    )
    expect(result.metadata.success).toBe(true)
    expect(result.metadata.direct_count).toBe(1)
    expect(result.output).toContain("dim_users")
    expect(result.output).toContain("CAUTION") // retype warning
  })
})

describe("impact_analysis: severity classification", () => {
  function makeManifest(downstreamCount: number) {
    const models = [{ name: "root", depends_on: [] as string[], materialized: "view" }]
    for (let i = 0; i < downstreamCount; i++) {
      models.push({ name: `model_${i}`, depends_on: ["root"], materialized: "table" })
    }
    return { models, model_count: models.length, test_count: 0 }
  }

  test("LOW severity boundary: exactly 3 downstream models", async () => {
    mockDispatcher({ "dbt.manifest": makeManifest(3) })
    const tool = await ImpactAnalysisTool.init()
    const result = await tool.execute(
      { model: "root", change_type: "modify", manifest_path: "target/manifest.json", dialect: "snowflake" },
      ctx,
    )
    expect(result.metadata.severity).toBe("LOW")
  })

  test("MEDIUM severity boundary: exactly 4 downstream models", async () => {
    mockDispatcher({ "dbt.manifest": makeManifest(4) })
    const tool = await ImpactAnalysisTool.init()
    const result = await tool.execute(
      { model: "root", change_type: "modify", manifest_path: "target/manifest.json", dialect: "snowflake" },
      ctx,
    )
    expect(result.metadata.severity).toBe("MEDIUM")
  })

  test("MEDIUM severity boundary: exactly 10 downstream models", async () => {
    mockDispatcher({ "dbt.manifest": makeManifest(10) })
    const tool = await ImpactAnalysisTool.init()
    const result = await tool.execute(
      { model: "root", change_type: "modify", manifest_path: "target/manifest.json", dialect: "snowflake" },
      ctx,
    )
    expect(result.metadata.severity).toBe("MEDIUM")
  })

  test("HIGH severity boundary: exactly 11 downstream models", async () => {
    mockDispatcher({ "dbt.manifest": makeManifest(11) })
    const tool = await ImpactAnalysisTool.init()
    const result = await tool.execute(
      { model: "root", change_type: "modify", manifest_path: "target/manifest.json", dialect: "snowflake" },
      ctx,
    )
    expect(result.metadata.severity).toBe("HIGH")
  })
})

describe("impact_analysis: error handling", () => {
  test("returns ERROR when Dispatcher throws", async () => {
    mockDispatcher({}) // no mock for dbt.manifest — will throw
    const tool = await ImpactAnalysisTool.init()
    const result = await tool.execute(
      { model: "x", change_type: "remove", manifest_path: "target/manifest.json", dialect: "snowflake" },
      ctx,
    )
    expect(result.title).toContain("ERROR")
    expect(result.metadata.success).toBe(false)
    expect(result.output).toContain("dbt compile")
  })
})

describe("impact_analysis: blast radius percentage", () => {
  test("percentage uses model_count, not models array length", async () => {
    // model_count (20) intentionally differs from models.length (4)
    // to verify the denominator comes from the declared count
    mockDispatcher({
      "dbt.manifest": {
        models: [
          { name: "root", depends_on: [], materialized: "view" },
          { name: "child1", depends_on: ["root"], materialized: "table" },
          { name: "child2", depends_on: ["root"], materialized: "table" },
          { name: "unrelated", depends_on: [], materialized: "view" },
        ],
        model_count: 20,
        test_count: 3,
      },
    })
    const tool = await ImpactAnalysisTool.init()
    const result = await tool.execute(
      { model: "root", change_type: "remove", manifest_path: "target/manifest.json", dialect: "snowflake" },
      ctx,
    )
    // 2 downstream out of 20 declared = 10.0%
    expect(result.output).toContain("10.0%")
    expect(result.output).toContain("2/20")
  })
})
