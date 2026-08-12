/**
 * The path-taking dbt reader tools (dbt_manifest, dbt_lineage,
 * dbt_unit_test_gen) must route out-of-project paths through the
 * external_directory permission gate, exactly like `read` — otherwise a
 * read-scoped agent (e.g. dbt-optimizer) could silently extract model
 * inventories or lineage from sibling/private projects.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import path from "path"
import os from "os"
import { initTool } from "../tool-fixture"
import * as Dispatcher from "../../../src/altimate/native/dispatcher"
import { Instance } from "../../../src/project/instance"
import { tmpdir } from "../../fixture/fixture"
import { DbtManifestTool } from "../../../src/altimate/tools/dbt-manifest"
import { DbtLineageTool } from "../../../src/altimate/tools/dbt-lineage"
import { DbtUnitTestGenTool } from "../../../src/altimate/tools/dbt-unit-test-gen"
import { SessionID, MessageID } from "../../../src/session/schema"

function makeCtx() {
  const asks: any[] = []
  const ctx = {
    sessionID: SessionID.make("ses_test"),
    messageID: MessageID.make("msg_test"),
    callID: "call_test",
    agent: "test",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => {},
    ask: async (req: any) => {
      asks.push(req)
    },
  } as any
  return { ctx, asks }
}

function mockHandlers() {
  Dispatcher.register("dbt.manifest" as any, async () => ({
    model_count: 0,
    source_count: 0,
    test_count: 0,
    snapshot_count: 0,
    seed_count: 0,
    models: [],
    sources: [],
  }))
  Dispatcher.register("dbt.lineage" as any, async () => ({
    model_name: "m",
    confidence: "high",
    confidence_factors: [],
  }))
  Dispatcher.register("dbt.unit_test_gen" as any, async () => ({
    success: true,
    model_name: "m",
    yaml: "",
    scenarios: [],
  }))
}

const OUTSIDE = path.join(os.tmpdir(), "definitely-not-the-project", "target", "manifest.json")

describe("dbt reader tools enforce external_directory", () => {
  beforeEach(() => Dispatcher.reset())
  // The dispatcher registry is module-global: without teardown the mock
  // dbt.* handlers would leak into later test files in the same process.
  afterEach(() => Dispatcher.reset())

  test("out-of-project manifest paths trigger the external_directory ask", async () => {
    mockHandlers()
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        for (const [tool, args] of [
          [DbtManifestTool, { path: OUTSIDE }],
          [DbtLineageTool, { manifest_path: OUTSIDE, model: "m" }],
          [DbtUnitTestGenTool, { manifest_path: OUTSIDE, model: "m" }],
        ] as const) {
          const { ctx, asks } = makeCtx()
          const t = await initTool(tool as any)
          await t.execute(args as any, ctx)
          expect(asks.some((a) => a.permission === "external_directory")).toBe(true)
        }
      },
    })
  })

  test("in-project manifest paths pass without an ask — all three tools", async () => {
    mockHandlers()
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const inside = path.join(tmp.path, "target", "manifest.json")
        for (const [tool, args] of [
          [DbtManifestTool, { path: inside }],
          [DbtLineageTool, { manifest_path: inside, model: "m" }],
          [DbtUnitTestGenTool, { manifest_path: inside, model: "m" }],
        ] as const) {
          const { ctx, asks } = makeCtx()
          const t = await initTool(tool as any)
          await t.execute(args as any, ctx)
          expect(asks).toEqual([])
        }
      },
    })
  })

  test("relative paths resolve against the PROJECT directory, not process cwd", async () => {
    mockHandlers()
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // "target/manifest.json" must be treated as inside the project (no ask)
        // regardless of what the process cwd happens to be.
        const { ctx, asks } = makeCtx()
        const t = await initTool(DbtManifestTool)
        await t.execute({ path: path.join("target", "manifest.json") } as any, ctx)
        expect(asks).toEqual([])
      },
    })
  })
})
