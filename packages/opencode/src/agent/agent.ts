import { Config } from "../config/config"
import z from "zod"
import { Provider } from "../provider/provider"
import { ModelID, ProviderID } from "../provider/schema"
import { generateObject, streamObject, type ModelMessage } from "ai"
import { SystemPrompt } from "../session/system"
import { Instance } from "../project/instance"
import { Truncate } from "../tool/truncation"
import { Auth } from "../auth"
import { ProviderTransform } from "../provider/transform"

import PROMPT_GENERATE from "./generate.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"
// altimate_change start - import custom agent mode prompts
import PROMPT_BUILDER from "../altimate/prompts/builder.txt"
import PROMPT_ANALYST from "../altimate/prompts/analyst.txt"
// altimate_change end
import { PermissionNext } from "@/permission/next"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@/global"
import path from "path"
import { Plugin } from "@/plugin"
import { Skill } from "../skill"

export namespace Agent {
  export const Info = z
    .object({
      name: z.string(),
      description: z.string().optional(),
      mode: z.enum(["subagent", "primary", "all"]),
      native: z.boolean().optional(),
      hidden: z.boolean().optional(),
      topP: z.number().optional(),
      temperature: z.number().optional(),
      color: z.string().optional(),
      permission: PermissionNext.Ruleset,
      model: z
        .object({
          modelID: ModelID.zod,
          providerID: ProviderID.zod,
        })
        .optional(),
      variant: z.string().optional(),
      prompt: z.string().optional(),
      options: z.record(z.string(), z.any()),
      steps: z.number().int().positive().optional(),
    })
    .meta({
      ref: "Agent",
    })
  export type Info = z.infer<typeof Info>

  const state = Instance.state(async () => {
    const cfg = await Config.get()

    const skillDirs = await Skill.dirs()
    const whitelistedDirs = [Truncate.GLOB, ...skillDirs.map((dir) => path.join(dir, "*"))]
    const defaults = PermissionNext.fromConfig({
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
    })
    const user = PermissionNext.fromConfig(cfg.permission ?? {})

    // Safety deny rules that CANNOT be overridden by wildcard allows.
    // Appended after user config so they always take precedence via last-match-wins.
    // Users who need to override must use specific patterns like
    // `"DROP DATABASE test_db": "allow"` — wildcard `bash: "allow"` won't work.
    // Both UPPER and lowercase variants are included because Wildcard.match
    // is case-sensitive on Linux/macOS.
    const safetyDenials = PermissionNext.fromConfig({
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
      // altimate_change start - SQL write safety denials
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
      // altimate_change end
    })

    // Combine user config with safety denials so every agent inherits them
    const userWithSafety = PermissionNext.merge(user, safetyDenials)

    const result: Record<string, Info> = {
      // altimate_change start - 3 modes: builder, analyst, plan
      builder: {
        name: "builder",
        description: "Create and modify dbt models, SQL, and data pipelines. Full read/write access.",
        prompt: PROMPT_BUILDER,
        options: {},
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
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
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            // SQL read tools
            sql_execute: "allow", sql_validate: "allow", sql_analyze: "allow",
            sql_translate: "allow", sql_optimize: "allow", lineage_check: "allow",
            sql_explain: "allow", sql_format: "allow", sql_fix: "allow",
            sql_autocomplete: "allow", sql_diff: "allow",
            // SQL writes denied
            sql_execute_write: "deny",
            // Warehouse/schema/finops
            warehouse_list: "allow", warehouse_test: "allow", warehouse_discover: "allow",
            schema_inspect: "allow", schema_index: "allow", schema_search: "allow",
            schema_cache_status: "allow", schema_detect_pii: "allow",
            schema_tags: "allow", schema_tags_list: "allow",
            finops_query_history: "allow", finops_analyze_credits: "allow",
            finops_expensive_queries: "allow", finops_warehouse_advice: "allow",
            finops_unused_resources: "allow", finops_role_grants: "allow",
            finops_role_hierarchy: "allow", finops_user_roles: "allow",
            // Core tools
            altimate_core_validate: "allow", altimate_core_check: "allow",
            altimate_core_rewrite: "allow",
            // Read-only file access
            read: "allow", grep: "allow", glob: "allow",
            webfetch: "allow", websearch: "allow",
            question: "allow", tool_lookup: "allow",
            // Bash: last-match-wins — "*": "deny" MUST come first, then specific allows override
            bash: {
              "*": "deny",
              "ls *": "allow", "grep *": "allow", "cat *": "allow",
              "head *": "allow", "tail *": "allow", "find *": "allow", "wc *": "allow",
              "dbt list *": "allow", "dbt ls *": "allow", "dbt debug *": "allow",
            },
            // Training
            training_save: "allow", training_list: "allow", training_remove: "allow",
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
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            question: "allow",
            plan_exit: "allow",
            external_directory: {
              [path.join(Global.Path.data, "plans", "*")]: "allow",
            },
            edit: {
              "*": "deny",
              [path.join(".opencode", "plans", "*.md")]: "allow",
              [path.relative(Instance.worktree, path.join(Global.Path.data, path.join("plans", "*.md")))]: "allow",
            },
          }),
          userWithSafety,
        ),
        mode: "primary",
        native: true,
      },
      general: {
        name: "general",
        description: `General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.`,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            todoread: "deny",
            todowrite: "deny",
          }),
          userWithSafety,
        ),
        options: {},
        mode: "subagent",
        native: true,
      },
      explore: {
        name: "explore",
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            grep: "allow",
            glob: "allow",
            list: "allow",
            bash: "allow",
            webfetch: "allow",
            websearch: "allow",
            codesearch: "allow",
            read: "allow",
            external_directory: {
              "*": "ask",
              ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
            },
          }),
          userWithSafety,
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
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
          }),
          userWithSafety,
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
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
          }),
          userWithSafety,
        ),
        prompt: PROMPT_TITLE,
      },
      summary: {
        name: "summary",
        mode: "primary",
        options: {},
        native: true,
        hidden: true,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
          }),
          userWithSafety,
        ),
        prompt: PROMPT_SUMMARY,
      },
    }

    for (const [key, value] of Object.entries(cfg.agent ?? {})) {
      if (value.disable) {
        delete result[key]
        continue
      }
      let item = result[key]
      if (!item)
        item = result[key] = {
          name: key,
          mode: "all",
          permission: PermissionNext.merge(defaults, userWithSafety),
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
      // Re-apply safety denials AFTER user config so they cannot be overridden
      item.permission = PermissionNext.merge(item.permission, PermissionNext.fromConfig(value.permission ?? {}), safetyDenials)
    }

    // Ensure Truncate.GLOB is allowed unless explicitly configured
    for (const name in result) {
      const agent = result[name]
      const explicit = agent.permission.some((r) => {
        if (r.permission !== "external_directory") return false
        if (r.action !== "deny") return false
        return r.pattern === Truncate.GLOB
      })
      if (explicit) continue

      result[name].permission = PermissionNext.merge(
        result[name].permission,
        PermissionNext.fromConfig({ external_directory: { [Truncate.GLOB]: "allow" } }),
      )
    }

    return result
  })

  export async function get(agent: string) {
    return state().then((x) => x[agent])
  }

  export async function list() {
    const cfg = await Config.get()
    return pipe(
      await state(),
      values(),
      // altimate_change start - default agent is "builder" not "build"
      sortBy([(x) => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "builder"), "desc"]),
      // altimate_change end
    )
  }

  export async function defaultAgent() {
    const cfg = await Config.get()
    const agents = await state()

    if (cfg.default_agent) {
      const agent = agents[cfg.default_agent]
      if (!agent) throw new Error(`default agent "${cfg.default_agent}" not found`)
      if (agent.mode === "subagent") throw new Error(`default agent "${cfg.default_agent}" is a subagent`)
      if (agent.hidden === true) throw new Error(`default agent "${cfg.default_agent}" is hidden`)
      return agent.name
    }

    const primaryVisible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
    if (!primaryVisible) throw new Error("no primary visible agent found")
    return primaryVisible.name
  }

  export async function generate(input: { description: string; model?: { providerID: ProviderID; modelID: ModelID } }) {
    const cfg = await Config.get()
    const defaultModel = input.model ?? (await Provider.defaultModel())
    const model = await Provider.getModel(defaultModel.providerID, defaultModel.modelID)
    const language = await Provider.getLanguage(model)

    const system = [PROMPT_GENERATE]
    await Plugin.trigger("experimental.chat.system.transform", { model }, { system })
    const existing = await list()

    const params = {
      experimental_telemetry: {
        isEnabled: cfg.experimental?.openTelemetry,
        metadata: {
          userId: cfg.username ?? "unknown",
        },
      },
      temperature: 0.3,
      messages: [
        ...system.map(
          (item): ModelMessage => ({
            role: "system",
            content: item,
          }),
        ),
        {
          role: "user",
          content: `Create an agent configuration based on this request: \"${input.description}\".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
        },
      ],
      model: language,
      schema: z.object({
        identifier: z.string(),
        whenToUse: z.string(),
        systemPrompt: z.string(),
      }),
    } satisfies Parameters<typeof generateObject>[0]

    if (defaultModel.providerID === "openai" && (await Auth.get(defaultModel.providerID))?.type === "oauth") {
      const result = streamObject({
        ...params,
        providerOptions: ProviderTransform.providerOptions(model, {
          instructions: SystemPrompt.instructions(),
          store: false,
        }),
        onError: () => {},
      })
      for await (const part of result.fullStream) {
        if (part.type === "error") throw part.error
      }
      return result.object
    }

    const result = await generateObject(params)
    return result.object
  }
}
