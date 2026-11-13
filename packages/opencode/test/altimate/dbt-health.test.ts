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
  project: "shop",
  nodes: {
    "model.shop.stg_orders": { package: "shop", file: "models/staging/stg_orders.sql", patch: "shop://models/staging/_staging.yml" },
    "model.shop.customers": { package: "shop", file: "models/customers.sql", patch: null },
    "model.dep.base": { package: "dep", file: "models/base.sql", patch: null },
  },
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
    "model.dep.base": [
      {
        unique_id: "model.dep.base",
        package_name: "dep",
        path: "models/base.sql",
        original_file_path: "models/base.sql",
        insight_level: "model",
        severity: "INFO",
        insight: { name: "Missing tests", type: "Testing", message: "No tests.", recommendation: "Add some.", reason_to_flag: "", metadata: {} },
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
let parses = 0
let order: string[] = []
let parsed: unknown
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
  parses = 0
  order = []
  parsed = { stale: undefined }
  python = { calls: [], stdout: JSON.stringify(HEALTHCHECK) + "\n", code: 0 }
  dbtAdapterInternals.readConfig = async () => ({ projectRoot: project, pythonPath: "/venv/bin/python", dbtIntegration: "corecommand", queryLimit: 500 })
  dbtAdapterInternals.create = async () => ({
    isInitialized: () => true,
    getProjectRoot: () => project,
    rebuildManifest: async () => {
      order.push("rebuild")
    },
    parseManifest: async () => {
      parses += 1
      order.push("parse")
      return parsed
    },
    dispose: async () => {},
  })
  dbtHealthInternals.discoverPython = async () => "/discovered/python"
  dbtHealthInternals.runPython = async (py, _script, args, cwd) => {
    order.push("python")
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
        file: path.join(project, "models", "staging", "stg_orders.sql"),
        properties: path.join(project, "models", "staging", "_staging.yml"),
      },
      // Another package's model carries no files: an edit in the project can't be about it.
      {
        uniqueId: "model.dep.base",
        path: "models/base.sql",
        name: "Missing tests",
        severity: "INFO",
        message: "No tests.",
        recommendation: "Add some.",
        file: "",
        properties: "",
      },
      {
        uniqueId: "model.shop.customers",
        path: "models/customers.sql",
        name: "Missing documentation",
        severity: "ERROR",
        message: "No description.",
        recommendation: "Add one.",
        file: path.join(project, "models", "customers.sql"),
        properties: "",
      },
    ])
    expect(result.title).toBe("dbt_health: 3 insights")
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

  test("runs DataPilot under the Python the dbt config names, not one found for the project", async () => {
    dbtAdapterInternals.readConfig = async () => ({ projectRoot: project, pythonPath: "/pyenv/dbt/bin/python", dbtIntegration: "corecommand", queryLimit: 500 })
    await run()
    expect(python.calls[0].python).toBe("/pyenv/dbt/bin/python")
  })

  test("falls back to the Python found for the project when the config names none", async () => {
    dbtAdapterInternals.readConfig = async () => ({ projectRoot: project, dbtIntegration: "corecommand", queryLimit: 500 })
    await run()
    expect(python.calls[0].python).toBe("/discovered/python")
  })

  test("rebuilds the manifest, and waits for it, before it parses and reads it", async () => {
    await run()
    expect(order).toEqual(["rebuild", "parse", "python"])
  })

  test("does not run DataPilot when the rebuild fails", async () => {
    dbtAdapterInternals.create = async () => ({
      isInitialized: () => true,
      getProjectRoot: () => project,
      rebuildManifest: async () => {
        throw new Error("dbt parse failed")
      },
      parseManifest: async () => parsed,
    })
    const result = await run()
    expect(result.metadata.success).toBe(false)
    expect(result.output).toContain("dbt parse failed")
    expect(python.calls).toHaveLength(0)
  })

  test("an answer that isn't the script's (a log object, an empty list) or comes with a failing exit is not a clean report", async () => {
    for (const [stdout, code] of [['{"event":"starting"}\n', 1], ["[]\n", 0], [JSON.stringify(HEALTHCHECK) + "\n", 1]] as const) {
      python.stdout = stdout
      python.code = code
      const result = await run()
      expect([stdout, result.metadata.success]).toEqual([stdout, false])
    }
  })

  test("the text lists at most 100 insights and says how many more the result carries", async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ unique_id: "model.shop.m", path: "models/m.sql", severity: "WARNING", insight: { name: `Insight ${i}`, message: "m", recommendation: "r" } }))
    python.stdout = JSON.stringify({ model_insights: { "model.shop.m": many } })
    const result = await run()
    expect(result.metadata.insights).toHaveLength(150)
    expect(result.output.split("\n")).toHaveLength(101)
    expect(result.output).toContain("and 50 more insights")
  })

  test("a Python that can't be found is a failure, not a throw", async () => {
    dbtHealthInternals.discoverPython = async () => {
      throw new Error("no python here")
    }
    dbtAdapterInternals.readConfig = async () => ({ projectRoot: project, dbtIntegration: "corecommand", queryLimit: 500 })
    const result = await run()
    expect(result.metadata.success).toBe(false)
    expect(result.output).toContain("no python here")
  })

  test("parses the project before it reads the manifest, and says so when that fell back to an old one", async () => {
    const fresh = await run()
    expect(parses).toBe(1)
    expect(order).toEqual(["rebuild", "parse", "python"])
    expect(fresh.metadata.stale_manifest).toBeUndefined()
    parsed = { stale: { writtenAt: Date.UTC(2026, 0, 2, 3, 4, 5), manifestPath: "x" } }
    const old = await run()
    expect(old.metadata.success).toBe(true)
    expect(old.metadata.stale_manifest).toMatchObject({
      message: "The dbt project check failed, so these insights come from the manifest of the last successful parse, written 2026-01-02T03:04:05.000Z. They may not match the project as it is now.",
      manifest_path: "x",
      written_at: "2026-01-02T03:04:05.000Z",
    })
    expect((old.metadata.stale_manifest as { age_seconds: number }).age_seconds).toBeGreaterThan(0)
    expect(old.output.split("\n")[0]).toContain("last successful parse")
  })

  test("does not run DataPilot when the project can't be parsed", async () => {
    dbtAdapterInternals.create = async () => ({
      isInitialized: () => true,
      getProjectRoot: () => project,
      parseManifest: async () => {
        throw new Error("Compilation Error in model x")
      },
    })
    const result = await run()
    expect(result.metadata.success).toBe(false)
    expect(result.output).toContain("Compilation Error in model x")
    expect(python.calls).toHaveLength(0)
  })

  test("says no insights when there are none", async () => {
    python.stdout = JSON.stringify({ model_insights: {} })
    const result = await run()
    expect(result.metadata.insights).toEqual([])
    expect(result.output).toBe("No health insights.")
  })

  test("reads the answer from the last JSON line when DataPilot logs to stdout", async () => {
    python.stdout = `INFO:dbt-insight-generator:Running insight x\n${JSON.stringify(HEALTHCHECK)}\n`
    expect((await run()).metadata.insights).toHaveLength(3)
  })

  test("names altimate-datapilot-cli when DataPilot isn't importable, and installs nothing", async () => {
    python.stdout = JSON.stringify({ error: "missing_datapilot", detail: "No module named 'datapilot'" })
    const result = await run()
    expect(result.metadata.success).toBe(false)
    expect(result.metadata.missing).toBe("altimate-datapilot-cli")
    expect(result.output).toContain("altimate-datapilot-cli")
    expect(python.calls).toHaveLength(1)
  })

  test("the script says \"not installed\" only when the datapilot package itself can't be found", async () => {
    const py = Bun.which("python3")
    if (!py) return
    const stubs = await mkdtemp(path.join(os.tmpdir(), "dbt-health-stub-"))
    const originalRun = originals.runPython
    const classify = async (pythonPath: string) => {
      const saved = process.env.PYTHONPATH
      process.env.PYTHONPATH = pythonPath
      try {
        dbtHealthInternals.runPython = (_py, script, args, cwd, signal) => originalRun(py, script, args, cwd, signal)
        return await run()
      } finally {
        if (saved === undefined) delete process.env.PYTHONPATH
        else process.env.PYTHONPATH = saved
      }
    }
    try {
      // Nothing named datapilot on the path: not installed.
      expect((await classify(stubs)).metadata.missing).toBe("altimate-datapilot-cli")
      // datapilot there, but one of its own imports can't be satisfied: a failure, not a missing package.
      await mkdir(path.join(stubs, "datapilot", "config"), { recursive: true })
      await writeFile(path.join(stubs, "datapilot", "__init__.py"), "")
      await writeFile(path.join(stubs, "datapilot", "config", "__init__.py"), "")
      await writeFile(path.join(stubs, "datapilot", "config", "config.py"), "import not_a_real_dependency_xyz\n")
      const broken = await classify(stubs)
      expect(broken.metadata.success).toBe(false)
      expect(broken.metadata.missing).toBeUndefined()
      expect(broken.output).toContain("not_a_real_dependency_xyz")
      // datapilot there, but a name it should export is gone (a version mismatch): also a failure.
      await writeFile(path.join(stubs, "datapilot", "config", "config.py"), "")
      const mismatch = await classify(stubs)
      expect(mismatch.metadata.success).toBe(false)
      expect(mismatch.metadata.missing).toBeUndefined()
      expect(mismatch.output).toContain("load_config")
    } finally {
      await rm(stubs, { recursive: true, force: true })
    }
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
