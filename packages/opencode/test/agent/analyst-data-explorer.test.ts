import { expect } from "bun:test"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { deriveSubagentSessionPermission } from "../../src/agent/subagent-permissions"
import { Permission } from "../../src/permission"
import { testEffect } from "../lib/effect"

const it = testEffect(Agent.defaultLayer)

const action = (agent: Agent.Info, permission: string, pattern = "*") =>
  Permission.evaluate(permission, pattern, agent.permission).action

// Mirrors session/prompt.ts: effective = merge(agent.permission, session.permission)
// Parent-agent permissions do not propagate; pass the actual parent-session rules explicitly.
const childEffective = (parentSessionPermission: Agent.Info["permission"], child: Agent.Info) =>
  Permission.merge(child.permission, deriveSubagentSessionPermission({ parentSessionPermission, subagent: child }))

it.instance("analyst can load skills", () =>
  Effect.gen(function* () {
    const analyst = yield* Agent.use.get("analyst")
    expect(action(analyst!, "skill", "dbt-develop")).toBe("allow")
    expect(Permission.disabled(["skill"], analyst!.permission)).toEqual(new Set())
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
