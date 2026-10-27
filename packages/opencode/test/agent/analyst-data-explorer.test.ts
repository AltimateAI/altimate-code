import { afterAll, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import fs from "fs"
import os from "os"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { deriveSubagentSessionPermission } from "../../src/agent/subagent-permissions"
import { Permission } from "../../src/permission"
import { PermissionEvaluate } from "../../src/permission/evaluate"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { ToolRegistry } from "../../src/tool/registry"
import { LLM } from "../../src/session/llm"
import type { MessageV2 } from "../../src/session/message-v2"
import { assertExternalDirectoryEffect } from "../../src/tool/external-directory"
import { MessageID, SessionID } from "../../src/session/schema"
import type { Tool } from "../../src/tool/tool"
import { testEffect } from "../lib/effect"

const it = testEffect(Agent.defaultLayer)

const action = (agent: Agent.Info, permission: string, pattern = "*") =>
  Permission.evaluate(permission, pattern, agent.permission).action

// Mirrors session/prompt.ts: effective = merge(agent.permission, session.permission)
// Parent-agent permissions do not propagate; pass the actual parent-session rules explicitly.
const childEffective = (parentSessionPermission: Agent.Info["permission"], child: Agent.Info) =>
  Permission.merge(child.permission, deriveSubagentSessionPermission({ parentSessionPermission, subagent: child }))

for (const name of ["analyst", "data-explorer"] as const) {
  it.instance(`${name} denies shell writes, chaining, and substitutions`, () =>
    Effect.gen(function* () {
      const agent = yield* Agent.use.get(name)
      for (const command of [
        "cat /dev/null > model.sql",
        "cat /dev/null>model.sql",
        "tail -n 1 x >> y",
        "tail -n 1 x>>y",
        "cat x 2> y",
        "cat x &> y",
        "(cat model.sql)>out.txt",
        "{ cat model.sql; } >out.txt",
        "find . -delete",
        "find . -exec rm {} ;",
        "find . -execdir rm {} ;",
        "find . -ok rm {} ;",
        "find . -fprint y",
        "find . -fls y",
        "find . -fprintf y %p",
        "find . -D tree",
        "find . -'delete'",
        "ls; rm -rf x",
        "ls ; rm -rf x",
        "ls && rm x",
        "ls || rm x",
        "ls\nrm x",
        "cat x | tee y",
        "cat x|tee y",
        "cat $(rm x)",
        "cat `rm x`",
        "ls -la | cat",
      ]) {
        expect(action(agent, "bash", command), command).toBe("deny")
      }
    }),
  )

  it.instance(`${name} disables bash even for simple reads and retains structured read tools`, () =>
    Effect.gen(function* () {
      const agent = yield* Agent.use.get(name)
      for (const command of ["ls -la", "cat model.sql", 'find . -name "*.sql"', "dbt list --select x"]) {
        expect(action(agent, "bash", command), command).toBe("deny")
      }
      expect(Permission.disabled(["bash"], agent.permission)).toEqual(new Set(["bash"]))
      for (const permission of ["read", "grep", "glob", "sql_execute", "schema_inspect", "warehouse_list"]) {
        expect(action(agent, permission), permission).toBe("allow")
      }
    }),
  )
}

it.instance("analyst can load skills", () =>
  Effect.gen(function* () {
    const analyst = yield* Agent.use.get("analyst")
    expect(action(analyst!, "skill", "dbt-develop")).toBe("allow")
    expect(Permission.disabled(["skill"], analyst!.permission)).toEqual(new Set())
  }),
)

it.instance("analyst can read workspace memory but not save, extract or delete it", () =>
  Effect.gen(function* () {
    const analyst = (yield* Agent.use.get("analyst"))!
    const builder = (yield* Agent.use.get("builder"))!
    const de = (yield* Agent.use.get("data-explorer"))!
    const read = ["altimate_memory_read", "altimate_memory_refresh", "altimate_memory_audit"]
    const write = ["altimate_memory_write", "altimate_memory_delete", "altimate_memory_extract"]
    for (const tool of read) expect(action(analyst, tool)).toBe("allow")
    for (const tool of write) expect(action(analyst, tool)).toBe("deny")
    expect(Permission.disabled([...read, ...write], analyst.permission)).toEqual(new Set(write))
    // The data-explorer subagent stays limited to warehouse and file reads.
    for (const tool of [...read, ...write]) expect(action(de, tool)).toBe("deny")
    for (const tool of ["altimate_memory_read", "altimate_memory_write"]) expect(action(builder, tool)).toBe("allow")
    // Reading memory does not loosen the rest of analyst's read-only policy.
    expect(action(analyst, "bash")).toBe("deny")
    expect(action(analyst, "sql_execute_write")).toBe("deny")
  }),
)

it.instance("analyst may delegate only to data-explorer", () =>
  Effect.gen(function* () {
    const analyst = yield* Agent.use.get("analyst")
    expect(action(analyst!, "task", "data-explorer")).toBe("allow")
    for (const other of ["general", "explore", "build", "builder", "plan", "reviewer"]) {
      expect(action(analyst!, "task", other)).toBe("deny")
    }
  }),
)

it.instance("data-explorer is a read-only native subagent", () =>
  Effect.gen(function* () {
    const de = yield* Agent.use.get("data-explorer")
    expect(de?.mode).toBe("subagent")
    expect(de?.native).toBe(true)
    expect(de?.description).toContain("Read-only data exploration")
    expect(de?.prompt).toBeTruthy()
    const agents = yield* Agent.use.list()
    expect(agents.map((a) => a.name)).toContain("data-explorer")
  }),
)

it.instance("data-explorer child cannot write, edit, patch, run rm, write SQL, or delegate", () =>
  Effect.gen(function* () {
    const de = (yield* Agent.use.get("data-explorer"))!
    const eff = childEffective([], de)
    for (const [perm, pattern] of [
      ["edit", "/proj/a.sql"],
      ["write", "/proj/a.sql"],
      ["apply_patch", "/proj/a.sql"],
      ["bash", "rm -rf /proj"],
      ["bash", "rm file.txt"],
      ["bash", "dbt run"],
      ["bash", "cat README.md > out.txt"],
      ["bash", "find . -type f -delete"],
      ["bash", "ls"],
      ["sql_execute_write", "INSERT INTO t VALUES (1)"],
      ["sql_execute_write", "UPDATE t SET a = 1"],
      ["sql_execute_write", "DELETE FROM t"],
      ["sql_execute_write", "CREATE TABLE t (a int)"],
      ["task", "general"],
      ["task", "data-explorer"],
      ["webfetch", "https://example.com"],
      ["websearch", "x"],
    ] as const) {
      expect(Permission.evaluate(perm, pattern, eff).action).toBe("deny")
    }
    // sql_execute_write is gated per-statement (pattern = SQL), so it is asserted via evaluate above.
    expect(Permission.disabled(["edit", "write", "apply_patch", "task", "bash"], eff)).toEqual(
      new Set(["edit", "write", "apply_patch", "task", "bash"]),
    )
  }),
)

it.instance("data-explorer keeps the analyst read-only allow-list", () =>
  Effect.gen(function* () {
    const analyst = (yield* Agent.use.get("analyst"))!
    const de = (yield* Agent.use.get("data-explorer"))!
    for (const [perm, pattern] of [
      ["sql_execute", "SELECT 1"],
      ["schema_inspect", "*"],
      ["warehouse_list", "*"],
      ["read", "/proj/a.sql"],
      ["grep", "x"],
      ["glob", "*"],
      ["sql_materialize", "*"],
    ] as const) {
      expect(Permission.evaluate(perm, pattern, de.permission).action).toBe("allow")
    }
    expect(action(analyst, "sql_materialize")).toBe("allow")
    expect(action(analyst, "sql_execute_write")).toBe("deny")
  }),
)

for (const override of ["global", "agent", "both"] as const) {
  it.instance(
    `analyst denies all shell commands despite ${override} config grants`,
    () =>
      Effect.gen(function* () {
        const analyst = yield* Agent.use.get("analyst")
        for (const command of ["cat README.md > out.txt", "find . -type f -delete", "ls"]) {
          expect(action(analyst, "bash", command), command).toBe("deny")
        }
        expect(Permission.disabled(["bash"], analyst.permission)).toEqual(new Set(["bash"]))
      }),
    {
      config: {
        ...(override !== "agent" && { permission: { bash: "allow" as const } }),
        ...(override !== "global" && {
          agent: { analyst: { permission: { bash: { "*": "allow" as const, "cat *": "allow" as const } } } },
        }),
      },
    },
  )

  it.instance(
    `data-explorer denies all shell commands despite ${override} config grants`,
    () =>
      Effect.gen(function* () {
        const de = (yield* Agent.use.get("data-explorer"))!
        const eff = childEffective(Permission.fromConfig({ bash: "allow" }), de)
        for (const command of ["cat README.md > out.txt", "find . -type f -delete", "ls"]) {
          expect(Permission.evaluate("bash", command, eff).action).toBe("deny")
        }
        expect(Permission.disabled(["bash"], eff)).toEqual(new Set(["bash"]))
      }),
    {
      config: {
        ...(override !== "agent" && { permission: { bash: "allow" as const } }),
        ...(override !== "global" && {
          agent: { "data-explorer": { permission: { bash: { "*": "allow" as const, "cat *": "allow" as const } } } },
        }),
      },
    },
  )
}

it.instance("child effective permissions retain parent-session read denials", () =>
  Effect.gen(function* () {
    const de = (yield* Agent.use.get("data-explorer"))!
    const eff = childEffective(Permission.fromConfig({ read: { "/private/*": "deny" } }), de)
    expect(Permission.evaluate("read", "/private/notes.txt", eff).action).toBe("deny")
    expect(Permission.evaluate("read", "/proj/a.sql", eff).action).toBe("allow")
  }),
)

it.instance("a reused task session carrying allow rules cannot widen data-explorer", () =>
  Effect.gen(function* () {
    const de = (yield* Agent.use.get("data-explorer"))!
    // A foreign session ruleset appended last would win under last-match evaluation if the guard failed;
    // data-explorer's explicit denies are re-applied by the agent ruleset itself, so assert the agent
    // ruleset alone already denies and that task.ts refuses to reuse foreign sessions (see task.test.ts).
    for (const perm of ["edit", "write", "apply_patch", "task", "sql_execute_write"]) {
      expect(Permission.evaluate(perm, "*", de.permission).action).toBe("deny")
    }
  }),
)

for (const override of ["global", "agent"] as const) {
  it.instance(
    `data-explorer preserves its read-only boundary after ${override} wildcard and write grants`,
    () =>
      Effect.gen(function* () {
        const de = (yield* Agent.use.get("data-explorer"))!
        for (const permission of [
          "training_save",
          "training_remove",
          "edit",
          "write",
          "apply_patch",
          "sql_execute_write",
          "task",
          "unknown_mutating_tool",
        ]) {
          expect(action(de, permission)).toBe("deny")
        }
        expect(action(de, "sql_execute")).toBe("allow")
        expect(action(de, "read", "private/data.txt")).toBe("deny")
        expect(action(de, "read", "public/data.txt")).toBe("allow")
      }),
    {
      config:
        override === "global"
          ? { permission: { "*": "allow", read: { "private/**": "deny" } } }
          : {
              agent: {
                "data-explorer": {
                  permission: {
                    "*": "allow",
                    edit: "allow",
                    sql_execute_write: "allow",
                    read: { "private/**": "deny" },
                  },
                },
              },
            },
    },
  )
}

// Write tools a config grant must not re-enable for analyst (last-match-wins would otherwise apply).
const analystWrites = [
  "altimate_memory_write",
  "altimate_memory_delete",
  "altimate_memory_extract",
  "edit",
  "write",
  "apply_patch",
  "sql_execute_write",
  "bash",
  "training_import",
  "warehouse_add",
  "warehouse_remove",
  "warehouse_install_driver",
  "mcp_discover",
  "datamate_manager",
  "sample_setup",
  "feedback_submit",
  "data_diff",
  "batch",
]
const writeGrants = Object.fromEntries(analystWrites.map((tool) => [tool, "allow" as const]))

for (const override of ["global", "agent"] as const) {
  it.instance(
    `analyst keeps write and memory-save denies after ${override} wildcard and explicit grants`,
    () =>
      Effect.gen(function* () {
        const analyst = (yield* Agent.use.get("analyst"))!
        for (const tool of analystWrites) expect(action(analyst, tool), tool).toBe("deny")
        expect(Permission.disabled(analystWrites, analyst.permission)).toEqual(new Set(analystWrites))
        expect(action(analyst, "task", "data-explorer")).toBe("allow")
        for (const subagent of ["general", "builder", "explore"]) {
          expect(action(analyst, "task", subagent), subagent).toBe("deny")
        }
        for (const tool of ["altimate_memory_read", "altimate_memory_refresh", "altimate_memory_audit", "skill"]) {
          expect(action(analyst, tool), tool).toBe("allow")
        }
        expect(action(analyst, "read", "models/a.sql")).toBe("allow")
        expect(action(analyst, "sql_execute")).toBe("allow")
      }),
    {
      config:
        override === "global"
          ? { permission: { "*": "allow", ...writeGrants, task: "allow" } }
          : { agent: { analyst: { permission: { "*": "allow", ...writeGrants, task: "allow" } } } },
    },
  )
}

for (const override of ["global", "agent"] as const) {
  it.instance(
    `analyst drops the task tool when ${override} config denies all delegation`,
    () =>
      Effect.gen(function* () {
        const analyst = (yield* Agent.use.get("analyst"))!
        expect(action(analyst, "task", "data-explorer")).toBe("deny")
        expect(Permission.disabled(["task"], analyst.permission)).toEqual(new Set(["task"]))
      }),
    {
      config:
        override === "global"
          ? { permission: { task: "deny" } }
          : { agent: { analyst: { permission: { task: "deny" } } } },
    },
  )
}

for (const configured of ["deny", "ask"] as const) {
  for (const override of ["global", "agent"] as const) {
    const task = { "*": "allow" as const, "data-explorer": configured }
    it.instance(
      `analyst keeps ${override === "agent" ? "an agent" : "a global"} config ${configured} for delegating to data-explorer`,
      () =>
        Effect.gen(function* () {
          const analyst = (yield* Agent.use.get("analyst"))!
          expect(action(analyst, "task", "data-explorer")).toBe(configured)
          expect(action(analyst, "task", "general")).toBe("deny")
        }),
      {
        config: override === "global" ? { permission: { task } } : { agent: { analyst: { permission: { task } } } },
      },
    )
  }
}

// Every registered built-in tool that a wildcard grant leaves enabled for analyst must be on this
// reviewed list: read-only tools, plus the local writes analyst is designed to make (training
// entries, scratch tables, the schema index, session todos). A new tool that changes files,
// workspace memory, config, connections or external systems fails here until it is added to
// analyst's post-config denies. Flag-gated tools are listed too, so the check does not depend
// on the environment.
const analystConfigEnabled = new Set([
  ...[
    "check",
    "classify_pii",
    "column_lineage",
    "compare",
    "complete",
    "correct",
    "equivalence",
    "export_ddl",
    "extract_metadata",
    "fingerprint",
    "fix",
    "grade",
    "import_ddl",
    "introspection_sql",
    "migration",
    "optimize_context",
    "parse_dbt",
    "policy",
    "prune_schema",
    "query_pii",
    "resolve_term",
    "rewrite",
    "schema_diff",
    "semantics",
    "testgen",
    "track_lineage",
    "validate",
  ].map((name) => `altimate_core_${name}`),
  "altimate_memory_audit",
  "altimate_memory_read",
  "altimate_memory_refresh",
  "answer_commit",
  "codesearch",
  "dbt_lineage",
  "dbt_manifest",
  "dbt_pr_review",
  "dbt_profiles",
  "dbt_unit_test_gen",
  "finops_analyze_credits",
  "finops_expensive_queries",
  "finops_query_history",
  "finops_role_grants",
  "finops_role_hierarchy",
  "finops_unused_resources",
  "finops_user_roles",
  "finops_warehouse_advice",
  "glob",
  "grep",
  "impact_analysis",
  "invalid",
  "lineage_check",
  "lsp",
  "plan_exit",
  "project_scan",
  "question",
  "read",
  "schema_cache_status",
  "schema_detect_pii",
  "schema_diff",
  "schema_index",
  "schema_inspect",
  "schema_search",
  "schema_tags",
  "schema_tags_list",
  "skill",
  "sql_analyze",
  "sql_autocomplete",
  "sql_check",
  "sql_diff",
  "sql_execute",
  "sql_explain",
  "sql_fix",
  "sql_format",
  "sql_materialize",
  "sql_optimize",
  "sql_rewrite",
  "sql_translate",
  "task",
  "todowrite",
  "tool_lookup",
  "training_list",
  "training_remove",
  "training_save",
  "warehouse_discover",
  "warehouse_list",
  "warehouse_test",
  "webfetch",
  "websearch",
])
const withRegistry = testEffect(
  LayerNode.buildLayer(LayerNode.group([ToolRegistry.node, Agent.node]), {
    replacements: [LayerNode.replace(RuntimeFlags.node, RuntimeFlags.layer())],
  }),
)

withRegistry.instance(
  "a wildcard grant enables only reviewed read-only built-in tools for analyst",
  () =>
    Effect.gen(function* () {
      const ids = yield* (yield* ToolRegistry.Service).ids()
      const analyst = (yield* Agent.Service.use((svc) => svc.get("analyst")))!
      expect(ids).toContain("batch")
      // The same helper that removes tools from each model request.
      const disabled = LLM.removedTools(ids, {
        agent: analyst,
        user: { tools: undefined } as unknown as MessageV2.User,
      })
      expect(ids.filter((id) => !disabled.has(id) && !analystConfigEnabled.has(id))).toEqual([])
      for (const tool of analystWrites.filter((tool) => ids.includes(tool))) expect(disabled.has(tool), tool).toBe(true)
    }),
  { config: { permission: { "*": "allow" }, experimental: { batch_tool: true } } },
)

// A skill stored outside the project, like a global skill under the home directory.
const externalSkills = fs.mkdtempSync(path.join(os.tmpdir(), "analyst-global-skills-"))
fs.mkdirSync(path.join(externalSkills, "naming", "references"), { recursive: true })
fs.writeFileSync(
  path.join(externalSkills, "naming", "SKILL.md"),
  "---\nname: naming\ndescription: Naming conventions.\n---\n\nSee references/rules.md.\n",
)
fs.writeFileSync(path.join(externalSkills, "naming", "references", "rules.md"), "Use snake_case.\n")
afterAll(() => fs.rmSync(externalSkills, { recursive: true, force: true }))

it.instance(
  "analyst allows external_directory access to files bundled with a skill stored outside the project",
  () =>
    Effect.gen(function* () {
      const analyst = (yield* Agent.use.get("analyst"))!
      const skillDir = path.join(externalSkills, "naming")
      // The read tool asks for the bundled file's directory with a trailing "/*".
      for (const dir of [skillDir, path.join(skillDir, "references")]) {
        expect(action(analyst, "external_directory", path.join(dir, "*")), dir).toBe("allow")
      }
      expect(action(analyst, "external_directory", "/some/other/path/*")).toBe("deny")
      // data-explorer is unchanged: no external directory access beyond the shared truncation glob.
      const de = (yield* Agent.use.get("data-explorer"))!
      expect(action(de, "external_directory", path.join(skillDir, "*"))).toBe("deny")
    }),
  { config: { skills: { paths: [externalSkills] } } },
)

it.instance(
  "config can still deny analyst access to a skill folder outside the project",
  () =>
    Effect.gen(function* () {
      const analyst = (yield* Agent.use.get("analyst"))!
      expect(action(analyst, "external_directory", path.join(externalSkills, "naming", "*"))).toBe("deny")
    }),
  {
    config: () => ({
      skills: { paths: [externalSkills] },
      agent: { analyst: { permission: { external_directory: { [path.join(externalSkills, "*")]: "deny" } } } },
    }),
  },
)

// A symlink inside a skill folder must not reach a directory analyst is otherwise denied.
const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "analyst-elsewhere-"))
fs.writeFileSync(path.join(elsewhere, "secret.txt"), "x")
if (process.platform !== "win32") fs.symlinkSync(elsewhere, path.join(externalSkills, "naming", "linked"))
afterAll(() => fs.rmSync(elsewhere, { recursive: true, force: true }))

if (process.platform !== "win32") {
  it.instance(
    "analyst cannot read through a symlink in a skill folder that points outside it",
    () =>
      Effect.gen(function* () {
        const analyst = (yield* Agent.use.get("analyst"))!
        const asked: (readonly string[])[] = []
        const ctx = {
          sessionID: SessionID.make("ses_test"),
          messageID: MessageID.make("msg_test"),
          callID: "",
          agent: "analyst",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => Effect.void,
          ask: (req) => Effect.sync(() => void asked.push(req.patterns)),
        } satisfies Tool.Context
        yield* assertExternalDirectoryEffect(ctx, path.join(externalSkills, "naming", "linked", "secret.txt"))
        const [authored, resolved] = asked[0]!
        expect(action(analyst, "external_directory", authored!)).toBe("allow")
        expect(resolved).toBe(path.join(fs.realpathSync(elsewhere), "*"))
        expect(action(analyst, "external_directory", resolved!)).toBe("deny")
      }),
    { config: { skills: { paths: [externalSkills] } } },
  )
}

// A second skill root, plus a sibling folder whose name only extends a skill folder's name.
const otherSkills = fs.mkdtempSync(path.join(os.tmpdir(), "analyst-team-skills-"))
fs.mkdirSync(path.join(otherSkills, "style"), { recursive: true })
fs.writeFileSync(
  path.join(otherSkills, "style", "SKILL.md"),
  "---\nname: style\ndescription: SQL style.\n---\n\nSee style.md.\n",
)
fs.mkdirSync(path.join(externalSkills, "naming-evil"), { recursive: true })
afterAll(() => fs.rmSync(otherSkills, { recursive: true, force: true }))

it.instance(
  "analyst can read every discovered skill folder but not a sibling folder sharing a prefix",
  () =>
    Effect.gen(function* () {
      const analyst = (yield* Agent.use.get("analyst"))!
      expect(action(analyst, "external_directory", path.join(externalSkills, "naming", "*"))).toBe("allow")
      expect(action(analyst, "external_directory", path.join(otherSkills, "style", "*"))).toBe("allow")
      expect(action(analyst, "external_directory", path.join(externalSkills, "naming-evil", "*"))).toBe("deny")
      expect(action(analyst, "external_directory", path.join(externalSkills, "*"))).toBe("deny")
    }),
  { config: { skills: { paths: [externalSkills, otherSkills] } } },
)

// Patterned grants match only some inputs; the re-applied "*" deny still wins for every input.
it.instance(
  "analyst keeps write tools denied under patterned config grants",
  () =>
    Effect.gen(function* () {
      const analyst = (yield* Agent.use.get("analyst"))!
      expect(action(analyst, "sql_execute_write", "INSERT INTO t VALUES (1)")).toBe("deny")
      expect(action(analyst, "edit", "models/orders.sql")).toBe("deny")
      expect(action(analyst, "bash", "ls -la")).toBe("deny")
      expect(action(analyst, "altimate_memory_write", "naming-rule")).toBe("deny")
      expect(Permission.disabled(["sql_execute_write", "edit", "bash"], analyst.permission)).toEqual(
        new Set(["sql_execute_write", "edit", "bash"]),
      )
    }),
  {
    config: {
      agent: {
        analyst: {
          permission: {
            sql_execute_write: { "INSERT *": "allow" },
            edit: { "models/*": "allow" },
            bash: { "ls *": "allow" },
            altimate_memory_write: { "naming-*": "allow" },
          },
        },
      },
    },
  },
)

// A global deny on a real folder must survive a per-agent allow written through a link to its parent.
const layered = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-twin-layers-")))
fs.mkdirSync(path.join(layered, "real", "secret"), { recursive: true })
fs.symlinkSync(path.join(layered, "real"), path.join(layered, "link"))
afterAll(() => fs.rmSync(layered, { recursive: true, force: true }))

for (const name of ["builder", "analyst"] as const) {
  it.instance(
    `${name} keeps a global deny on a real folder when its agent config allows a link to it`,
    () =>
      Effect.gen(function* () {
        const agent = (yield* Agent.use.get(name))!
        expect(action(agent, "external_directory", path.join(layered, "real", "secret", "*"))).toBe("deny")
        // Reading through the link: its resolved directory is allowed by the link rule's resolved spelling.
        expect(
          PermissionEvaluate.evaluateResolved(
            "external_directory",
            path.join(layered, "real", "other", "*"),
            agent.permission,
          ).action,
        ).toBe("allow")
      }),
    {
      config: {
        permission: { external_directory: { [path.join(layered, "real", "secret", "*")]: "deny" } },
        agent: { [name]: { permission: { external_directory: { [path.join(layered, "link", "*")]: "allow" } } } },
      },
    },
  )
}
