import { afterEach, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import path from "path"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Global } from "@opencode-ai/core/global"
import { Permission } from "../../src/permission"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"
import { Truncate } from "../../src/tool/truncate"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"

const agentLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  Agent.layer.pipe(
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Skill.defaultLayer),
    Layer.provide(LocationServiceMap.layer),
    Layer.provide(RuntimeFlags.layer(flags)),
  )

const it = testEffect(agentLayer())

// Helper to evaluate permission for a tool with wildcard pattern
function evalPerm(agent: Agent.Info | undefined, permission: string): PermissionV1.Action | undefined {
  if (!agent) return undefined
  return Permission.evaluate(permission, "*", agent.permission).action
}

function load<A>(fn: (svc: Agent.Interface) => Effect.Effect<A>) {
  return Agent.Service.use(fn)
}

const expectDefaultAgentError = Effect.fn("AgentTest.expectDefaultAgentError")(function* (message: string) {
  const exit = yield* load((svc) => svc.defaultAgent()).pipe(Effect.exit)
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain(message)
})

afterEach(async () => {
  await disposeAllInstances()
})

it.instance("returns default native agents when no config", () =>
  Effect.gen(function* () {
    const agents = yield* load((svc) => svc.list())
    const names = agents.map((a) => a.name)
    // altimate fork replaces upstream single "build" agent with builder/analyst/reviewer/optimizer
    expect(names).toContain("builder")
    expect(names).toContain("analyst")
    expect(names).toContain("dbt-optimizer")
    expect(names).toContain("plan")
    expect(names).toContain("general")
    expect(names).toContain("explore")
    expect(names).toContain("compaction")
    expect(names).toContain("title")
    expect(names).toContain("summary")
  }),
)

it.instance("build agent has correct default properties", () =>
  Effect.gen(function* () {
    // "build" is an alias for the fork's "builder" agent
    const build = yield* load((svc) => svc.get("build"))
    expect(build).toBeDefined()
    expect(build?.mode).toBe("primary")
    expect(build?.native).toBe(true)
    expect(evalPerm(build, "edit")).toBe("allow")
    // altimate fork: bash defaults to "ask" (safety default) rather than "allow"
    expect(evalPerm(build, "bash")).toBe("ask")
  }),
)

it.instance("reviewer agent is read-only but usable outside the project (#978)", () =>
  Effect.gen(function* () {
    const reviewer = yield* load((svc) => svc.get("reviewer"))
    expect(reviewer).toBeDefined()
    // Structured read tools allowed
    expect(evalPerm(reviewer, "read")).toBe("allow")
    expect(evalPerm(reviewer, "grep")).toBe("allow")
    expect(evalPerm(reviewer, "glob")).toBe("allow")
    expect(evalPerm(reviewer, "list")).toBe("allow")
    // #978: paths outside the project prompt instead of hard-failing on the "*" deny
    expect(Permission.evaluate("external_directory", "/some/sibling/repo", reviewer!.permission).action).toBe("ask")
    // #978: PR/issue URLs are reviewable
    expect(evalPerm(reviewer, "webfetch")).toBe("allow")
    // #978: bash prompts (e.g. `gh pr view`) instead of hard-denying
    expect(Permission.evaluate("bash", "gh pr view 66 --repo AltimateAI/.claude", reviewer!.permission).action).toBe(
      "ask",
    )
    // Safety denials still hold even though bash asks
    expect(Permission.evaluate("bash", "DROP DATABASE prod", reviewer!.permission).action).toBe("deny")
    // Review never mutates
    expect(evalPerm(reviewer, "edit")).toBe("deny")
    expect(evalPerm(reviewer, "sql_execute_write")).toBe("deny")
  }),
)

it.instance("optimizer agent scans read-only and prompts on writes", () =>
  Effect.gen(function* () {
    const optimizer = yield* load((svc) => svc.get("dbt-optimizer"))
    expect(optimizer).toBeDefined()
    expect(optimizer?.mode).toBe("primary")
    expect(optimizer?.native).toBe(true)
    // Scan phase: read-only project + analysis tools allowed
    expect(evalPerm(optimizer, "read")).toBe("allow")
    expect(evalPerm(optimizer, "grep")).toBe("allow")
    expect(evalPerm(optimizer, "glob")).toBe("allow")
    expect(evalPerm(optimizer, "sql_analyze")).toBe("allow")
    expect(evalPerm(optimizer, "finops_expensive_queries")).toBe("allow")
    expect(evalPerm(optimizer, "dbt_manifest")).toBe("allow")
    expect(evalPerm(optimizer, "altimate_core_equivalence")).toBe("allow")
    // Paths outside the project prompt instead of hard-failing on the "*" deny
    expect(Permission.evaluate("external_directory", "/some/sibling/repo", optimizer!.permission).action).toBe("ask")
    // Fix phase: every file change and shell command prompts
    expect(evalPerm(optimizer, "edit")).toBe("ask")
    expect(Permission.evaluate("bash", "git checkout -b fix/foo", optimizer!.permission).action).toBe("ask")
    // Warehouse writes and destructive DDL are denied outright
    expect(evalPerm(optimizer, "sql_execute_write")).toBe("deny")
    expect(Permission.evaluate("bash", "DROP DATABASE prod", optimizer!.permission).action).toBe("deny")
    // Unknown tools fall through to the "*" deny
    expect(evalPerm(optimizer, "some_unknown_tool")).toBe("deny")
  }),
)

it.instance(
  "optimizer sql_execute_write deny survives a permissive user config",
  () =>
    Effect.gen(function* () {
      const optimizer = yield* load((svc) => svc.get("dbt-optimizer"))
      // The user's global "*": "allow" opens up edit/bash, but the warehouse-write
      // invariant is re-applied after the user config merge and must hold.
      expect(evalPerm(optimizer, "edit")).toBe("allow")
      expect(evalPerm(optimizer, "sql_execute_write")).toBe("deny")
      expect(Permission.evaluate("bash", "DROP DATABASE prod", optimizer!.permission).action).toBe("deny")
    }),
  {
    config: {
      permission: { "*": "allow" },
    },
  },
)

it.instance(
  "optimizer sql_execute_write deny survives a PER-AGENT permission override",
  () =>
    Effect.gen(function* () {
      const optimizer = yield* load((svc) => svc.get("dbt-optimizer"))
      // agent."dbt-optimizer".permission is merged after the native definition
      // (last-match-wins), so the warehouse-write invariant must be re-applied
      // after per-agent overrides too — not just after global cfg.permission.
      expect(evalPerm(optimizer, "sql_execute_write")).toBe("deny")
      // The rest of the per-agent override still applies
      expect(evalPerm(optimizer, "edit")).toBe("allow")
    }),
  {
    config: {
      agent: {
        "dbt-optimizer": {
          permission: { sql_execute_write: "allow", edit: "allow" },
        },
      },
    },
  },
)

it.instance(
  "dbt-optimizer bash boundary: user bash overrides relax builds, never DDL or SQL writes",
  () =>
    Effect.gen(function* () {
      const optimizer = yield* load((svc) => svc.get("dbt-optimizer"))
      // DOCUMENTED BOUNDARY: `bash` is "ask" by default; a user who explicitly
      // sets bash overrides accepts that dbt builds (which mutate a dev target)
      // run without a prompt. That is the user's choice — but the invariants
      // hold regardless: destructive DDL through bash stays denied, and the
      // direct SQL write tool stays denied.
      expect(
        Permission.evaluate("bash", "altimate-dbt build --model fct_orders", optimizer!.permission).action,
      ).toBe("allow")
      expect(Permission.evaluate("bash", "DROP DATABASE prod", optimizer!.permission).action).toBe("deny")
      expect(evalPerm(optimizer, "sql_execute_write")).toBe("deny")
    }),
  {
    config: {
      permission: { bash: "allow" },
      agent: {
        "dbt-optimizer": { permission: { bash: "allow" } },
      },
    },
  },
)

it.instance(
  "dbt-optimizer tool exposure: denied mutators disabled, edit-mapped and pattern-scoped tools kept",
  () =>
    Effect.gen(function* () {
      const optimizer = yield* load((svc) => svc.get("dbt-optimizer"))
      // Registry exposure uses Permission.disabled (last-match-wins + the
      // edit/write/apply_patch -> "edit" remap). The defaults' leading
      // "*": "allow" must NOT keep denied mutators exposed, and the edit
      // remap must NOT drop the write tool despite the "*" deny.
      const disabled = Permission.disabled(
        ["warehouse_remove", "warehouse_add", "task", "write", "apply_patch", "edit", "read", "bash", "sql_analyze"],
        optimizer!.permission,
      )
      expect(disabled.has("warehouse_remove")).toBe(true)
      expect(disabled.has("warehouse_add")).toBe(true)
      expect(disabled.has("task")).toBe(true)
      expect(disabled.has("write")).toBe(false)
      expect(disabled.has("apply_patch")).toBe(false)
      expect(disabled.has("edit")).toBe(false)
      expect(disabled.has("read")).toBe(false)
      expect(disabled.has("bash")).toBe(false)
      expect(disabled.has("sql_analyze")).toBe(false)
    }),
)

it.instance(
  "analyst tool exposure: pattern-scoped bash stays exposed, write tools disabled",
  () =>
    Effect.gen(function* () {
      const analyst = yield* load((svc) => svc.get("analyst"))
      const disabled = Permission.disabled(["bash", "write", "edit", "warehouse_remove", "sql_execute"], analyst!.permission)
      // bash has pattern-specific allows ("ls *", ...) — its last matching
      // rule is not a wildcard deny, so the tool remains exposed and its own
      // per-command asks govern.
      expect(disabled.has("bash")).toBe(false)
      expect(disabled.has("write")).toBe(true)
      expect(disabled.has("edit")).toBe(true)
      expect(disabled.has("warehouse_remove")).toBe(true)
      expect(disabled.has("sql_execute")).toBe(false)
    }),
)

it.instance("sensitive_write guard actually fires (not neutralized by *: allow)", () =>
  Effect.gen(function* () {
    // The #209 sensitive-write guard asks for the "sensitive_write" permission. It must NOT
    // fall through to the builder's "*": "allow" default (which silently auto-approved writes
    // to .env/.ssh/.git). Builder must prompt; write-restricted agents keep deny.
    const builder = yield* load((svc) => svc.get("builder"))
    expect(evalPerm(builder, "sensitive_write")).toBe("ask")
    const analyst = yield* load((svc) => svc.get("analyst"))
    expect(evalPerm(analyst, "sensitive_write")).toBe("deny")
    const reviewer = yield* load((svc) => svc.get("reviewer"))
    expect(evalPerm(reviewer, "sensitive_write")).toBe("deny")
    const optimizer = yield* load((svc) => svc.get("dbt-optimizer"))
    expect(evalPerm(optimizer, "sensitive_write")).toBe("deny")
  }),
)

it.instance("plan agent denies edits except .opencode/plans/*", () =>
  Effect.gen(function* () {
    const plan = yield* load((svc) => svc.get("plan"))
    expect(plan).toBeDefined()
    // Wildcard is denied
    expect(evalPerm(plan, "edit")).toBe("deny")
    // But specific path is allowed
    expect(Permission.evaluate("edit", ".opencode/plans/foo.md", plan!.permission).action).toBe("allow")
  }),
)

it.instance("plan agent denies the general subagent by default", () =>
  Effect.gen(function* () {
    const plan = yield* load((svc) => svc.get("plan"))
    expect(plan).toBeDefined()
    expect(Permission.evaluate("task", "general", plan!.permission).action).toBe("deny")
    expect(Permission.evaluate("task", "explore", plan!.permission).action).toBe("allow")
    expect(Permission.evaluate("task", "custom", plan!.permission).action).toBe("allow")
  }),
)

it.instance(
  "user permission can allow the general subagent from plan mode",
  () =>
    Effect.gen(function* () {
      const plan = yield* load((svc) => svc.get("plan"))
      expect(plan).toBeDefined()
      expect(Permission.evaluate("task", "general", plan!.permission).action).toBe("allow")
    }),
  {
    config: {
      permission: {
        task: {
          general: "allow",
        },
      },
    },
  },
)

it.instance("explore agent denies edit and write", () =>
  Effect.gen(function* () {
    const explore = yield* load((svc) => svc.get("explore"))
    expect(explore).toBeDefined()
    expect(explore?.mode).toBe("subagent")
    expect(evalPerm(explore, "edit")).toBe("deny")
    expect(evalPerm(explore, "write")).toBe("deny")
    expect(evalPerm(explore, "todowrite")).toBe("deny")
  }),
)

it.instance("explore agent asks for external directories and allows whitelisted external paths", () =>
  Effect.gen(function* () {
    const explore = yield* load((svc) => svc.get("explore"))
    expect(explore).toBeDefined()
    expect(Permission.evaluate("external_directory", "/some/other/path", explore!.permission).action).toBe("ask")
    expect(Permission.evaluate("external_directory", Truncate.GLOB, explore!.permission).action).toBe("allow")
    expect(
      Permission.evaluate("external_directory", path.join(Global.Path.tmp, "agent-work"), explore!.permission).action,
    ).toBe("allow")
  }),
)

it.instance(
  "reference config does not create subagents",
  () =>
    Effect.gen(function* () {
      const agents = yield* load((svc) => svc.list())
      const names = agents.map((agent) => agent.name)
      expect(names).not.toContain("effect")
      expect(names).not.toContain("effectFull")
      expect(names).not.toContain("localdocs")
      expect(names).not.toContain("localdocsFull")
    }),
  {
    config: {
      references: {
        effect: "github.com/effect/effect-smol",
        effectFull: {
          repository: "Effect-TS/effect",
          branch: "main",
        },
        localdocs: "../docs",
        localdocsFull: {
          path: "../local-docs",
        },
      },
    },
  },
)

it.instance("general agent denies todo tools", () =>
  Effect.gen(function* () {
    const general = yield* load((svc) => svc.get("general"))
    expect(general).toBeDefined()
    expect(general?.mode).toBe("subagent")
    expect(general?.hidden).toBeUndefined()
    expect(evalPerm(general, "todowrite")).toBe("deny")
  }),
)

it.instance("compaction agent denies all permissions", () =>
  Effect.gen(function* () {
    const compaction = yield* load((svc) => svc.get("compaction"))
    expect(compaction).toBeDefined()
    expect(compaction?.hidden).toBe(true)
    expect(evalPerm(compaction, "bash")).toBe("deny")
    expect(evalPerm(compaction, "edit")).toBe("deny")
    expect(evalPerm(compaction, "read")).toBe("deny")
  }),
)

it.instance(
  "custom agent from config creates new agent",
  () =>
    Effect.gen(function* () {
      const custom = yield* load((svc) => svc.get("my_custom_agent"))
      expect(custom).toBeDefined()
      expect(String(custom?.model?.providerID)).toBe("openai")
      expect(String(custom?.model?.modelID)).toBe("gpt-4")
      expect(custom?.description).toBe("My custom agent")
      expect(custom?.temperature).toBe(0.5)
      expect(custom?.topP).toBe(0.9)
      expect(custom?.native).toBe(false)
      expect(custom?.mode).toBe("all")
    }),
  {
    config: {
      agent: {
        my_custom_agent: {
          model: "openai/gpt-4",
          description: "My custom agent",
          temperature: 0.5,
          top_p: 0.9,
        },
      },
    },
  },
)

it.instance(
  "custom agent config overrides native agent properties",
  () =>
    Effect.gen(function* () {
      // altimate fork: override the native "builder" agent (upstream's "build")
      const build = yield* load((svc) => svc.get("builder"))
      expect(build).toBeDefined()
      expect(String(build?.model?.providerID)).toBe("anthropic")
      expect(String(build?.model?.modelID)).toBe("claude-3")
      expect(build?.description).toBe("Custom build agent")
      expect(build?.temperature).toBe(0.7)
      expect(build?.color).toBe("#FF0000")
      expect(build?.native).toBe(true)
    }),
  {
    config: {
      agent: {
        builder: {
          model: "anthropic/claude-3",
          description: "Custom build agent",
          temperature: 0.7,
          color: "#FF0000",
        },
      },
    },
  },
)

it.instance(
  "agent disable removes agent from list",
  () =>
    Effect.gen(function* () {
      const explore = yield* load((svc) => svc.get("explore"))
      expect(explore).toBeUndefined()
      const agents = yield* load((svc) => svc.list())
      const names = agents.map((a) => a.name)
      expect(names).not.toContain("explore")
    }),
  {
    config: {
      agent: {
        explore: { disable: true },
      },
    },
  },
)

it.instance(
  "agent permission config merges with defaults",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(build).toBeDefined()
      // Specific pattern is denied
      expect(Permission.evaluate("bash", "rm -rf *", build!.permission).action).toBe("deny")
      // Edit still allowed
      expect(evalPerm(build, "edit")).toBe("allow")
    }),
  {
    config: {
      agent: {
        build: {
          permission: {
            bash: {
              "rm -rf *": "deny",
            },
          },
        },
      },
    },
  },
)

it.instance(
  "global permission config applies to all agents",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(build).toBeDefined()
      expect(evalPerm(build, "bash")).toBe("deny")
    }),
  {
    config: {
      permission: {
        bash: "deny",
      },
    },
  },
)

it.instance(
  "agent steps/maxSteps config sets steps property",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      const plan = yield* load((svc) => svc.get("plan"))
      expect(build?.steps).toBe(50)
      expect(plan?.steps).toBe(100)
    }),
  {
    config: {
      agent: {
        build: { steps: 50 },
        plan: { maxSteps: 100 },
      },
    },
  },
)

it.instance(
  "agent mode can be overridden",
  () =>
    Effect.gen(function* () {
      const explore = yield* load((svc) => svc.get("explore"))
      expect(explore?.mode).toBe("primary")
    }),
  {
    config: {
      agent: {
        explore: { mode: "primary" },
      },
    },
  },
)

it.instance(
  "agent name can be overridden",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(build?.name).toBe("Builder")
    }),
  {
    config: {
      agent: {
        build: { name: "Builder" },
      },
    },
  },
)

it.instance(
  "agent prompt can be set from config",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(build?.prompt).toBe("Custom system prompt")
    }),
  {
    config: {
      agent: {
        build: { prompt: "Custom system prompt" },
      },
    },
  },
)

it.instance(
  "unknown agent properties are placed into options",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(build?.options.random_property).toBe("hello")
      expect(build?.options.another_random).toBe(123)
    }),
  {
    config: {
      agent: {
        build: {
          random_property: "hello",
          another_random: 123,
        },
      },
    },
  },
)

it.instance(
  "agent options merge correctly",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(build?.options.custom_option).toBe(true)
      expect(build?.options.another_option).toBe("value")
    }),
  {
    config: {
      agent: {
        build: {
          options: {
            custom_option: true,
            another_option: "value",
          },
        },
      },
    },
  },
)

it.instance(
  "multiple custom agents can be defined",
  () =>
    Effect.gen(function* () {
      const agentA = yield* load((svc) => svc.get("agent_a"))
      const agentB = yield* load((svc) => svc.get("agent_b"))
      expect(agentA?.description).toBe("Agent A")
      expect(agentA?.mode).toBe("subagent")
      expect(agentB?.description).toBe("Agent B")
      expect(agentB?.mode).toBe("primary")
    }),
  {
    config: {
      agent: {
        agent_a: {
          description: "Agent A",
          mode: "subagent",
        },
        agent_b: {
          description: "Agent B",
          mode: "primary",
        },
      },
    },
  },
)

it.instance(
  "Agent.list keeps the default agent first and sorts the rest by name",
  () =>
    Effect.gen(function* () {
      const names = (yield* load((svc) => svc.list())).map((a) => a.name)
      expect(names[0]).toBe("plan")
      expect(names.slice(1)).toEqual(names.slice(1).toSorted((a, b) => a.localeCompare(b)))
    }),
  {
    config: {
      default_agent: "plan",
      agent: {
        zebra: {
          description: "Zebra",
          mode: "subagent",
        },
        alpha: {
          description: "Alpha",
          mode: "subagent",
        },
      },
    },
  },
)

it.instance("Agent.get returns undefined for non-existent agent", () =>
  Effect.gen(function* () {
    const nonExistent = yield* load((svc) => svc.get("does_not_exist"))
    expect(nonExistent).toBeUndefined()
  }),
)

it.instance("default permission includes doom_loop and external_directory as ask", () =>
  Effect.gen(function* () {
    const build = yield* load((svc) => svc.get("build"))
    expect(evalPerm(build, "doom_loop")).toBe("ask")
    expect(evalPerm(build, "external_directory")).toBe("ask")
  }),
)

it.instance("webfetch is allowed by default", () =>
  Effect.gen(function* () {
    const build = yield* load((svc) => svc.get("build"))
    expect(evalPerm(build, "webfetch")).toBe("allow")
  }),
)

it.instance(
  "legacy tools config converts to permissions",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(evalPerm(build, "bash")).toBe("deny")
      expect(evalPerm(build, "read")).toBe("deny")
    }),
  {
    config: {
      agent: {
        build: {
          tools: {
            bash: false,
            read: false,
          },
        },
      },
    },
  },
)

it.instance(
  "legacy tools config maps write/edit/patch to edit permission",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(evalPerm(build, "edit")).toBe("deny")
    }),
  {
    config: {
      agent: {
        build: {
          tools: {
            write: false,
          },
        },
      },
    },
  },
)

it.instance(
  "Truncate.GLOB is allowed even when user denies external_directory globally",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(Permission.evaluate("external_directory", Truncate.GLOB, build!.permission).action).toBe("allow")
      expect(Permission.evaluate("external_directory", Truncate.DIR, build!.permission).action).toBe("deny")
      expect(Permission.evaluate("external_directory", "/some/other/path", build!.permission).action).toBe("deny")
    }),
  {
    config: {
      permission: {
        external_directory: "deny",
      },
    },
  },
)

it.instance("global tmp directory children are allowed for external_directory", () =>
  Effect.gen(function* () {
    const build = yield* load((svc) => svc.get("build"))
    expect(
      Permission.evaluate("external_directory", path.join(Global.Path.tmp, "scratch"), build!.permission).action,
    ).toBe("allow")
    expect(Permission.evaluate("external_directory", "/some/other/path", build!.permission).action).toBe("ask")
  }),
)

it.instance(
  "Truncate.GLOB is allowed even when user denies external_directory per-agent",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(Permission.evaluate("external_directory", Truncate.GLOB, build!.permission).action).toBe("allow")
      expect(Permission.evaluate("external_directory", Truncate.DIR, build!.permission).action).toBe("deny")
      expect(Permission.evaluate("external_directory", "/some/other/path", build!.permission).action).toBe("deny")
    }),
  {
    config: {
      agent: {
        build: {
          permission: {
            external_directory: "deny",
          },
        },
      },
    },
  },
)

it.instance(
  "explicit Truncate.GLOB deny is respected",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(Permission.evaluate("external_directory", Truncate.GLOB, build!.permission).action).toBe("deny")
      expect(Permission.evaluate("external_directory", Truncate.DIR, build!.permission).action).toBe("deny")
    }),
  {
    config: {
      permission: {
        external_directory: {
          "*": "deny",
          [Truncate.GLOB]: "deny",
        },
      },
    },
  },
)

it.instance(
  "skill directories are allowed for external_directory",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const skillDir = path.join(test.directory, ".opencode", "skill", "perm-skill")
      yield* Effect.promise(() =>
        Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: perm-skill
description: Permission skill.
---

# Permission Skill
`,
        ),
      )

      const home = process.env.OPENCODE_TEST_HOME
      process.env.OPENCODE_TEST_HOME = test.directory
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          process.env.OPENCODE_TEST_HOME = home
        }),
      )

      const build = yield* load((svc) => svc.get("build"))
      const target = path.join(skillDir, "reference", "notes.md")
      expect(Permission.evaluate("external_directory", target, build!.permission).action).toBe("allow")
    }),
  { git: true },
)

it.instance(
  "project reference directories are allowed for external_directory",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const build = yield* load((svc) => svc.get("build"))
      const target = path.resolve(test.directory, "../docs/reference/notes.md")
      expect(Permission.evaluate("external_directory", target, build!.permission).action).toBe("allow")
    }),
  {
    git: true,
    config: {
      references: {
        docs: "../docs",
      },
    },
  },
)

it.instance("defaultAgent returns build when no default_agent config", () =>
  Effect.gen(function* () {
    const agent = yield* load((svc) => svc.defaultAgent())
    // altimate fork: default primary agent is "builder" (upstream's "build")
    expect(agent).toBe("builder")
  }),
)

it.instance("defaultInfo returns resolved build agent when no default_agent config", () =>
  Effect.gen(function* () {
    const agent = yield* load((svc) => svc.defaultInfo())
    // altimate fork: default primary agent is "builder" (upstream's "build")
    expect(agent.name).toBe("builder")
    expect(agent.mode).toBe("primary")
  }),
)

it.instance(
  "defaultAgent respects default_agent config set to plan",
  () =>
    Effect.gen(function* () {
      const agent = yield* load((svc) => svc.defaultAgent())
      expect(agent).toBe("plan")
    }),
  {
    config: {
      default_agent: "plan",
    },
  },
)

it.instance(
  "defaultAgent respects default_agent config set to custom agent with mode all",
  () =>
    Effect.gen(function* () {
      const agent = yield* load((svc) => svc.defaultAgent())
      expect(agent).toBe("my_custom")
    }),
  {
    config: {
      default_agent: "my_custom",
      agent: {
        my_custom: {
          description: "My custom agent",
        },
      },
    },
  },
)

it.instance(
  "defaultAgent throws when default_agent points to subagent",
  () => expectDefaultAgentError('default agent "explore" is a subagent'),
  {
    config: {
      default_agent: "explore",
    },
  },
)

it.instance(
  "defaultAgent throws when default_agent points to hidden agent",
  () => expectDefaultAgentError('default agent "compaction" is hidden'),
  {
    config: {
      default_agent: "compaction",
    },
  },
)

it.instance(
  "defaultAgent throws when default_agent points to non-existent agent",
  () => expectDefaultAgentError('default agent "does_not_exist" not found'),
  {
    config: {
      default_agent: "does_not_exist",
    },
  },
)

it.instance(
  "defaultAgent returns plan when build is disabled and default_agent not set",
  () =>
    Effect.gen(function* () {
      const agent = yield* load((svc) => svc.defaultAgent())
      // altimate fork: builder/analyst/reviewer/optimizer are the primary agents before plan;
      // disabling them all leaves plan as the next visible primary agent
      expect(agent).toBe("plan")
    }),
  {
    config: {
      agent: {
        builder: { disable: true },
        analyst: { disable: true },
        reviewer: { disable: true },
        "dbt-optimizer": { disable: true },
      },
    },
  },
)

it.instance(
  "defaultAgent throws when all primary agents are disabled",
  () => expectDefaultAgentError("no primary visible agent found"),
  {
    config: {
      // altimate fork: builder/analyst/reviewer/optimizer/plan are all primary agents
      agent: {
        builder: { disable: true },
        analyst: { disable: true },
        reviewer: { disable: true },
        "dbt-optimizer": { disable: true },
        plan: { disable: true },
      },
    },
  },
)
