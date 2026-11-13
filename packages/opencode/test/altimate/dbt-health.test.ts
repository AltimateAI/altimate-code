// dbt_health: the DataPilot run through the project's dbt adapter. The adapter and the Python run are
// replaced through their seams, so these tests need no dbt, no Python and no DataPilot.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import type { Tool } from "@/tool/tool"
import { SessionID, MessageID } from "@/session/schema"
import { dbtAdapterInternals, resetDbtAdapter } from "@/altimate/native/connections/register"
import { DbtHealthTool, dbtHealthInternals, flattenInsights } from "@/altimate/tools/dbt-health"
import { initTool } from "./tool-fixture"

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_dbt_health"),
  messageID: MessageID.make("msg_dbt_health"),
  agent: "analyst",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

// What dbt-integration's project_healthcheck returns, as DataPilot serialises it.
const HEALTHCHECK = {
  model_insights: {
    "model.shop.stg_orders": [
      {
        unique_id: "model.shop.stg_orders",
        package_name: "shop",
        path: "models/staging/stg_orders.sql",
        original_file_path: "models/staging/stg_orders.sql",
        insight_level: "model",
        severity: "WARNING",
        insight: {
          name: "Hard coded references",
          type: "Modelling Insights",
          message: "Model stg_orders has hard-coded references to raw.orders.",
          recommendation: "Use source() or ref() instead.",
          reason_to_flag: "",
          metadata: {},
        },
      },
    ],
    "model.shop.customers": [
      {
        unique_id: "model.shop.customers",
        package_name: "shop",
        path: "models/customers.sql",
        original_file_path: "models/customers.sql",
        insight_level: "model",
        severity: "ERROR",
        insight: { name: "Missing documentation", type: "Documentation", message: "No description.", recommendation: "Add one.", reason_to_flag: "", metadata: {} },
      },
    ],
  },
}

let project: string
let python: { calls: { python: string; args: string[]; cwd: string }[]; stdout: string; code: number }
const originals = { ...dbtHealthInternals }

beforeAll(async () => {
  project = await mkdtemp(path.join(os.tmpdir(), "dbt-health-"))
  await writeFile(path.join(project, "dbt_project.yml"), "name: shop\n")
  await mkdir(path.join(project, "target"), { recursive: true })
  await writeFile(path.join(project, "target", "manifest.json"), "{}")
  await writeFile(path.join(project, "datapilot.yml"), "disabled_insights: []\n")
})

afterAll(async () => {
  await rm(project, { recursive: true, force: true })
})

beforeEach(() => {
  resetDbtAdapter()
  python = { calls: [], stdout: JSON.stringify(HEALTHCHECK) + "\n", code: 0 }
  dbtAdapterInternals.readConfig = async () => ({ projectRoot: project, pythonPath: "python3", dbtIntegration: "corecommand", queryLimit: 500 })
  dbtAdapterInternals.create = async () => ({ isInitialized: () => true, getProjectRoot: () => project, dispose: async () => {} })
  dbtHealthInternals.discoverPython = async () => "/venv/bin/python"
  dbtHealthInternals.runPython = async (py, _script, args, cwd) => {
    python.calls.push({ python: py, args, cwd })
    return { stdout: python.stdout, stderr: "", code: python.code }
  }
})

afterEach(() => {
  resetDbtAdapter()
  delete dbtAdapterInternals.readConfig
  delete dbtAdapterInternals.create
  Object.assign(dbtHealthInternals, originals)
})

const run = async (args: Record<string, unknown> = {}, extra: Partial<Tool.Context> = {}) =>
  (await initTool(DbtHealthTool)).execute(args, { ...ctx, ...extra })

describe("dbt_health", () => {
  test("returns every model's insights as a flat list", async () => {
    const result = await run()
    expect(result.metadata.success).toBe(true)
    expect(result.metadata.insights).toEqual([
      {
        uniqueId: "model.shop.stg_orders",
        path: "models/staging/stg_orders.sql",
        name: "Hard coded references",
        severity: "WARNING",
        message: "Model stg_orders has hard-coded references to raw.orders.",
        recommendation: "Use source() or ref() instead.",
      },
      {
        uniqueId: "model.shop.customers",
        path: "models/customers.sql",
        name: "Missing documentation",
        severity: "ERROR",
        message: "No description.",
        recommendation: "Add one.",
      },
    ])
    expect(result.title).toBe("dbt_health: 2 insights")
  })

  test("runs DataPilot over the project's manifest with the project's Python and no config by default", async () => {
    await run()
    expect(python.calls).toEqual([{ python: "/venv/bin/python", args: [path.join(project, "target", "manifest.json"), "", ""], cwd: project }])
  })

  test("passes the catalog when one exists beside the manifest, and a config resolved against the project", async () => {
    await writeFile(path.join(project, "target", "catalog.json"), "{}")
    try {
      await run({ config_path: "datapilot.yml" })
    } finally {
      await rm(path.join(project, "target", "catalog.json"))
    }
    expect(python.calls[0].args).toEqual([
      path.join(project, "target", "manifest.json"),
      path.join(project, "target", "catalog.json"),
      path.join(project, "datapilot.yml"),
    ])
  })

  test("never sends DataPilot's All mode: nothing but the manifest, catalog and config reach it", async () => {
    await run()
    expect(python.calls[0].args).toHaveLength(3)
  })

  test("says no insights when there are none", async () => {
    python.stdout = JSON.stringify({ model_insights: {} })
    const result = await run()
    expect(result.metadata.insights).toEqual([])
    expect(result.output).toBe("No health insights.")
  })

  test("reads the answer from the last JSON line when DataPilot logs to stdout", async () => {
    python.stdout = `INFO:dbt-insight-generator:Running insight x\n${JSON.stringify(HEALTHCHECK)}\n`
    expect((await run()).metadata.insights).toHaveLength(2)
  })

  test("names altimate-datapilot-cli when DataPilot isn't importable, and installs nothing", async () => {
    python.stdout = JSON.stringify({ error: "missing_datapilot", detail: "No module named 'datapilot'" })
    const result = await run()
    expect(result.metadata.success).toBe(false)
    expect(result.metadata.missing).toBe("altimate-datapilot-cli")
    expect(result.output).toContain("altimate-datapilot-cli")
    expect(python.calls).toHaveLength(1)
  })

  test("reports a DataPilot failure", async () => {
    python.stdout = JSON.stringify({ error: "failed", detail: "bad manifest" })
    const result = await run()
    expect(result.metadata.success).toBe(false)
    expect(result.output).toContain("bad manifest")
  })

  test("reports an answer it can't read", async () => {
    python.stdout = "Traceback\n"
    python.code = 1
    const result = await run()
    expect(result.metadata.success).toBe(false)
    expect(result.output).toContain("exit 1")
  })

  test("reports a Python that can't be started", async () => {
    dbtHealthInternals.runPython = async () => {
      throw new Error("spawn /venv/bin/python ENOENT")
    }
    const result = await run()
    expect(result.metadata.success).toBe(false)
    expect(result.output).toContain("ENOENT")
  })

  test("a read-only call starts nothing and runs nothing", async () => {
    let created = 0
    dbtAdapterInternals.create = async () => {
      created += 1
      return { isInitialized: () => true }
    }
    const result = await run({}, { extra: { forceReadOnly: true } })
    expect(result.metadata).toMatchObject({ success: false, refusal: "read_only" })
    expect(result.output).toContain("--allow-write")
    expect(created).toBe(0)
    expect(python.calls).toHaveLength(0)
  })

  test("says to run dbt when there is no manifest", async () => {
    await rm(path.join(project, "target", "manifest.json"))
    try {
      const result = await run()
      expect(result.metadata.success).toBe(false)
      expect(result.output).toContain("no manifest")
      expect(python.calls).toHaveLength(0)
    } finally {
      await writeFile(path.join(project, "target", "manifest.json"), "{}")
    }
  })

  test("says when the config file doesn't exist", async () => {
    const result = await run({ config_path: "missing.yml" })
    expect(result.metadata.success).toBe(false)
    expect(result.output).toContain("missing.yml")
    expect(python.calls).toHaveLength(0)
  })
})

describe("flattenInsights", () => {
  test("ignores a malformed answer", () => {
    expect(flattenInsights(null)).toEqual([])
    expect(flattenInsights({ "model.a": "nope" })).toEqual([])
  })
})
