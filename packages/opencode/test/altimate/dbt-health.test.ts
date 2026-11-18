// dbt_health: the DataPilot run through the project's dbt adapter. The adapter and the Python run are
// replaced through their seams, so these tests need no dbt, no Python and no DataPilot.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import type { Tool } from "@/tool/tool"
import { SessionID, MessageID } from "@/session/schema"
import { dbtAdapterInternals, resetDbtAdapter } from "@/altimate/native/connections/register"
import { DbtHealthTool, dbtHealthInternals, flattenInsights, RESULT_BYTES } from "@/altimate/tools/dbt-health"
import { resultFailed } from "@/altimate/mcp-server/adapter"
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
  // The folder as the system names it: the tool reports files under that name.
  project = await realpath(await mkdtemp(path.join(os.tmpdir(), "dbt-health-")))
  await writeFile(path.join(project, "dbt_project.yml"), "name: shop\n")
  await mkdir(path.join(project, "target"), { recursive: true })
  await writeFile(path.join(project, "target", "manifest.json"), "{}")
  await writeFile(path.join(project, "datapilot.yml"), "disabled_insights: []\n")
})

afterAll(async () => {
  await rm(project, { recursive: true, force: true })
})

beforeEach(async () => {
  // A rebuild writes the manifest: the fakes don't, so the fixture reads as freshly written.
  const soon = new Date(Date.now() + 60_000)
  await utimes(path.join(project, "target", "manifest.json"), soon, soon)
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

  test("takes the project name from dbt_project.yml when the manifest metadata has none", async () => {
    const { project: _omitted, ...withoutProject } = HEALTHCHECK
    python.stdout = JSON.stringify(withoutProject) + "\n"
    const result = await run()
    const own = result.metadata.insights[0]
    expect(own.file).toBe(path.join(project, "models", "staging", "stg_orders.sql"))
    expect(own.properties).toBe(path.join(project, "models", "staging", "_staging.yml"))
    const dep = result.metadata.insights.find((i: { uniqueId: string }) => i.uniqueId === "model.dep.base")
    if (dep) expect(dep.file).toBe("")
  })

  test("names a model's files under the real folder when the project is reached through a symlink", async () => {
    const link = path.join(await mkdtemp(path.join(os.tmpdir(), "dbt-health-link-")), "project")
    await symlink(project, link)
    dbtAdapterInternals.create = async () => ({
      isInitialized: () => true,
      getProjectRoot: () => link,
      getManifestPath: () => path.join(project, "target", "manifest.json"),
      parseManifest: async () => parsed,
      dispose: async () => {},
    })
    const result = await run()
    expect(result.metadata.insights[0].file).toBe(path.join(project, "models", "staging", "stg_orders.sql"))
    await rm(path.dirname(link), { recursive: true, force: true })
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

  test("does not run DataPilot when the rebuild returns with a compile error and only the last manifest is left", async () => {
    dbtAdapterInternals.create = async () => ({
      isInitialized: () => true,
      getProjectRoot: () => project,
      rebuildManifest: async () => {},
      getDiagnostics: () => ({ rebuildManifestDiagnostics: [{ message: "Compilation Error: model 'x' depends on a node named 'y' which was not found" }] }),
      parseManifest: async () => parsed,
    })
    const result = await run()
    expect(result.metadata.success).toBe(false)
    expect(result.output).toContain("depends on a node named 'y'")
    expect(python.calls).toHaveLength(0)
  })

  test("says so when the manifest is older than this call's rebuild, as when the adapter's watcher replaced it", async () => {
    const old = new Date(Date.now() - 1_500)
    await utimes(path.join(project, "target", "manifest.json"), old, old)
    dbtAdapterInternals.create = async () => ({
      isInitialized: () => true,
      getProjectRoot: () => project,
      rebuildManifest: async () => {},
      parseManifest: async () => parsed,
    })
    const result = await run()
    expect(result.metadata.success).toBe(true)
    expect(result.metadata.stale_manifest.message).toContain("not rewritten")
  })

  test("a rebuild queued behind another counts from when it starts, not from when its call arrived", async () => {
    let calls = 0
    let entered!: () => void
    const firstEntered = new Promise<void>((r) => (entered = r))
    dbtAdapterInternals.create = async () => ({
      isInitialized: () => true,
      getProjectRoot: () => project,
      // The first rebuild is slow; the queued one resolves at once without writing, as a watcher-replaced one does.
      rebuildManifest: async () => {
        if (calls++ === 0) {
          entered()
          await new Promise((r) => setTimeout(r, 2100))
        }
      },
      parseManifest: async () => parsed,
    })
    const first = run()
    await firstEntered
    // The first rebuild's manifest lands while the second call waits.
    const wrote = new Date()
    await utimes(path.join(project, "target", "manifest.json"), wrote, wrote)
    const second = await run()
    await first
    expect(second.metadata.stale_manifest?.message).toContain("not rewritten")
  })

  test("a rebuild that reports only warnings still runs DataPilot", async () => {
    dbtAdapterInternals.create = async () => ({
      isInitialized: () => true,
      getProjectRoot: () => project,
      rebuildManifest: async () => {},
      getDiagnostics: () => ({ rebuildManifestDiagnostics: [{ severity: "warning", message: "deprecated config" }] }),
      parseManifest: async () => parsed,
    })
    await run()
    expect(python.calls).toHaveLength(1)
  })

  test("reads the rebuild's diagnostics from the integration beneath the adapter, whose own getDiagnostics answers nothing", async () => {
    dbtAdapterInternals.create = async () => ({
      isInitialized: () => true,
      getProjectRoot: () => project,
      rebuildManifest: async () => {},
      getDiagnostics: () => undefined,
      currentIntegration: { getDiagnostics: () => ({ rebuildManifestDiagnostics: [{ message: "Compilation Error: no node 'y'" }] }) },
      parseManifest: async () => parsed,
    })
    const result = await run()
    expect(result.metadata.success).toBe(false)
    expect(result.output).toContain("no node 'y'")
    expect(python.calls).toHaveLength(0)
  })

  test("a refusal or failure is a failed tool call for the CLI and MCP, not a success", async () => {
    dbtAdapterInternals.create = async () => ({
      isInitialized: () => true,
      getProjectRoot: () => project,
      rebuildManifest: async () => {
        throw new Error("boom")
      },
      parseManifest: async () => parsed,
    })
    const failed = await run()
    expect(failed.metadata.success).toBe(false)
    expect(resultFailed(failed)).toBe(true)
    const refused = await run({}, { extra: { forceReadOnly: true } })
    expect(resultFailed(refused)).toBe(true)
  })

  test("a queued call that is cancelled starts no rebuild once the running one ends", async () => {
    let rebuilds = 0
    let rootReads = 0
    let release!: () => void
    dbtAdapterInternals.create = async () => ({
      isInitialized: () => true,
      getProjectRoot: () => (rootReads++, project),
      rebuildManifest: () => (++rebuilds === 1 ? new Promise<void>((r) => (release = r)) : Promise.resolve()),
      parseManifest: async () => parsed,
    })
    const first = run()
    while (rebuilds < 1) await new Promise((r) => setTimeout(r, 2))
    const abort = new AbortController()
    const queued = run({}, { abort: abort.signal })
    while (rootReads < 2) await new Promise((r) => setTimeout(r, 2))
    abort.abort(new Error("cancelled"))
    await expect(queued).rejects.toThrow("cancelled")
    release()
    expect((await first).metadata.success).toBe(true)
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    expect(rebuilds).toBe(1)
  })

  test("the DataPilot script keeps the project folder off the module path", async () => {
    let script = ""
    dbtHealthInternals.runPython = async (_py, s) => {
      script = s
      return { stdout: python.stdout, stderr: "", code: 0 }
    }
    await run()
    expect(script).toContain("sys.path = [p for p in sys.path if p not in (\"\", os.getcwd())]")
    expect(script.indexOf("sys.path =")).toBeLessThan(script.indexOf("from datapilot"))
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
    // A project with `target-path: build`: the last good manifest sits outside target/.
    const built = path.join(project, "build", "manifest.json")
    await mkdir(path.dirname(built), { recursive: true })
    await writeFile(built, "{}")
    parsed = { stale: { writtenAt: Date.UTC(2026, 0, 2, 3, 4, 5), manifestPath: built } }
    const old = await run()
    expect(python.calls.at(-1)!.args[0]).toBe(built)
    expect(old.metadata.success).toBe(true)
    expect(old.metadata.stale_manifest).toMatchObject({
      message: "The dbt project check failed, so these insights come from the manifest of the last successful parse, written 2026-01-02T03:04:05.000Z. They may not match the project as it is now.",
      manifest_path: built,
      written_at: "2026-01-02T03:04:05.000Z",
    })
    expect((old.metadata.stale_manifest as { age_seconds: number }).age_seconds).toBeGreaterThan(0)
    expect(old.output.split("\n")[0]).toContain("last successful parse")
  })

  test("an insight entry that is not an object is a failure, not a throw", async () => {
    python.stdout = JSON.stringify({ model_insights: { "model.shop.orders": [null] }, nodes: {}, project: "shop" }) + "\n"
    const result = await run()
    expect(result.metadata.success).toBe(false)
  })

  test("a manifest that vanishes after the existence check is not a throw", async () => {
    const manifest = path.join(project, "target", "manifest.json")
    dbtAdapterInternals.create = async () => ({
      isInitialized: () => true,
      getProjectRoot: () => project,
      rebuildManifest: async () => {},
      parseManifest: async () => parsed,
    })
    const stat = fs.statSync
    ;(fs as any).statSync = (p: any, ...rest: any[]) => {
      if (p === manifest) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
      return (stat as any)(p, ...rest)
    }
    try {
      const result = await run()
      expect(result.metadata.success).toBe(true)
      expect(result.metadata.stale_manifest).toBeUndefined()
    } finally {
      ;(fs as any).statSync = stat
    }
  })

  test("the byte limit counts UTF-8 bytes, not characters", async () => {
    const cjk = "漢".repeat(20_000)
    const many = Object.fromEntries(
      Array.from({ length: 100 }, (_, n) => [
        `model.shop.m${n}`,
        [{ unique_id: `model.shop.m${n}`, original_file_path: `models/m${n}.sql`, severity: "WARNING", insight: { name: "Big", message: cjk, recommendation: "" } }],
      ]),
    )
    python.stdout = JSON.stringify({ model_insights: many, nodes: {}, project: "shop" }) + "\n"
    const result = await run()
    expect(result.metadata.truncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(result.metadata.insights), "utf8")).toBeLessThanOrEqual(RESULT_BYTES)
  })

  test("a complete result says it is not truncated, however long its text", async () => {
    const text = "x".repeat(1_000)
    const many = Object.fromEntries(
      Array.from({ length: 100 }, (_, n) => [
        `model.shop.m${n}`,
        [{ unique_id: `model.shop.m${n}`, original_file_path: `models/m${n}.sql`, severity: "WARNING", insight: { name: "Big", message: text, recommendation: "" } }],
      ]),
    )
    python.stdout = JSON.stringify({ model_insights: many, nodes: {}, project: "shop" }) + "\n"
    const result = await run()
    expect(result.metadata.insights).toHaveLength(100)
    expect(result.metadata.truncated).toBe(false)
  })

  test("a result over the byte limit is cut, with the total said", async () => {
    const big = "x".repeat(40_000)
    const many = Object.fromEntries(
      Array.from({ length: 100 }, (_, n) => [
        `model.shop.m${n}`,
        [{ unique_id: `model.shop.m${n}`, original_file_path: `models/m${n}.sql`, severity: "WARNING", insight: { name: "Big", message: big, recommendation: "" } }],
      ]),
    )
    python.stdout = JSON.stringify({ model_insights: many, nodes: {}, project: "shop" }) + "\n"
    const result = await run()
    expect(result.metadata.success).toBe(true)
    expect(result.metadata.truncated).toBe(true)
    expect(result.metadata.total).toBe(100)
    expect(result.metadata.insights.length).toBeLessThan(100)
    expect(JSON.stringify(result.metadata.insights).length).toBeLessThanOrEqual(RESULT_BYTES)
    expect(result.title).toBe("dbt_health: 100 insights")
  })

  test("a DataPilot failure is capped, names the version, and hints an upgrade for a manifest it rejects", async () => {
    python.stdout = JSON.stringify({ error: "failed", detail: "Invalid manifest file " + "e".repeat(5000), version: "0.2.0" }) + "\n"
    const result = await run()
    expect(result.metadata.success).toBe(false)
    expect(result.output).toContain("altimate-datapilot-cli 0.2.0")
    expect(result.output).toContain("more characters")
    expect(result.output).toContain("pip install -U altimate-datapilot-cli")
    expect(result.output.length).toBeLessThan(2600)
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

  test.skipIf(!Bun.which("python3"))("the script says \"not installed\" only when the datapilot package itself can't be found", async () => {
    const py = Bun.which("python3")!
    const hostHasDatapilot = Bun.spawnSync([py, "-c", "import datapilot"]).exitCode === 0
    const stubs = await mkdtemp(path.join(os.tmpdir(), "dbt-health-stub-"))
    const originalRun = originals.runPython
    const classify = async (pythonPath: string) => {
      const saved = process.env.PYTHONPATH
      process.env.PYTHONPATH = pythonPath
      try {
        // The interpreter runs isolated, so PYTHONPATH is not read: the stub folder is added to the path inside the process.
        dbtHealthInternals.runPython = (_py, script, args, cwd, signal) => originalRun(py, `import sys\nsys.path.insert(0, ${JSON.stringify(pythonPath)})\n${script}`, args, cwd, signal)
        return await run()
      } finally {
        if (saved === undefined) delete process.env.PYTHONPATH
        else process.env.PYTHONPATH = saved
      }
    }
    try {
      // Nothing named datapilot on the path: not installed (not checkable where the host's Python has it).
      if (!hostHasDatapilot) expect((await classify(stubs)).metadata.missing).toBe("altimate-datapilot-cli")
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

  test("plan mode is refused as a read-only call", async () => {
    const plan = await run({}, { agent: "plan" })
    expect(plan.metadata).toMatchObject({ success: false, refusal: "read_only" })
    expect(plan.output).toContain("--allow-write")
  })

  test("an answer whose model_insights is an array, or holds a non-list, is a failure, not an empty report", async () => {
    for (const bad of [[], { "model.shop.orders": { not: "a list" } }, { "model.shop.orders": "x" }]) {
      python.stdout = JSON.stringify({ model_insights: bad })
      const result = await run()
      expect([JSON.stringify(bad), result.metadata.success]).toEqual([JSON.stringify(bad), false])
    }
  })

  test("an unreadable written-at time of the old manifest is left out, not a throw", async () => {
    parsed = { stale: { writtenAt: Number.NaN, manifestPath: path.join(project, "target", "manifest.json") } }
    const result = await run()
    expect(result.metadata.success).toBe(true)
    expect(result.metadata.stale_manifest.written_at).toBeUndefined()
  })

  test("a rebuild that never finishes stops at the timeout, and a cancelled call stops at once", async () => {
    dbtAdapterInternals.create = async () => ({
      isInitialized: () => true,
      getProjectRoot: () => project,
      rebuildManifest: () => new Promise(() => {}),
      parseManifest: async () => parsed,
    })
    const abort = new AbortController()
    setTimeout(() => abort.abort(new Error("cancelled")), 5)
    dbtHealthInternals.rebuildTimeoutMs = 60_000
    await expect(run({}, { abort: abort.signal })).rejects.toThrow("cancelled")
    expect(python.calls).toHaveLength(0)
    dbtHealthInternals.rebuildTimeoutMs = 20
    const timedOut = await run()
    expect(timedOut.metadata.success).toBe(false)
    expect(timedOut.output).toContain("didn't finish within")
  })

  test("while a rebuild that timed out is still running, no second rebuild starts; once it ends, the next call rebuilds", async () => {
    let rebuilds = 0
    let settle!: () => void
    dbtAdapterInternals.create = async () => ({
      isInitialized: () => true,
      getProjectRoot: () => project,
      rebuildManifest: () => (++rebuilds === 1 ? new Promise<void>((r) => (settle = r)) : Promise.resolve()),
      parseManifest: async () => parsed,
    })
    dbtHealthInternals.rebuildTimeoutMs = 20
    const hung = await run()
    expect(hung.metadata.success).toBe(false)
    const during = await run()
    expect(during.metadata.success).toBe(false)
    expect(during.output).toContain("still running")
    expect(rebuilds).toBe(1)
    settle()
    await new Promise((r) => setImmediate(r))
    const next = await run()
    expect(next.metadata.success).toBe(true)
    expect(rebuilds).toBe(2)
  })

  test("a call queued behind a rebuild that is abandoned after a timeout fails and starts no rebuild of its own", async () => {
    let rebuilds = 0
    let rootReads = 0
    let settle!: () => void
    dbtAdapterInternals.create = async () => ({
      isInitialized: () => true,
      getProjectRoot: () => (rootReads++, project),
      rebuildManifest: () => (++rebuilds === 1 ? new Promise<void>((r) => (settle = r)) : Promise.resolve()),
      parseManifest: async () => parsed,
    })
    dbtHealthInternals.rebuildTimeoutMs = 300
    const first = run()
    while (rebuilds < 1) await new Promise((r) => setTimeout(r, 2))
    const queued = run()
    // The queued call has joined once it has read the project root: its rebuild call is the next step.
    while (rootReads < 2) await new Promise((r) => setTimeout(r, 2))
    const [a, b] = await Promise.all([first, queued])
    expect(a.metadata.success).toBe(false)
    expect(b.metadata.success).toBe(false)
    // the abandoned rebuild settling late does not fire the rebuild queued behind it
    settle()
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    expect(rebuilds).toBe(1)
    const later = await run()
    expect(later.metadata.success).toBe(true)
    expect(rebuilds).toBe(2)
  })

  test("a call that arrives while a rebuild runs gets a rebuild that starts after it; calls in that window share one", async () => {
    const events: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let rebuilds = 0
    let rootReads = 0
    dbtAdapterInternals.create = async () => ({
      isInitialized: () => true,
      getProjectRoot: () => (rootReads++, project),
      rebuildManifest: async () => {
        const n = ++rebuilds
        events.push(`start ${n}`)
        if (n === 1) await gate
        events.push(`end ${n}`)
      },
      parseManifest: async () => parsed,
    })
    const first = run()
    while (rebuilds < 1) await new Promise((r) => setTimeout(r, 5))
    const later = [run(), run()]
    // each call reads the project root, then enters the rebuild with no await in between
    while (rootReads < 3) await new Promise((r) => setTimeout(r, 1))
    expect(rebuilds).toBe(1)
    release()
    const results = await Promise.all([first, ...later])
    expect(results.map((r) => r.metadata.success)).toEqual([true, true, true])
    expect(rebuilds).toBe(2)
    expect(events).toEqual(["start 1", "end 1", "start 2", "end 2"])
  })

  test.skipIf(!Bun.which("python3"))("the script reads a standard-library module from the standard library, not from the project folder, and says no insights when the model level is missing", async () => {
    const py = Bun.which("python3")!
    const dir = await mkdtemp(path.join(os.tmpdir(), "dbt-health-shadow-"))
    try {
      await writeFile(path.join(dir, "json.py"), "raise SystemExit('project json.py was imported')\n")
      const pkg = path.join(dir, "stub")
      const sub = (...p: string[]) => path.join(pkg, "datapilot", ...p)
      await mkdir(sub("config"), { recursive: true })
      await mkdir(sub("core", "platforms", "dbt"), { recursive: true })
      for (const f of [["__init__.py"], ["config", "__init__.py"], ["core", "__init__.py"], ["core", "platforms", "__init__.py"], ["core", "platforms", "dbt", "__init__.py"]])
        await writeFile(sub(...f), "")
      await writeFile(sub("config", "config.py"), "def load_config(p):\n    return None\n")
      await writeFile(sub("core", "platforms", "dbt", "constants.py"), "MODEL = 'model'\n")
      await writeFile(sub("core", "platforms", "dbt", "executor.py"), "class DBTInsightGenerator:\n    def __init__(self, **k):\n        pass\n    def run(self):\n        return {}\n")
      await writeFile(sub("core", "platforms", "dbt", "utils.py"), "def load_manifest(p):\n    return None\n\ndef load_catalog(p):\n    return None\n")
      await mkdir(path.join(dir, "target"), { recursive: true })
      await writeFile(path.join(dir, "target", "manifest.json"), "{}")
      const saved = process.env.PYTHONPATH
      process.env.PYTHONPATH = pkg
      try {
        dbtHealthInternals.runPython = (_py, script, args, cwd, signal) => originals.runPython(py, `import sys\nsys.path.insert(0, ${JSON.stringify(pkg)})\n${script}`, args, cwd, signal)
        dbtAdapterInternals.create = async () => ({ isInitialized: () => true, getProjectRoot: () => dir, parseManifest: async () => parsed })
        const result = await run()
        expect(result.output).not.toContain("json.py")
        expect([result.output, result.metadata.success]).toEqual([result.output, true])
        expect(result.output).toContain("No health insights.")
      } finally {
        if (saved === undefined) delete process.env.PYTHONPATH
        else process.env.PYTHONPATH = saved
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
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
