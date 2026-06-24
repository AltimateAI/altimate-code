import { LayerNode } from "@opencode-ai/core/effect/layer-node"
// altimate_change start — makeRuntime for the restored Promise wrapper (bottom of file)
import { makeRuntime } from "@/effect/run-service"
// altimate_change end
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Config } from "@/config/config"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Provider } from "@/provider/provider"

import { generateObject, streamObject, type ModelMessage } from "ai"
import { Truncate } from "@/tool/truncate"
import { Auth } from "../auth"
import { ProviderTransform } from "@/provider/transform"

import PROMPT_GENERATE from "./generate.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"
// altimate_change start - import custom agent mode prompts
import PROMPT_BUILDER from "../altimate/prompts/builder.txt"
import PROMPT_ANALYST from "../altimate/prompts/analyst.txt"
import PROMPT_REVIEWER from "../altimate/prompts/reviewer.txt"
// altimate_change end
import { Permission } from "@/permission"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@opencode-ai/core/global"
import path from "path"
import { Plugin } from "@/plugin"
import { Skill } from "../skill"
import { Effect, Context, Layer, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { AbsolutePath, type DeepMutable } from "@opencode-ai/core/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { PluginBoot } from "@opencode-ai/core/plugin/boot"
import { Reference } from "@opencode-ai/core/reference"
import { Location } from "@opencode-ai/core/location"

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  native: Schema.optional(Schema.Boolean),
  hidden: Schema.optional(Schema.Boolean),
  topP: Schema.optional(Schema.Finite),
  temperature: Schema.optional(Schema.Finite),
  color: Schema.optional(Schema.String),
  permission: PermissionV1.Ruleset,
  model: Schema.optional(
    Schema.Struct({
      modelID: ModelV2.ID,
      providerID: ProviderV2.ID,
    }),
  ),
  variant: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  options: Schema.Record(Schema.String, Schema.Unknown),
  steps: Schema.optional(Schema.Finite),
}).annotate({ identifier: "Agent" })
export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>

const GeneratedAgent = Schema.Struct({
  identifier: Schema.String,
  whenToUse: Schema.String,
  systemPrompt: Schema.String,
})

export interface Interface {
  readonly get: (agent: string) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Info[]>
  readonly defaultInfo: () => Effect.Effect<Info>
  readonly defaultAgent: () => Effect.Effect<string>
  readonly generate: (input: {
    description: string
    model?: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
  }) => Effect.Effect<
    {
      identifier: string
      whenToUse: string
      systemPrompt: string
    },
    Provider.DefaultModelError
  >
}

type State = Omit<Interface, "generate">

export class Service extends Context.Service<Service, Interface>()("@opencode/Agent") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const auth = yield* Auth.Service
    const plugin = yield* Plugin.Service
    const skill = yield* Skill.Service
    const provider = yield* Provider.Service
    const locations = yield* LocationServiceMap

    const state = yield* InstanceState.make<State>(
      Effect.fn("Agent.state")(function* (ctx) {
        const cfg = yield* config.get()
        const skillDirs = yield* skill.dirs()
        const referenceDirs = yield* Effect.gen(function* () {
          yield* (yield* PluginBoot.Service).wait()
          return (yield* (yield* Reference.Service).list()).map((reference) => reference.path)
        }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }))))
        const whitelistedDirs = [
          Truncate.GLOB,
          path.join(Global.Path.tmp, "*"),
          ...skillDirs.map((dir) => path.join(dir, "*")),
          ...referenceDirs.map((dir) => path.join(dir, "*")),
        ]
        const readonlyExternalDirectory = {
          "*": "ask",
          ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
        } satisfies Record<string, "allow" | "ask" | "deny">

        const defaults = Permission.fromConfig({
          "*": "allow",
          doom_loop: "ask",
          external_directory: {
            "*": "ask",
            ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
          },
          question: "deny",
          plan_enter: "deny",
          plan_exit: "deny",
          // mirrors github.com/github/gitignore Node.gitignore pattern for .env files
          read: {
            "*": "allow",
            "*.env": "ask",
            "*.env.*": "ask",
            "*.env.example": "allow",
          },
          // altimate_change start - bash safety defaults for destructive file/git/DDL commands
          // Safety defaults for bash commands.
          // IMPORTANT: "*": "ask" must come FIRST because evaluation uses last-match-wins.
          //
          // "ask" = user sees prompt and can approve. Used for destructive file/git
          //         commands that are common in legitimate workflows (rm -rf ./build,
          //         git push --force after rebase, git clean in CI).
          // "deny" = blocked entirely, no prompt. Used for database DDL that is
          //          almost never intentional in an agent context.
          //
          // Users can override any of these in altimate-code.json.
          bash: {
            "*": "ask",
            "rm -rf *": "ask",
            "rm -fr *": "ask",
            "git push --force *": "ask",
            "git push -f *": "ask",
            "git reset --hard *": "ask",
            "git clean -f *": "ask",
            "DROP DATABASE *": "deny",
            "DROP SCHEMA *": "deny",
            "TRUNCATE *": "deny",
            "drop database *": "deny",
            "drop schema *": "deny",
            "truncate *": "deny",
          },
          // altimate_change end
        })

        const user = Permission.fromConfig(cfg.permission ?? {})

        // altimate_change start - safety deny rules that cannot be overridden by wildcard allows
        // Safety deny rules that CANNOT be overridden by wildcard allows.
        // Appended after user config so they always take precedence via last-match-wins.
        // Users who need to override must use specific patterns like
        // `"DROP DATABASE test_db": "allow"` — wildcard `bash: "allow"` won't work.
        // Both UPPER and lowercase variants are included because Wildcard.match
        // is case-sensitive on Linux/macOS.
        const safetyDenials = Permission.fromConfig({
          bash: {
            "DROP DATABASE *": "deny",
            "DROP SCHEMA *": "deny",
            "TRUNCATE *": "deny",
            "drop database *": "deny",
            "drop schema *": "deny",
            "truncate *": "deny",
            "Drop Database *": "deny",
            "Drop Schema *": "deny",
            "Truncate *": "deny",
          },
          // SQL write safety denials
          sql_execute_write: {
            "DROP DATABASE *": "deny",
            "DROP SCHEMA *": "deny",
            "TRUNCATE *": "deny",
            "drop database *": "deny",
            "drop schema *": "deny",
            "truncate *": "deny",
            "Drop Database *": "deny",
            "Drop Schema *": "deny",
            "Truncate *": "deny",
          },
        })

        // Combine user config with safety denials so every agent inherits them
        const userWithSafety = Permission.merge(user, safetyDenials)
        // altimate_change end

        const agents: Record<string, Info> = {
          // altimate_change start - 3 modes: builder, analyst, plan (replaces upstream single "build" agent)
          builder: {
            name: "builder",
            description: "Create and modify dbt models, SQL, and data pipelines. Full read/write access.",
            prompt: PROMPT_BUILDER,
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_enter: "allow",
                sql_execute_write: "ask",
              }),
              userWithSafety,
            ),
            mode: "primary",
            native: true,
          },
          analyst: {
            name: "analyst",
            description: "Read-only data exploration and analysis. Cannot modify files or run destructive SQL.",
            prompt: PROMPT_ANALYST,
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                // SQL read tools
                sql_execute: "allow",
                altimate_core_validate: "allow",
                sql_analyze: "allow",
                sql_translate: "allow",
                sql_optimize: "allow",
                lineage_check: "allow",
                sql_explain: "allow",
                sql_format: "allow",
                sql_fix: "allow",
                sql_autocomplete: "allow",
                sql_diff: "allow",
                // SQL writes denied
                sql_execute_write: "deny",
                // Warehouse/schema/finops
                warehouse_list: "allow",
                warehouse_test: "allow",
                warehouse_discover: "allow",
                schema_inspect: "allow",
                schema_index: "allow",
                schema_search: "allow",
                schema_cache_status: "allow",
                schema_detect_pii: "allow",
                schema_tags: "allow",
                schema_tags_list: "allow",
                finops_query_history: "allow",
                finops_analyze_credits: "allow",
                finops_expensive_queries: "allow",
                finops_warehouse_advice: "allow",
                finops_unused_resources: "allow",
                finops_role_grants: "allow",
                finops_role_hierarchy: "allow",
                finops_user_roles: "allow",
                // Core tools
                altimate_core_check: "allow",
                altimate_core_rewrite: "allow",
                // Read-only file access
                read: "allow",
                grep: "allow",
                glob: "allow",
                webfetch: "allow",
                websearch: "allow",
                question: "allow",
                tool_lookup: "allow",
                // Bash: last-match-wins — "*": "deny" MUST come first, then specific allows override
                bash: {
                  "*": "deny",
                  "ls *": "allow",
                  "grep *": "allow",
                  "cat *": "allow",
                  "head *": "allow",
                  "tail *": "allow",
                  "find *": "allow",
                  "wc *": "allow",
                  "dbt list *": "allow",
                  "dbt ls *": "allow",
                  "dbt debug *": "allow",
                },
                // Training
                training_save: "allow",
                training_list: "allow",
                training_remove: "allow",
              }),
              userWithSafety,
            ),
            mode: "primary",
            native: true,
          },
          // reviewer agent: dbt PR review verdict engine
          reviewer: {
            name: "reviewer",
            description:
              "dbt PR reviewer. Runs the dbt_pr_review verdict engine (lineage, equivalence, PII, grade) plus read-only analysis tools and posts findings. Edit/write tools are denied; bash is denied.",
            prompt: PROMPT_REVIEWER,
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                // The verdict engine + the read-only analysis tools it composes.
                dbt_pr_review: "allow",
                impact_analysis: "allow",
                altimate_core_check: "allow",
                altimate_core_grade: "allow",
                altimate_core_equivalence: "allow",
                altimate_core_column_lineage: "allow",
                altimate_core_compare: "allow",
                lineage_check: "allow",
                sql_analyze: "allow",
                sql_diff: "allow",
                schema_detect_pii: "allow",
                // Writes denied — review never mutates the project.
                sql_execute_write: "deny",
                // Read-only file + repo access (structured tools, not bash).
                read: "allow",
                grep: "allow",
                glob: "allow",
                tool_lookup: "allow",
                // Bash is DENIED. A string-prefix bash allowlist (e.g. `git log *`)
                // cannot safely bound argv: shell redirects ride inside the matched
                // command (`git log -p > ~/.ssh/authorized_keys`) and `cat *` reads
                // any file — both bypass the "read-only" intent and enable
                // write/exfil. The reviewer uses the structured read/grep/glob tools
                // and the verdict engine (which does its own diffing) instead.
                bash: "deny",
              }),
              userWithSafety,
            ),
            mode: "primary",
            native: true,
          },
          // altimate_change end
          plan: {
            name: "plan",
            description: "Plan mode. Disallows all edit tools.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_exit: "allow",
                task: {
                  general: "deny",
                },
                external_directory: {
                  [path.join(Global.Path.data, "plans", "*")]: "allow",
                },
                edit: {
                  "*": "deny",
                  [path.join(".opencode", "plans", "*.md")]: "allow",
                  [path.relative(ctx.worktree, path.join(Global.Path.data, path.join("plans", "*.md")))]: "allow",
                },
              }),
              // altimate_change start - inherit safety denials
              userWithSafety,
              // altimate_change end
            ),
            mode: "primary",
            native: true,
          },
          general: {
            name: "general",
            description: `General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                todowrite: "deny",
              }),
              // altimate_change start - inherit safety denials
              userWithSafety,
              // altimate_change end
            ),
            options: {},
            mode: "subagent",
            native: true,
          },
          explore: {
            name: "explore",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                grep: "allow",
                glob: "allow",
                list: "allow",
                bash: "allow",
                webfetch: "allow",
                websearch: "allow",
                read: "allow",
                external_directory: readonlyExternalDirectory,
              }),
              // altimate_change start - inherit safety denials
              userWithSafety,
              // altimate_change end
            ),
            description: `Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.`,
            prompt: PROMPT_EXPLORE,
            options: {},
            mode: "subagent",
            native: true,
          },
          compaction: {
            name: "compaction",
            mode: "primary",
            native: true,
            hidden: true,
            prompt: PROMPT_COMPACTION,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              // altimate_change start - inherit safety denials
              userWithSafety,
              // altimate_change end
            ),
            options: {},
          },
          title: {
            name: "title",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            temperature: 0.5,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              // altimate_change start - inherit safety denials
              userWithSafety,
              // altimate_change end
            ),
            prompt: PROMPT_TITLE,
          },
          summary: {
            name: "summary",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              // altimate_change start - inherit safety denials
              userWithSafety,
              // altimate_change end
            ),
            prompt: PROMPT_SUMMARY,
          },
        }

        for (const [key, value] of Object.entries(cfg.agent ?? {})) {
          if (value.disable) {
            delete agents[key]
            continue
          }
          let item = agents[key]
          if (!item)
            item = agents[key] = {
              name: key,
              mode: "all",
              // altimate_change start - new agents inherit safety denials
              permission: Permission.merge(defaults, userWithSafety),
              // altimate_change end
              options: {},
              native: false,
            }
          if (value.model) item.model = Provider.parseModel(value.model)
          item.variant = value.variant ?? item.variant
          item.prompt = value.prompt ?? item.prompt
          item.description = value.description ?? item.description
          item.temperature = value.temperature ?? item.temperature
          item.topP = value.top_p ?? item.topP
          item.mode = value.mode ?? item.mode
          item.color = value.color ?? item.color
          item.hidden = value.hidden ?? item.hidden
          item.name = value.name ?? item.name
          item.steps = value.steps ?? item.steps
          item.options = mergeDeep(item.options, value.options ?? {})
          // altimate_change start - re-apply safety denials AFTER user config so they cannot be overridden
          item.permission = Permission.merge(
            item.permission,
            Permission.fromConfig(value.permission ?? {}),
            safetyDenials,
          )
          // altimate_change end
        }

        // Ensure Truncate.GLOB is allowed unless explicitly configured
        for (const name in agents) {
          const agent = agents[name]
          const explicit = agent.permission.some((r) => {
            if (r.permission !== "external_directory") return false
            if (r.action !== "deny") return false
            return r.pattern === Truncate.GLOB
          })
          if (explicit) continue

          agents[name].permission = Permission.merge(
            agents[name].permission,
            Permission.fromConfig({ external_directory: { [Truncate.GLOB]: "allow" } }),
          )
        }

        const get = Effect.fnUntraced(function* (agent: string) {
          // altimate_change start — "build" alias for "builder" (renamed agent)
          if (!agents[agent] && agent === "build") return agents["builder"]
          // altimate_change end
          return agents[agent]
        })

        const list = Effect.fnUntraced(function* () {
          const cfg = yield* config.get()
          return pipe(
            agents,
            values(),
            sortBy(
              // altimate_change start - default agent is "builder" not "build"
              [(x) => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "builder"), "desc"],
              // altimate_change end
              [(x) => x.name, "asc"],
            ),
          )
        })

        const defaultInfo = Effect.fnUntraced(function* () {
          const c = yield* config.get()
          if (c.default_agent) {
            const agent = agents[c.default_agent]
            if (!agent) throw new Error(`default agent "${c.default_agent}" not found`)
            if (agent.mode === "subagent") throw new Error(`default agent "${c.default_agent}" is a subagent`)
            if (agent.hidden === true) throw new Error(`default agent "${c.default_agent}" is hidden`)
            return agent
          }
          const visible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
          if (!visible) throw new Error("no primary visible agent found")
          return visible
        })

        const defaultAgent = Effect.fnUntraced(function* () {
          return (yield* defaultInfo()).name
        })

        return {
          get,
          list,
          defaultInfo,
          defaultAgent,
        } satisfies State
      }),
    )

    return Service.of({
      get: Effect.fn("Agent.get")(function* (agent: string) {
        return yield* InstanceState.useEffect(state, (s) => s.get(agent))
      }),
      list: Effect.fn("Agent.list")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.list())
      }),
      defaultInfo: Effect.fn("Agent.defaultInfo")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultInfo())
      }),
      defaultAgent: Effect.fn("Agent.defaultAgent")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultAgent())
      }),
      generate: Effect.fn("Agent.generate")(function* (input: {
        description: string
        model?: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      }) {
        const cfg = yield* config.get()
        const model = input.model ?? (yield* provider.defaultModel())
        const resolved = yield* provider.getModel(model.providerID, model.modelID)
        const language = yield* provider.getLanguage(resolved)
        const tracer = cfg.experimental?.openTelemetry
          ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
          : undefined

        const system = [PROMPT_GENERATE]
        yield* plugin.trigger("experimental.chat.system.transform", { model: resolved }, { system })
        const existing = yield* InstanceState.useEffect(state, (s) => s.list())

        // TODO: clean this up so provider specific logic doesnt bleed over
        const authInfo = yield* auth.get(model.providerID).pipe(Effect.orDie)
        const isOpenaiOauth = model.providerID === "openai" && authInfo?.type === "oauth"

        const params = {
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            tracer,
            metadata: {
              userId: cfg.username ?? "unknown",
            },
          },
          temperature: 0.3,
          messages: [
            ...(isOpenaiOauth
              ? []
              : system.map(
                  (item): ModelMessage => ({
                    role: "system",
                    content: item,
                  }),
                )),
            {
              role: "user",
              content: `Create an agent configuration based on this request: "${input.description}".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
            },
          ],
          model: language,
          schema: Object.assign(
            Schema.toStandardSchemaV1(GeneratedAgent),
            Schema.toStandardJSONSchemaV1(GeneratedAgent),
          ),
        } satisfies Parameters<typeof generateObject>[0]

        if (isOpenaiOauth) {
          return yield* Effect.promise(async () => {
            const result = streamObject({
              ...params,
              providerOptions: ProviderTransform.providerOptions(resolved, {
                instructions: system.join("\n"),
                store: false,
              }),
              onError: () => {},
            })
            for await (const part of result.fullStream) {
              if (part.type === "error") throw part.error
            }
            return result.object
          })
        }

        return yield* Effect.promise(() => generateObject(params).then((r) => r.object))
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Plugin.defaultLayer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Skill.defaultLayer),
  Layer.provide(LocationServiceMap.layer),
)

const locationServiceMapNode = LayerNode.make(LocationServiceMap.layer, [])

export const node = LayerNode.make(layer, [
  Config.node,
  Auth.node,
  Plugin.node,
  Skill.node,
  Provider.node,
  locationServiceMapNode,
])

// altimate_change start — restore the imperative Promise wrapper upstream removed in the
// Effect-only migration; the HTTP server consumes Agent.list() directly.
const { runPromise: runAgent } = makeRuntime(Service, defaultLayer as Layer.Layer<Service>)
export async function list() {
  return runAgent((s) => s.list())
}
// altimate_change end

export * as Agent from "./agent"
