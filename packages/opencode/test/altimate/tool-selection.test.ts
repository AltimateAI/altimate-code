import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { SessionPrompt } from "../../src/session/prompt"
import { ToolRegistry } from "../../src/tool/registry"
import { LLM } from "../../src/session/llm"
import { FRAGMENTS } from "../../src/altimate/prompts/profiles"
import { ToolSelection as TS } from "../../src/altimate/tool-selection"
import { Dispatcher } from "../../src/altimate/native"
import { tmpdir, provideTestInstance } from "../fixture/fixture"

// The first call into the native SQL engine loads it, which is slow on a loaded machine.
setDefaultTimeout(30_000)

const KEY = "ALTIMATE_SMALLER_TOOL_LIST"
const ORIGINAL_SWITCH = process.env[KEY]

// The hidden-tool target used below calls the native SQL engine. Other test files reset the shared
// dispatcher, so register a deterministic stand-in instead of depending on test order.
function standInForNativeImportDdl() {
  // Clearing the lazy registration hook as well, or the first call would install the real handler over the stand-in.
  Dispatcher.reset()
  Dispatcher.register("altimate_core.import_ddl" as any, (async (params: { ddl: string }) => ({
    success: true,
    data: { schema: { parsed_from: params.ddl } },
  })) as any)
}

/** Ids that are always offered: every tool the groups do not list, plus the ones the instructions name. */
const ALWAYS = ["bash", "read", "glob", "grep", "edit", "write", "task", "todowrite", "skill", "webfetch", "tool_lookup", "invalid"]

const STATES: TS.Facts[] = []
for (const dbtProject of [false, true])
  for (const sqlFiles of [false, true])
    for (const warehouse of [false, true])
      for (const memory of [false, true]) STATES.push({ dbtProject, sqlFiles, warehouse, memory })

beforeEach(standInForNativeImportDdl)

afterEach(() => {
  if (ORIGINAL_SWITCH === undefined) delete process.env[KEY]
  else process.env[KEY] = ORIGINAL_SWITCH
  TS.reset()
})

describe("tool selection rule", () => {
  test("core tools are offered in every project state", async () => {
    const ids = (await registryIds()).filter((id) => id !== "invalid")
    for (const facts of STATES) {
      const hidden = new Set(TS.hiddenIds(ids, TS.groupsFor(facts)))
      for (const id of ALWAYS) expect(hidden.has(id)).toBe(false)
    }
  })

  test("same facts give the same hidden set and the same tool_run definition", async () => {
    const ids = await registryIds()
    const facts = { dbtProject: true, sqlFiles: true, warehouse: false, memory: false }
    const a = TS.hiddenIds(ids, TS.groupsFor(facts))
    const b = TS.hiddenIds(ids, TS.groupsFor({ ...facts }))
    expect(b).toEqual(a)
    expect(TS.runDescription(b)).toBe(TS.runDescription(a))
    // The description lists tools by group, so it does not depend on the order the registry returned them in.
    expect(TS.runDescription([...a].reverse())).toBe(TS.runDescription(a))
  })

  test("a tool the groups do not know is never hidden", () => {
    expect(TS.hiddenIds(["brand_new_tool", "custom_plugin_tool"], TS.groupsFor({ dbtProject: false, sqlFiles: false, warehouse: false, memory: false }))).toEqual([])
  })

  test("every grouped id is a real registered tool (the groups cannot drift from the registry)", async () => {
    const ids = new Set(await registryIds())
    const optionalOnlyWhenFlagged = new Set(["altimate_memory_extract", "altimate_memory_refresh"])
    for (const def of Object.values(TS.GROUPS))
      for (const id of def.tools) if (!optionalOnlyWhenFlagged.has(id)) expect(ids.has(id)).toBe(true)
    for (const id of TS.NAMED_BY_PROMPT) expect(ids.has(id)).toBe(true)
  })

  test("no tool is in two groups", () => {
    const seen = new Set<string>()
    for (const def of Object.values(TS.GROUPS))
      for (const id of def.tools) {
        expect(seen.has(id)).toBe(false)
        seen.add(id)
      }
  })

  test("every optional tool the builder instructions name is offered in every project state", async () => {
    const instructions = ["core", "core-training", "dbt-ops", "sql-guard", "dbt-verify", "dbt-workflow", "pitfalls", "self-review", "legacy-skills-catalogue", "finish"]
      .map((name) => FRAGMENTS[name as keyof typeof FRAGMENTS])
      .join("\n")
    const ids = (await registryIds()).filter((id) => id !== "invalid")
    const named = ids.filter((id) => new RegExp(`\\b${id}\\b`).test(instructions))
    expect(named.length).toBeGreaterThan(8) // the scan really finds the tools the packs name
    for (const facts of STATES) {
      const hidden = new Set(TS.hiddenIds(ids, TS.groupsFor(facts)))
      for (const id of named) expect(hidden.has(id)).toBe(false)
    }
  })

  test("project facts: dbt in a subfolder is found; dependency folders and dot-folders are not searched", async () => {
    const mk = async (files: Record<string, string>) =>
      inProject(
        async (dir) => {
          for (const [name, body] of Object.entries(files)) await Bun.write(path.join(dir, name), body)
        },
        (dir) => TS.detectFacts({ directory: dir, home: path.join(dir, "nohome"), memoryPresent: async () => false }),
      )
    expect(await mk({ "analytics/dbt_project.yml": "name: a\n" })).toMatchObject({ dbtProject: true })
    expect(await mk({ "src/sql/reports/q.sql": "select 1\n" })).toMatchObject({ dbtProject: false, sqlFiles: true })
    expect(await mk({ "node_modules/x/dbt_project.yml": "a", ".hidden/dbt_project.yml": "a", "a/b/c/d/dbt_project.yml": "a" })).toMatchObject({ dbtProject: false })
    expect(await mk({ "readme.md": "hi" })).toMatchObject({ dbtProject: false, sqlFiles: false, warehouse: false })
    expect(await mk({ ".altimate-code/connections.json": '{"wh":{"type":"duckdb"}}' })).toMatchObject({ warehouse: true })
    expect(await mk({ ".altimate-code/connections.json": "{}" })).toMatchObject({ warehouse: false })
  })

  test("a tool the agent's own instructions name is offered whatever the project looks like", () => {
    const on = TS.groupsFor({ dbtProject: false, sqlFiles: false, warehouse: false, memory: false })
    const ids = ["finops_query_history", "finops_role_grants", "schema_tags", "altimate_core_fingerprint"]
    expect(TS.hiddenIds(ids, on)).toEqual(ids)
    const hidden = TS.hiddenIds(ids, on, "Use finops_query_history for spend. Also call schema_tags_list and finops_role_grants_extra.")
    expect(hidden).toEqual(["finops_role_grants", "schema_tags", "altimate_core_fingerprint"]) // whole-word match only
  })

  test("project facts: a large folder does not use up the scan before a sibling is reached", async () => {
    const found = await inProject(
      async (dir) => {
        for (let i = 0; i < 700; i++) await Bun.write(path.join(dir, "apps", `f${String(i).padStart(4, "0")}.txt`), "x")
        await Bun.write(path.join(dir, "transform", "dbt_project.yml"), "name: t\n")
      },
      (dir) => TS.detectFacts({ directory: dir, home: path.join(dir, "nohome"), memoryPresent: async () => false }),
    )
    expect(found.dbtProject).toBe(true)
  })

  test("project facts: parents up to the project boundary, root markers past a large folder, upper-case SQL, usable connections only", async () => {
    const facts = (files: Record<string, string>, pick: (dir: string) => { directory: string; root?: string }) =>
      inProject(
        async (dir) => {
          for (const [name, body] of Object.entries(files)) await Bun.write(path.join(dir, name), body)
        },
        (dir) => TS.detectFacts({ ...pick(dir), home: path.join(dir, "nohome"), memoryPresent: async () => false }),
      )
    // session started in a subfolder of a dbt project
    expect(await facts({ "dbt_project.yml": "name: a\n", "models/marts/x.sql": "select 1" }, (d) => ({ directory: path.join(d, "models", "marts"), root: d }))).toMatchObject({ dbtProject: true })
    // a sibling folder that merely shares the boundary's prefix is not inside it, and "/" is no boundary
    expect(await facts({ "dbt_project.yml": "a", "sub/x.txt": "x" }, (d) => ({ directory: path.join(d, "sub"), root: path.parse(d).root }))).toMatchObject({ dbtProject: false })
    // but not above the boundary
    expect(await facts({ "dbt_project.yml": "name: a\n", "sub/x.txt": "x" }, (d) => ({ directory: path.join(d, "sub"), root: path.join(d, "sub") }))).toMatchObject({ dbtProject: false })
    // a root marker is found even when many earlier-named folders exist
    const many: Record<string, string> = { "zz/dbt_project.yml": "a" }
    for (let i = 0; i < 600; i++) many[`a${String(i).padStart(4, "0")}/f.txt`] = "x"
    expect(await facts({ ...many, "dbt_project.yml": "name: r\n" }, (d) => ({ directory: d }))).toMatchObject({ dbtProject: true })
    expect(await facts({ "Report.SQL": "select 1" }, (d) => ({ directory: d }))).toMatchObject({ sqlFiles: true })
    // connections: only entries the registry would accept count
    const saved = process.env.ALTIMATE_CODE_CONN_PROBE
    // Other connection variables in the caller's environment must not leak into the probe.
    const others = Object.entries(process.env).filter(([k]) => k.startsWith("ALTIMATE_CODE_CONN_") && k !== "ALTIMATE_CODE_CONN_PROBE")
    for (const [k] of others) delete process.env[k]
    try {
      process.env.ALTIMATE_CODE_CONN_PROBE = "not-json"
      expect(await facts({}, (d) => ({ directory: d }))).toMatchObject({ warehouse: false })
      process.env.ALTIMATE_CODE_CONN_PROBE = '{"type":"duckdb","path":"x.db"}'
      expect(await facts({}, (d) => ({ directory: d }))).toMatchObject({ warehouse: true })
      delete process.env.ALTIMATE_CODE_CONN_PROBE
      expect(await facts({ ".altimate-code/connections.json": '{"wh":{"nothing":1}}' }, (d) => ({ directory: d }))).toMatchObject({ warehouse: false })
    } finally {
      if (saved === undefined) delete process.env.ALTIMATE_CODE_CONN_PROBE
      else process.env.ALTIMATE_CODE_CONN_PROBE = saved
      for (const [k, v] of others) process.env[k] = v
    }
  })

  test("a project with no signal gets the setup tools; a dbt project does not hide dbt tools", async () => {
    const ids = (await registryIds()).filter((id) => id !== "invalid")
    const none = new Set(TS.hiddenIds(ids, TS.groupsFor({ dbtProject: false, sqlFiles: false, warehouse: false, memory: false })))
    expect(none.has("project_scan")).toBe(false)
    expect(none.has("warehouse_add")).toBe(false)
    expect(none.has("dbt_manifest")).toBe(true)
    const dbt = new Set(TS.hiddenIds(ids, TS.groupsFor({ dbtProject: true, sqlFiles: true, warehouse: false, memory: false })))
    expect(dbt.has("dbt_manifest")).toBe(false)
    expect(dbt.has("finops_query_history")).toBe(true) // no warehouse: cost analysis is reached through tool_run
    const warehouse = new Set(TS.hiddenIds(ids, TS.groupsFor({ dbtProject: false, sqlFiles: false, warehouse: true, memory: false })))
    expect(warehouse.has("finops_query_history")).toBe(false)
  })

  test("switch: default off, environment beats config", () => {
    delete process.env[KEY]
    expect(TS.smallerToolListEnabled(undefined)).toBe(false)
    expect(TS.smallerToolListEnabled(true)).toBe(true)
    process.env[KEY] = "0"
    expect(TS.smallerToolListEnabled(true)).toBe(false)
    process.env[KEY] = "1"
    expect(TS.smallerToolListEnabled(undefined)).toBe(true)
  })
})

const model = {
  id: "claude-test",
  providerID: "anthropic",
  api: { id: "claude-test", npm: "@ai-sdk/anthropic" },
  capabilities: { toolcall: true },
  options: {},
  variants: {},
  limit: { context: 200000, output: 8000 },
} as any

function fakeProcessor() {
  return {
    message: { id: "msg_test", sessionID: "ses_test" },
    beginToolExecution: () => ({}),
    finishToolExecution: () => {},
    partFromToolExecution: () => undefined,
    partFromToolCall: () => undefined,
    updateToolCall: async () => undefined,
    completeToolCall: async () => undefined,
  } as any
}

async function resolve(sessionID: string, agentOverride?: any, sessionPermission: any[] = []) {
  return SessionPrompt.resolveTools({
    agent: agentOverride ?? ({ name: "builder", mode: "primary", permission: [], options: {} } as any),
    model,
    session: { id: sessionID, permission: sessionPermission } as any,
    processor: fakeProcessor(),
    bypassAgentCheck: false,
    messages: [],
  })
}

async function inProject<T>(setup: (dir: string) => Promise<void>, fn: (dir: string) => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true, init: setup })
  const home = process.env.OPENCODE_TEST_HOME
  process.env.OPENCODE_TEST_HOME = tmp.path
  try {
    return await provideTestInstance({ directory: tmp.path, fn: (ctx) => Instance.restore(ctx, () => fn(tmp.path)) })
  } finally {
    if (home === undefined) delete process.env.OPENCODE_TEST_HOME
    else process.env.OPENCODE_TEST_HOME = home
  }
}

async function registryIds() {
  return inProject(async () => {}, async () => ToolRegistry.ids())
}

const dbtProject = async (dir: string) => {
  await Bun.write(path.join(dir, "dbt_project.yml"), "name: demo\nprofile: demo\nversion: '1.0'\n")
  await Bun.write(path.join(dir, "models", "a.sql"), "select 1 as id\n")
}

describe("smaller tool list in a session", () => {
  beforeEach(() => TS.reset())

  test("switch off: the full list and no tool_run", async () => {
    await inProject(dbtProject, async () => {
      process.env[KEY] = "0"
      const tools = await resolve("ses_off")
      expect(Object.keys(tools)).toContain("finops_query_history")
      expect(Object.keys(tools)).not.toContain("tool_run")
    })
  })

  test("switch on: smaller list, identical on every step and in a second session, core present", async () => {
    await inProject(dbtProject, async () => {
      process.env[KEY] = "0"
      const full = Object.keys(await resolve("ses_full"))
      process.env[KEY] = "1"
      const step1 = Object.keys(await resolve("ses_a"))
      const step2 = Object.keys(await resolve("ses_a"))
      const step3 = Object.keys(await resolve("ses_a"))
      const otherSession = Object.keys(await resolve("ses_b"))
      expect(step1.length).toBeLessThan(full.length)
      // Same order too: the provider receives tools in record order and the cache keys on it.
      expect(step2).toEqual(step1)
      expect(step3).toEqual(step1)
      expect(otherSession).toEqual(step1)
      const bytes = async (id: string) =>
        JSON.stringify(
          Object.entries(await resolve(id)).map(([k, t]) => [k, (t as any).description, (t as any).inputSchema?.jsonSchema ?? null]),
        )
      expect(await bytes("ses_c")).toBe(await bytes("ses_d"))
      for (const id of ALWAYS.filter((id) => id !== "invalid")) expect(step1).toContain(id)
      expect(step1).toContain("invalid")
      expect(step1).toContain("dbt_manifest")
      expect(step1).not.toContain("finops_query_history")
      expect(step1[step1.length - 1]).toBe("tool_run")
    })
  })

  test("the tool definitions sent to the model are byte-identical across steps", async () => {
    await inProject(dbtProject, async () => {
      process.env[KEY] = "1"
      const snapshot = async () => {
        const tools = await resolve("ses_bytes")
        return JSON.stringify(
          Object.entries(tools).map(([id, t]) => [id, (t as any).description, (t as any).inputSchema?.jsonSchema ?? null]),
        )
      }
      const first = await snapshot()
      // Using a hidden tool between steps must not change the definitions.
      const tools = await resolve("ses_bytes")
      const ran = await (tools.tool_run as any).execute({ name: "altimate_core_import_ddl", arguments: { ddl: "CREATE TABLE t (a INT)" } }, { toolCallId: "c1", messages: [] })
      expect(ran.metadata.tool_run).toBe("altimate_core_import_ddl")
      expect(await snapshot()).toBe(first)
    })
  })

  test("the list follows the project: a folder with no signal gets the setup tools, not dbt tools", async () => {
    await inProject(async () => {}, async () => {
      process.env[KEY] = "1"
      const keys = Object.keys(await resolve("ses_none"))
      expect(keys).toContain("project_scan")
      expect(keys).not.toContain("dbt_manifest")
      expect(keys).toContain("tool_run")
    })
  })

  test("the decision is made once: a later change to the project does not change the list", async () => {
    await inProject(async () => {}, async (dir) => {
      process.env[KEY] = "1"
      const before = Object.keys(await resolve("ses_once"))
      await dbtProject(dir)
      expect(Object.keys(await resolve("ses_once"))).toEqual(before)
      // A new session sees the new state.
      expect(Object.keys(await resolve("ses_next"))).toContain("dbt_manifest")
    })
  })

  test("a tool outside the list can be run through tool_run, with the same result as calling it", async () => {
    await inProject(dbtProject, async () => {
      process.env[KEY] = "0"
      const direct = await resolve("ses_direct")
      const wanted = { ddl: "CREATE TABLE t (a INT, b TEXT)" }
      const expected = await (direct.altimate_core_import_ddl as any).execute(wanted, { toolCallId: "c0", messages: [] })
      expect(expected.output).toContain("CREATE TABLE t") // the tool really ran: it is not an error text compared with itself
      expect(expected.metadata?.error).toBeUndefined()

      process.env[KEY] = "1"
      const tools = await resolve("ses_hidden")
      expect(Object.keys(tools)).not.toContain("finops_query_history")
      const hidden = TS.hiddenFor(tools.tool_run)!
      expect(Object.keys(hidden)).toContain("finops_query_history")
      const viaRun = await (tools.tool_run as any).execute({ name: "altimate_core_import_ddl", arguments: wanted }, { toolCallId: "c1", messages: [] })
      expect(viaRun.output).toBe(expected.output)
      expect(viaRun.metadata.tool_run).toBe("altimate_core_import_ddl")
    })
  })

  test("tool_run reports an unknown tool and a bad argument usefully, and obeys the agent's permissions", async () => {
    await inProject(dbtProject, async () => {
      process.env[KEY] = "1"
      const tools = await resolve("ses_errs")
      const run = (args: any) => (tools.tool_run as any).execute(args, { toolCallId: "c", messages: [] })
      await expect(run({ name: "does_not_exist", arguments: {} })).rejects.toThrow(/No tool named "does_not_exist"/)
      await expect(run({ name: "bash", arguments: { command: "echo hi" } })).rejects.toThrow(/called directly/)
      await expect(run({ name: "altimate_core_import_ddl", arguments: { nope: 1 } })).rejects.toThrow(/Parameters of altimate_core_import_ddl/)

      // A tool the agent may not use is not reachable through tool_run either.
      const denying = { name: "reader", mode: "primary", permission: [{ permission: "altimate_core_import_ddl", pattern: "*", action: "deny" }], options: {} }
      const limited = await resolve("ses_denied", denying)
      expect(Object.keys(TS.hiddenFor(limited.tool_run)!)).not.toContain("altimate_core_import_ddl")
      expect(limited.tool_run!.description).not.toContain("altimate_core_import_ddl")
    })
  })

  test("a direct call to a hidden tool is rerouted instead of failing", async () => {
    await inProject(dbtProject, async () => {
      process.env[KEY] = "1"
      const tools = await resolve("ses_reroute")
      const hidden = TS.hiddenFor(tools.tool_run)!
      expect(Object.keys(hidden)).toContain("altimate_core_import_ddl")
      expect(LLM.rerouteHiddenCall).toBeDefined()
      const failed = { toolCall: { toolName: "altimate_core_import_ddl", toolCallId: "call_1", input: JSON.stringify({ ddl: "CREATE TABLE t (a INT)" }) } }
      const repaired = LLM.rerouteHiddenCall(tools, failed.toolCall as any)!
      expect(repaired.toolName).toBe("tool_run")
      expect(JSON.parse(repaired.input)).toEqual({ name: "altimate_core_import_ddl", arguments: { ddl: "CREATE TABLE t (a INT)" } })
      const result = await (tools.tool_run as any).execute(JSON.parse(repaired.input), { toolCallId: "call_1", messages: [] })
      expect(result.metadata.rerouted).toBe(true)
      // A name that is neither offered nor reachable is not rerouted.
      expect(LLM.rerouteHiddenCall(tools, { toolName: "made_up", toolCallId: "x", input: "{}" } as any)).toBeUndefined()
    })
  })
})

describe("tool selection at the edges", () => {
  beforeEach(() => TS.reset())

  test("concurrent first calls for one session share one decision", async () => {
    let probes = 0
    const facts = async () => {
      probes++
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { dbtProject: probes === 1, sqlFiles: false, warehouse: false, memory: false }
    }
    const [a, b] = await Promise.all([TS.decide("ses_race", facts), TS.decide("ses_race", facts)])
    expect(probes).toBe(1)
    expect(a).toBe(b)
  })

  test("a user's own tool that is named tool_run, or replaces a built-in id, is left alone", async () => {
    await inProject(
      async (dir) => {
        await dbtProject(dir)
        const toolDir = path.join(dir, ".opencode", "tool")
        await Bun.write(path.join(toolDir, "tool_run.ts"), "export default { description: 'mine', args: {}, execute: async () => 'mine' }\n")
        await Bun.write(
          path.join(toolDir, "finops_query_history.ts"),
          "export default { description: 'my own finops', args: {}, execute: async () => 'mine' }\n",
        )
      },
      async () => {
        process.env[KEY] = "1"
        const tools = await resolve("ses_external")
        expect(tools.tool_run!.description).toBe("mine")
        expect(tools.finops_query_history!.description).toBe("my own finops")
        // Nothing is hidden, since the name tool_run is taken.
        expect(Object.keys(tools)).toContain("altimate_core_fingerprint")
      },
    )
  })

  test("an allowlist agent keeps tool_run for the hidden tools it allows, but not the ones it does not", async () => {
    await inProject(dbtProject, async () => {
      process.env[KEY] = "1"
      const allowlist = {
        name: "restricted",
        mode: "primary",
        permission: [
          { permission: "*", pattern: "*", action: "deny" },
          { permission: "read", pattern: "*", action: "allow" },
          { permission: "altimate_core_import_ddl", pattern: "*", action: "allow" },
        ],
        options: {},
      } as any
      const resolved = await resolve("ses_allowlist", allowlist)
      expect(Object.keys(TS.hiddenFor(resolved.tool_run)!)).toEqual(["altimate_core_import_ddl"])
      // The step that sends the request applies the agent's permissions to the list; tool_run must survive.
      const sent = await LLM.resolveTools({ tools: { ...resolved }, agent: allowlist, user: {} as any })
      expect(Object.keys(sent)).toContain("tool_run")
      expect(Object.keys(sent)).toContain("read")
      expect(Object.keys(sent)).not.toContain("bash")
      // A rule that names tool_run itself turns it off.
      const off = { ...allowlist, permission: [...allowlist.permission, { permission: "tool_run", pattern: "*", action: "deny" }] }
      expect(Object.keys(await LLM.resolveTools({ tools: { ...resolved }, agent: off, user: {} as any }))).not.toContain("tool_run")
    })
  })

  test("a user's own tool named tool_run gets no exemption from the agent's permissions", async () => {
    await inProject(
      async (dir) => {
        await dbtProject(dir)
        await Bun.write(
          path.join(dir, ".opencode", "tool", "tool_run.ts"),
          "export default { description: 'mine', args: {}, execute: async () => 'mine' }\n",
        )
      },
      async () => {
        process.env[KEY] = "1"
        const denying = { name: "restricted", mode: "primary", permission: [{ permission: "*", pattern: "*", action: "deny" }], options: {} } as any
        const resolved = await resolve("ses_custom_router", denying)
        expect(resolved.tool_run!.description).toBe("mine")
        expect(Object.keys(await LLM.resolveTools({ tools: { ...resolved }, agent: denying, user: {} as any }))).not.toContain("tool_run")
      },
    )
  })

  test("arguments that are not an object are rejected, not turned into defaults", async () => {
    await inProject(dbtProject, async () => {
      process.env[KEY] = "1"
      const tools = await resolve("ses_nullargs")
      const run = (args: any) => (tools.tool_run as any).execute(args, { toolCallId: "n", messages: [] })
      for (const bad of [null, [], 3, '{"ddl":"CREATE TABLE t (a INT)"}']) await expect(run({ name: "altimate_core_import_ddl", arguments: bad })).rejects.toThrow(/must be an object/)
      for (const input of ["null", "[]", "5"])
        expect(LLM.rerouteHiddenCall(tools, { toolName: "altimate_core_import_ddl", toolCallId: "n", input } as any)).toBeUndefined()
    })
  })

  test("resolveTools keeps a hidden-by-project tool that the agent's own prompt names", async () => {
    await inProject(dbtProject, async () => {
      process.env[KEY] = "1"
      const plain = await resolve("ses_prompt_a")
      expect(Object.keys(plain)).not.toContain("finops_query_history")
      const named = { name: "analyst", mode: "primary", permission: [], options: {}, prompt: "Use finops_query_history to review spend." } as any
      const tools = await resolve("ses_prompt_b", named)
      expect(Object.keys(tools)).toContain("finops_query_history")
      expect(Object.keys(TS.hiddenFor(tools.tool_run)!)).not.toContain("finops_query_history")
    })
  })

  test("a wildcard that names tool_run turns it off; only the catch-all is overridden", async () => {
    await inProject(dbtProject, async () => {
      process.env[KEY] = "1"
      const allow = [{ permission: "altimate_core_import_ddl", pattern: "*", action: "allow" }]
      const make = (rules: any[]) => ({ name: "restricted", mode: "primary", permission: rules, options: {} }) as any
      for (const [rules, kept] of [
        [[{ permission: "*", pattern: "*", action: "deny" }, ...allow], true],
        [[{ permission: "*", pattern: "*", action: "deny" }, { permission: "tool_*", pattern: "*", action: "deny" }, ...allow], false],
        [[{ permission: "*", pattern: "*", action: "deny" }, ...allow, { permission: "tool_run", pattern: "*", action: "deny" }], false],
      ] as const) {
        const agent = make(rules as any)
        const resolved = await resolve(`ses_wild_${Math.random()}`, agent)
        const sent = await LLM.resolveTools({ tools: { ...resolved }, agent, user: {} as any })
        expect(Object.keys(sent).includes("tool_run")).toBe(kept)
      }
    })
  })

  test("a session's decision is dropped when the session is deleted, and kept while it exists", async () => {
    await inProject(async () => {}, async (dir) => {
      process.env[KEY] = "1"
      const before = Object.keys(await resolve("ses_del"))
      await dbtProject(dir)
      expect(Object.keys(await resolve("ses_del"))).toEqual(before) // still alive: the decision stands
      const { Bus } = await import("../../src/bus")
      const { Session } = await import("../../src/session")
      await Bus.publish(Session.Event.Deleted, { info: { id: "ses_del" } as any })
      expect(Object.keys(await resolve("ses_del"))).toContain("dbt_manifest") // new facts are read again
    })
  })

  test("a wrongly cased direct call to a hidden tool is rerouted like an offered tool's would be", async () => {
    await inProject(dbtProject, async () => {
      process.env[KEY] = "1"
      const tools = await resolve("ses_case")
      const repaired = LLM.rerouteHiddenCall(tools, { toolName: "ALTIMATE_CORE_IMPORT_DDL", toolCallId: "k", input: '{"ddl":"CREATE TABLE t (a INT)"}' } as any)
      expect(repaired && JSON.parse(repaired.input).name).toBe("altimate_core_import_ddl")
    })
  })

  test("router rules: only a blanket deny is overridden; with the router denied, allowed targets stay direct", async () => {
    expect(TS.routerAllowed([{ permission: "*", pattern: "*", action: "deny" }])).toBe(true)
    expect(TS.routerAllowed([{ permission: "*", pattern: "*", action: "deny" }, { permission: "tool_*", pattern: "*", action: "deny" }])).toBe(false)
    expect(TS.routerAllowed([{ permission: "tool_run", pattern: "*", action: "deny" }, { permission: "tool_run", pattern: "*", action: "allow" }])).toBe(true)
    // the last matching rule decides: a later catch-all allow wins over an earlier specific deny
    expect(TS.routerAllowed([{ permission: "tool_run", pattern: "*", action: "deny" }, { permission: "*", pattern: "*", action: "allow" }])).toBe(true)
    // an explicit deny is not undone by a later catch-all
    expect(TS.routerAllowed([{ permission: "tool_run", pattern: "*", action: "deny" }, { permission: "*", pattern: "*", action: "deny" }, { permission: "x", pattern: "*", action: "allow" }])).toBe(false)
    await inProject(dbtProject, async () => {
      process.env[KEY] = "1"
      const agent = { name: "r", mode: "primary", options: {}, permission: [{ permission: "tool_run", pattern: "*", action: "deny" }] } as any
      const keys = Object.keys(await resolve("ses_router_off", agent))
      expect(keys).not.toContain("tool_run")
      expect(keys).toContain("finops_query_history") // nothing was hidden
    })
  })

  test("a target the session's rules deny is not reachable through the router", async () => {
    await inProject(dbtProject, async () => {
      process.env[KEY] = "1"
      const tools = await resolve("ses_sessiondeny", undefined, [{ permission: "altimate_core_import_ddl", pattern: "*", action: "deny" }])
      expect(Object.keys(TS.hiddenFor(tools.tool_run)!)).not.toContain("altimate_core_import_ddl")
      expect(Object.keys(TS.hiddenFor(tools.tool_run)!)).toContain("altimate_core_fingerprint")
    })
  })

  test("a name the request already offers is not rerouted to a similarly spelled hidden tool", async () => {
    await inProject(dbtProject, async () => {
      process.env[KEY] = "1"
      const tools = await resolve("ses_offered_name")
      ;(tools as any).ALTIMATE_CORE_IMPORT_DDL = { description: "a user tool" }
      expect(LLM.rerouteHiddenCall(tools, { toolName: "ALTIMATE_CORE_IMPORT_DDL", toolCallId: "o", input: "{}" } as any)).toBeUndefined()
    })
  })

  test("empty or non-object input is not rerouted", async () => {
    await inProject(dbtProject, async () => {
      process.env[KEY] = "1"
      const tools = await resolve("ses_emptyinput")
      for (const input of ["", "null", "[]", "5", "{"])
        expect(LLM.rerouteHiddenCall(tools, { toolName: "altimate_core_import_ddl", toolCallId: "e", input } as any)).toBeUndefined()
    })
  })

  test("a malformed direct call is not rerouted with default arguments", async () => {
    await inProject(dbtProject, async () => {
      process.env[KEY] = "1"
      const tools = await resolve("ses_malformed")
      const call = { toolName: "altimate_core_import_ddl", toolCallId: "m1", input: '{"ddl":"CREATE TABLE t (a INT)"' }
      expect(LLM.rerouteHiddenCall(tools, call as any)).toBeUndefined()
    })
  })

  test("a historical entry for a hidden tool runs that tool instead of answering that it is gone", async () => {
    await inProject(dbtProject, async () => {
      process.env[KEY] = "1"
      const tools = await resolve("ses_history")
      LLM.addHistoricalToolStubs(tools as any, ["altimate_core_import_ddl"], "auto", TS.hiddenFor(tools.tool_run))
      const out = await (tools.altimate_core_import_ddl as any).execute({ ddl: "CREATE TABLE t (a INT)" }, { toolCallId: "h1", messages: [] })
      expect(out.output).not.toContain("no longer available")
      expect(tools.altimate_core_import_ddl!.description).toContain("tool_run")
    })
  })
})
