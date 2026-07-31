import { PlanExitTool } from "./plan"
import { QuestionTool } from "./question"
import { BashTool } from "./bash"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
// altimate_change start — keep BatchTool: upstream deleted batch.ts in #21052 (tool system
// refactor) but we still ship it under the experimental.batch_tool flag. Marker added so a
// future upstream merge that removes batch.ts doesn't silently delete this import without
// surfacing in the analyzer.
import { BatchTool } from "./batch"
// altimate_change end
import { ReadTool } from "./read"
import { TaskTool } from "./task"
import { TodoWriteTool } from "./todo"
import { WebFetchTool } from "./webfetch"
import { WriteTool } from "./write"
import { InvalidTool } from "./invalid"
import { SkillTool } from "./skill"
import type { Agent } from "../agent/agent"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
// altimate_change start — restore Instance ALS for the Effect Service facade
import { InstanceRef } from "../effect/instance-ref"
// altimate_change end
import { Config } from "../config/config"
import path from "path"
import { type ToolContext as PluginToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import z from "zod"
import { Plugin } from "../plugin"
import { ProviderID, type ModelID } from "../provider/schema"
import { WebSearchTool } from "./websearch"
import { CodeSearchTool } from "./codesearch"
import { Flag } from "@/flag/flag"
import { Log } from "@/util/log"
import { LspTool } from "./lsp"
// altimate_change start — bridge legacy plugin tools to the Effect Tool API (v1.17.9)
import { Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { legacyToInit, isZodType } from "../altimate/tool-zod-compat"
import { AppRuntime } from "@/effect/app-runtime"
// altimate_change end
// altimate_change start — upstream_fix: task.background schema follows RuntimeFlags.
import { RuntimeFlags } from "@/effect/runtime-flags"
// altimate_change end
// altimate_change start — upstream port (v1.18.10 code mode): MCP catalog description deps
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import * as Permission from "@/permission"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
// altimate_change end
// altimate_change start — Effect Context.Service facade so v1.17.9 consumers that compose
// ToolRegistry into the Effect runtime (yield* ToolRegistry.Service / .defaultLayer / .node)
// compile. Delegates to the existing namespace functions; behavior preserved.
import { Context, Layer, Option } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
// altimate_change end

import { ApplyPatchTool } from "./apply_patch"
import { Glob } from "../util/glob"
import { pathToFileURL } from "url"

// altimate_change start - import custom data engineering tools
import { SqlExecuteTool } from "../altimate/tools/sql-execute"
import { SchemaInspectTool } from "../altimate/tools/schema-inspect"
import { SqlAnalyzeTool } from "../altimate/tools/sql-analyze"
import { SqlOptimizeTool } from "../altimate/tools/sql-optimize"
import { SqlTranslateTool } from "../altimate/tools/sql-translate"
import { LineageCheckTool } from "../altimate/tools/lineage-check"
import { WarehouseListTool } from "../altimate/tools/warehouse-list"
import { WarehouseTestTool } from "../altimate/tools/warehouse-test"
import { WarehouseAddTool } from "../altimate/tools/warehouse-add"
import { WarehouseRemoveTool } from "../altimate/tools/warehouse-remove"
import { WarehouseDiscoverTool } from "../altimate/tools/warehouse-discover"
import { McpDiscoverTool } from "../altimate/tools/mcp-discover"

import { DbtManifestTool } from "../altimate/tools/dbt-manifest"
// altimate_change start - import dbt unit test generation tool
import { DbtUnitTestGenTool } from "../altimate/tools/dbt-unit-test-gen"
// altimate_change end
import { DbtProfilesTool } from "../altimate/tools/dbt-profiles"
import { DbtLineageTool } from "../altimate/tools/dbt-lineage"
import { SchemaIndexTool } from "../altimate/tools/schema-index"
import { SchemaSearchTool } from "../altimate/tools/schema-search"
import { SchemaCacheStatusTool } from "../altimate/tools/schema-cache-status"
import { SqlExplainTool } from "../altimate/tools/sql-explain"
import { SqlFormatTool } from "../altimate/tools/sql-format"
import { SqlFixTool } from "../altimate/tools/sql-fix"
import { SqlAutocompleteTool } from "../altimate/tools/sql-autocomplete"
import { SqlDiffTool } from "../altimate/tools/sql-diff"
import { DataDiffTool } from "../altimate/tools/data-diff"
import { FinopsQueryHistoryTool } from "../altimate/tools/finops-query-history"
import { FinopsAnalyzeCreditsTool } from "../altimate/tools/finops-analyze-credits"
import { FinopsExpensiveQueriesTool } from "../altimate/tools/finops-expensive-queries"
import { FinopsWarehouseAdviceTool } from "../altimate/tools/finops-warehouse-advice"
import { FinopsUnusedResourcesTool } from "../altimate/tools/finops-unused-resources"
import {
  FinopsRoleGrantsTool,
  FinopsRoleHierarchyTool,
  FinopsUserRolesTool,
} from "../altimate/tools/finops-role-access"
import { SchemaDetectPiiTool } from "../altimate/tools/schema-detect-pii"
import { SchemaTagsTool, SchemaTagsListTool } from "../altimate/tools/schema-tags"
import { SqlRewriteTool } from "../altimate/tools/sql-rewrite"
import { SchemaDiffTool } from "../altimate/tools/schema-diff"
import { AltimateCoreValidateTool } from "../altimate/tools/altimate-core-validate"
import { AltimateCoreCheckTool } from "../altimate/tools/altimate-core-check"
import { AltimateCoreFixTool } from "../altimate/tools/altimate-core-fix"
import { AltimateCorePolicyTool } from "../altimate/tools/altimate-core-policy"
import { AltimateCoreSemanticsTool } from "../altimate/tools/altimate-core-semantics"
import { AltimateCoreTestgenTool } from "../altimate/tools/altimate-core-testgen"
import { AltimateCoreEquivalenceTool } from "../altimate/tools/altimate-core-equivalence"
import { AltimateCoreMigrationTool } from "../altimate/tools/altimate-core-migration"
import { AltimateCoreSchemaDiffTool } from "../altimate/tools/altimate-core-schema-diff"
import { AltimateCoreCorrectTool } from "../altimate/tools/altimate-core-correct"
import { AltimateCoreGradeTool } from "../altimate/tools/altimate-core-grade"
import { AltimateCoreClassifyPiiTool } from "../altimate/tools/altimate-core-classify-pii"
import { AltimateCoreQueryPiiTool } from "../altimate/tools/altimate-core-query-pii"
import { AltimateCoreResolveTermTool } from "../altimate/tools/altimate-core-resolve-term"
import { AltimateCoreColumnLineageTool } from "../altimate/tools/altimate-core-column-lineage"
import { AltimateCoreTrackLineageTool } from "../altimate/tools/altimate-core-track-lineage"
import { AltimateCoreExtractMetadataTool } from "../altimate/tools/altimate-core-extract-metadata"
import { AltimateCoreCompareTool } from "../altimate/tools/altimate-core-compare"
import { AltimateCoreCompleteTool } from "../altimate/tools/altimate-core-complete"
import { AltimateCoreOptimizeContextTool } from "../altimate/tools/altimate-core-optimize-context"
import { AltimateCorePruneSchemaTool } from "../altimate/tools/altimate-core-prune-schema"
import { AltimateCoreImportDdlTool } from "../altimate/tools/altimate-core-import-ddl"
import { AltimateCoreExportDdlTool } from "../altimate/tools/altimate-core-export-ddl"
import { AltimateCoreFingerprintTool } from "../altimate/tools/altimate-core-fingerprint"
import { AltimateCoreIntrospectionSqlTool } from "../altimate/tools/altimate-core-introspection-sql"
import { AltimateCoreParseDbtTool } from "../altimate/tools/altimate-core-parse-dbt"
import { AltimateCoreRewriteTool } from "../altimate/tools/altimate-core-rewrite"
import { ToolLookupTool } from "../altimate/tools/tool-lookup"
import { ProjectScanTool } from "../altimate/tools/project-scan"
import { DatamateManagerTool } from "../altimate/tools/datamate"
import { FeedbackSubmitTool } from "../altimate/tools/feedback-submit"
import { SampleSetupTool } from "../altimate/tools/sample-setup"
// altimate_change end

// altimate_change start - import altimate persistent memory tools
import { MemoryReadTool } from "../memory/tools/memory-read"
import { MemoryWriteTool } from "../memory/tools/memory-write"
import { MemoryDeleteTool } from "../memory/tools/memory-delete"
import { MemoryAuditTool } from "../memory/tools/memory-audit"
import { MemoryExtractTool } from "../memory/tools/memory-extract"
// altimate_change end
// altimate_change start - import training tools for AI teammate
import { TrainingSaveTool } from "../altimate/tools/training-save"
import { TrainingListTool } from "../altimate/tools/training-list"
import { TrainingRemoveTool } from "../altimate/tools/training-remove"
// altimate_change end
// altimate_change start - import impact analysis and training import tools
import { ImpactAnalysisTool } from "../altimate/tools/impact-analysis"
import { TrainingImportTool } from "../altimate/tools/training-import"
// altimate_change end
// altimate_change start - import dbt PR review tool
import { DbtPrReviewTool } from "../altimate/tools/dbt-pr-review"
// altimate_change end

export namespace ToolRegistry {
  const log = Log.create({ service: "tool.registry" })

  // altimate_change start — upstream_fix: allow the Effect Service facade to honor the
  // injected Config.Service instead of falling back to the global Config facade. The legacy
  // namespace functions still use the cached Instance.state path below.
  type RegistryConfigInfo = Awaited<ReturnType<typeof Config.get>>
  type RegistryConfigInput = { matches?: string[]; config?: RegistryConfigInfo }

  function scanCustomTools(dirs: string[]) {
    return dirs.flatMap((dir) =>
      Glob.scanSync("{tool,tools}/*.{js,ts}", { cwd: dir, absolute: true, dot: true, symlink: true }),
    )
  }

  async function loadCustomTools(matches: string[]) {
    const custom = [] as Tool.Info[]

    for (const match of matches) {
      const namespace = path.basename(match, path.extname(match))
      const mod = await import(pathToFileURL(match).href)
      for (const [id, def] of Object.entries<ToolDefinition>(mod)) {
        // altimate_change start — only register exports that are actual tool definitions
        // (object with an `execute` function). A custom tool file may also export helpers
        // and other named values that must not be registered as tools.
        if (typeof def !== "object" || def === null || typeof (def as ToolDefinition).execute !== "function") continue
        // altimate_change end
        custom.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def))
      }
    }

    // altimate_change start — `state` only caches the file-scanned custom tools. Plugin tools
    // are appended separately (see `pluginTools`) from the Plugin Effect Service so Effect
    // consumers that swap the Plugin.Service layer are honored, instead of always reading the
    // process-wide Plugin.list() facade.
    return { custom }
    // altimate_change end
  }

  export const state = Instance.state(async () => {
    const matches = scanCustomTools(await Config.directories())
    if (matches.length) await Config.waitForDependencies()
    return loadCustomTools(matches)
  })
  // altimate_change end

  // altimate_change start — v1.17.9 Tool API: init now returns an Effect of a legacy-shaped
  // def. We build the old plain-object def and bridge it to the new Effect API via
  // legacyToInit; output truncation is handled centrally by Tool.wrap, so we return raw output.
  // altimate_change start — build a zod object from a tool definition's `args`. Args may be a
  // ZodRawShape (modern plugin tools) or a legacy JSON-Schema-shaped map (`{ field: { type,
  // description, ... } }`). A bare JSON-Schema value is not a zod type, so it must be converted
  // before `z.object`, otherwise `z.toJSONSchema` crashes on `schema._zod`.
  function jsonSchemaFieldToZod(schema: Record<string, unknown>): z.ZodType {
    let base: z.ZodType
    switch (schema.type) {
      case "number":
      case "integer":
        base = z.number()
        break
      case "boolean":
        base = z.boolean()
        break
      case "array":
        base = z.array(z.unknown())
        break
      case "object":
        base = z.object({}).loose()
        break
      default:
        base = z.string()
    }
    if (typeof schema.description === "string") base = base.describe(schema.description)
    return base
  }

  function argsToZodShape(args: ToolDefinition["args"] | undefined): z.ZodRawShape {
    if (!args || typeof args !== "object") return {}
    return Object.fromEntries(
      Object.entries(args as Record<string, unknown>).map(([key, value]) => [
        key,
        isZodType(value) ? (value as z.ZodType) : jsonSchemaFieldToZod(value as Record<string, unknown>),
      ]),
    ) as z.ZodRawShape
  }
  // altimate_change end

  function fromPlugin(id: string, def: ToolDefinition): Tool.Info {
    return {
      id,
      // altimate_change start — user custom tools (file-scanned) and third-party plugin tools both
      // flow through here; mark them "external" so the tool-source badge stays neutral and never
      // over-claims them as Altimate-owned.
      registrySource: "external",
      // altimate_change end
      init: () =>
        legacyToInit({
          // altimate_change start — tolerate JSON-Schema-shaped legacy args (see argsToZodShape)
          parameters: z.object(argsToZodShape(def.args)),
          // altimate_change end
          description: def.description,
          execute: async (args, ctx) => {
            const pluginCtx = {
              ...ctx,
              directory: Instance.directory,
              worktree: Instance.worktree,
            } as unknown as PluginToolContext
            const result = await def.execute(args as any, pluginCtx)
            if (typeof result === "string") {
              return { title: "", output: result, metadata: {} }
            }
            return {
              title: result.title ?? "",
              output: result.output,
              metadata: result.metadata ?? {},
              ...(result.attachments ? { attachments: result.attachments as any } : {}),
            }
          },
        }),
    }
  }
  // altimate_change end

  export async function register(tool: Tool.Info) {
    const { custom } = await state()
    const idx = custom.findIndex((t) => t.id === tool.id)
    if (idx >= 0) {
      custom.splice(idx, 1, tool)
      return
    }
    custom.push(tool)
  }

  // altimate_change start — collect plugin-provided tools. Accepts an explicit plugin list so the
  // Effect Service can pass the (possibly layer-overridden) Plugin.Service result; imperative
  // callers fall back to the process-wide Plugin.list() facade.
  async function pluginTools(plugins?: Awaited<ReturnType<typeof Plugin.list>>): Promise<Tool.Info[]> {
    const list = plugins ?? (await Plugin.list())
    const result: Tool.Info[] = []
    for (const plugin of list) {
      for (const [id, def] of Object.entries(plugin.tool ?? {})) {
        result.push(fromPlugin(id, def))
      }
    }
    return result
  }
  // altimate_change end

  // altimate_change start — upstream_fix: hide task.background unless the runtime flag enables it.
  type ToolRuntimeFlags = Pick<
    RuntimeFlags.Info,
    "experimentalBackgroundSubagents" | "enableExa" | "enableParallel" | "experimentalCodeMode"
  >

  // altimate_change start — upstream port (v1.18.10 code mode): flag-gated lazy resolution of
  // the `execute` tool. Cached per process; the definition itself is agent-independent (the
  // per-call MCP catalog description is swapped in tools() below).
  // Structural type (not `typeof import`) — the module reference would close a type
  // cycle back through this file and collapse inference to `any`.
  type CodeModeModule = {
    describeCatalog: (mcpTools: Record<string, unknown>, servers: readonly string[]) => string
  }
  let codeModePromise: Promise<{ mod: CodeModeModule; tool: Tool.Info }> | undefined
  function loadCodeMode(): Promise<{ mod: CodeModeModule; tool: Tool.Info }> {
    codeModePromise ??= (async () => {
      const mod = await import("./code-mode")
      const tool = (await AppRuntime.runPromise(mod.CodeModeTool)) as Tool.Info
      return { mod: mod as unknown as CodeModeModule, tool }
    })()
    return codeModePromise
  }
  // altimate_change end

  function backgroundSubagentsEnabled(flags?: ToolRuntimeFlags) {
    if (flags) return flags.experimentalBackgroundSubagents
    const value = process.env["OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS"]
    if (value !== undefined) return ["1", "true", "yes"].includes(value.toLowerCase())
    return Flag.OPENCODE_EXPERIMENTAL
  }

  // altimate_change start — upstream port (v1.18.10 code mode): the LIVE legacy prompt
  // pipeline (SessionPrompt.resolveTools → namespace tools()) has no RuntimeFlags service,
  // so mirror the flag's env semantics (explicit env wins, OPENCODE_EXPERIMENTAL implies)
  // the same way backgroundSubagentsEnabled does — otherwise the feature flag is inert in
  // real sessions and `execute` never appears.
  function codeModeEnabled(flags?: ToolRuntimeFlags) {
    if (flags?.experimentalCodeMode !== undefined) return flags.experimentalCodeMode
    const value = process.env["OPENCODE_EXPERIMENTAL_CODE_MODE"]
    if (value !== undefined) return ["1", "true", "yes"].includes(value.toLowerCase())
    return Flag.OPENCODE_EXPERIMENTAL
  }
  // altimate_change end

  // altimate_change start — upstream_fix: allow Parallel-enabled websearch for non-opencode providers.
  function providerWebSearchEnabled(flags?: ToolRuntimeFlags) {
    if (flags) return flags.enableExa || flags.enableParallel
    const parallel =
      process.env["OPENCODE_ENABLE_PARALLEL"]?.toLowerCase() === "true" ||
      process.env["OPENCODE_ENABLE_PARALLEL"] === "1" ||
      process.env["OPENCODE_EXPERIMENTAL_PARALLEL"]?.toLowerCase() === "true" ||
      process.env["OPENCODE_EXPERIMENTAL_PARALLEL"] === "1"
    return Flag.OPENCODE_ENABLE_EXA || parallel
  }
  // altimate_change end

  function applyRuntimeToolSchemaFlags<T extends Tool.DefWithoutID>(id: string, tool: T, flags?: ToolRuntimeFlags): T {
    if (id !== "task" || backgroundSubagentsEnabled(flags)) return tool
    const schema = tool.jsonSchema
    if (!schema || typeof schema !== "object" || !schema.properties || typeof schema.properties !== "object") {
      return tool
    }

    const properties = { ...(schema.properties as Record<string, unknown>) }
    if (!("background" in properties)) return tool
    delete properties.background

    return {
      ...tool,
      jsonSchema: {
        ...schema,
        properties,
        ...(Array.isArray(schema.required)
          ? { required: schema.required.filter((field) => field !== "background") }
          : {}),
      },
    }
  }
  // altimate_change end

  // altimate_change start — upstream_fix: let Effect Service callers pass injected Config results
  // through to the registry instead of falling back to the global Config facade.
  async function all(
    plugins?: Awaited<ReturnType<typeof Plugin.list>>,
    configInput?: RegistryConfigInput,
    // altimate_change start — upstream port (v1.18.10 code mode)
    runtimeFlags?: ToolRuntimeFlags,
    // altimate_change end
  ): Promise<Tool.Info[]> {
    const custom = configInput?.matches
      ? await loadCustomTools(configInput.matches).then((x) => x.custom)
      : await state().then((x) => x.custom)
    // altimate_change start — append plugin tools (from the Effect Service or the facade)
    const pluginCustom = await pluginTools(plugins)
    // altimate_change end
    const config = configInput?.config ?? (await Config.get())
    // altimate_change end
    const question = ["app", "cli", "desktop"].includes(Flag.OPENCODE_CLIENT) || Flag.OPENCODE_ENABLE_QUESTION_TOOL

    // altimate_change start — v1.17.9: Tool.define returns an Effect<Tool.Info>; resolve the
    // built-in tool-definition effects against the AppRuntime layers (Truncate/Agent) before use.
    const builtins = [
      InvalidTool,
      ...(question ? [QuestionTool] : []),
      BashTool,
      ReadTool,
      GlobTool,
      GrepTool,
      EditTool,
      WriteTool,
      TaskTool,
      WebFetchTool,
      TodoWriteTool,
      // TodoReadTool,
      WebSearchTool,
      CodeSearchTool,
      SkillTool,
      ApplyPatchTool,
      ...(Flag.OPENCODE_EXPERIMENTAL_LSP_TOOL ? [LspTool] : []),
      // altimate_change start — see import marker; conditional on experimental.batch_tool
      ...(config.experimental?.batch_tool === true ? [BatchTool] : []),
      // altimate_change end
      ...(Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE && Flag.OPENCODE_CLIENT === "cli" ? [PlanExitTool] : []),
      // altimate_change start - register custom data engineering tools
      SqlExecuteTool,
      SchemaInspectTool,
      SqlAnalyzeTool,
      SqlOptimizeTool,
      SqlTranslateTool,
      LineageCheckTool,
      WarehouseListTool,
      WarehouseTestTool,
      WarehouseAddTool,
      WarehouseRemoveTool,
      WarehouseDiscoverTool,
      // altimate_change start - register MCP discovery tool
      McpDiscoverTool,
      // altimate_change end

      DbtManifestTool,
      // altimate_change start - register dbt unit test generation tool
      DbtUnitTestGenTool,
      // altimate_change end
      DbtProfilesTool,
      DbtLineageTool,
      SchemaIndexTool,
      SchemaSearchTool,
      SchemaCacheStatusTool,
      SqlExplainTool,
      SqlFormatTool,
      SqlFixTool,
      SqlAutocompleteTool,
      SqlDiffTool,
      // altimate_change start — data-parity tool
      DataDiffTool,
      // altimate_change end
      FinopsQueryHistoryTool,
      FinopsAnalyzeCreditsTool,
      FinopsExpensiveQueriesTool,
      FinopsWarehouseAdviceTool,
      FinopsUnusedResourcesTool,
      FinopsRoleGrantsTool,
      FinopsRoleHierarchyTool,
      FinopsUserRolesTool,
      SchemaDetectPiiTool,
      SchemaTagsTool,
      SchemaTagsListTool,
      SqlRewriteTool,
      AltimateCoreRewriteTool,
      SchemaDiffTool,
      AltimateCoreValidateTool,
      AltimateCoreCheckTool,
      AltimateCoreFixTool,
      AltimateCorePolicyTool,
      AltimateCoreSemanticsTool,
      AltimateCoreTestgenTool,
      AltimateCoreEquivalenceTool,
      AltimateCoreMigrationTool,
      AltimateCoreSchemaDiffTool,
      AltimateCoreCorrectTool,
      AltimateCoreGradeTool,
      AltimateCoreClassifyPiiTool,
      AltimateCoreQueryPiiTool,
      AltimateCoreResolveTermTool,
      AltimateCoreColumnLineageTool,
      AltimateCoreTrackLineageTool,
      AltimateCoreExtractMetadataTool,
      AltimateCoreCompareTool,
      AltimateCoreCompleteTool,
      AltimateCoreOptimizeContextTool,
      AltimateCorePruneSchemaTool,
      AltimateCoreImportDdlTool,
      AltimateCoreExportDdlTool,
      AltimateCoreFingerprintTool,
      AltimateCoreIntrospectionSqlTool,
      AltimateCoreParseDbtTool,
      ToolLookupTool,
      ProjectScanTool,
      DatamateManagerTool,
      FeedbackSubmitTool,
      SampleSetupTool,
      // altimate_change end
      // altimate_change start - register altimate persistent memory tools
      ...(!Flag.ALTIMATE_DISABLE_MEMORY
        ? [
            MemoryReadTool,
            MemoryWriteTool,
            MemoryDeleteTool,
            MemoryAuditTool,
            ...(Flag.ALTIMATE_MEMORY_AUTO_EXTRACT ? [MemoryExtractTool] : []),
          ]
        : []),
      // altimate_change end
      // altimate_change start - register training tools for AI teammate
      ...(!Flag.ALTIMATE_DISABLE_TRAINING
        ? [TrainingSaveTool, TrainingListTool, TrainingRemoveTool, TrainingImportTool]
        : []),
      // altimate_change end
      // altimate_change start - register impact analysis tool
      ImpactAnalysisTool,
      // altimate_change end
      // altimate_change start - register dbt PR review tool
      DbtPrReviewTool,
      // altimate_change end
    ]
    // altimate_change start — some builtin tool-definition effects yield services not in
    // AppLayer: websearch yields HttpClient (provide FetchHttpClient) and read yields
    // Scope (discharge with Effect.scoped) at definition time.
    const resolved = await AppRuntime.runPromise(
      Effect.scoped(Effect.all(builtins).pipe(Effect.provide(FetchHttpClient.layer))),
    )
    // altimate_change end
    // altimate_change end
    // altimate_change start — include plugin-provided custom tools
    // altimate_change start — upstream port (v1.18.10 code mode): expose `execute` when enabled
    const codeMode = codeModeEnabled(runtimeFlags) ? [(await loadCodeMode()).tool] : []
    return [...resolved, ...custom, ...pluginCustom, ...codeMode]
    // altimate_change end
    // altimate_change end
  }

  /** All tool infos without model/provider filtering. */
  // altimate_change start — upstream_fix: thread injected Config through helper entrypoints.
  export async function allInfos(
    plugins?: Awaited<ReturnType<typeof Plugin.list>>,
    configInput?: RegistryConfigInput,
    // altimate_change start — upstream port (v1.18.10 code mode)
    runtimeFlags?: ToolRuntimeFlags,
    // altimate_change end
  ): Promise<Tool.Info[]> {
    return all(plugins, configInput, runtimeFlags)
  }

  export async function ids(
    plugins?: Awaited<ReturnType<typeof Plugin.list>>,
    configInput?: RegistryConfigInput,
    // altimate_change start — upstream port (v1.18.10 code mode)
    runtimeFlags?: ToolRuntimeFlags,
    // altimate_change end
  ) {
    return all(plugins, configInput, runtimeFlags).then((x) => x.map((t) => t.id))
  }
  // altimate_change end

  // altimate_change start — upstream_fix: allow runtime flags and injected Config to shape tool definitions.
  export async function tools(
    model: {
      providerID: ProviderID
      modelID: ModelID
    },
    agent?: Agent.Info,
    plugins?: Awaited<ReturnType<typeof Plugin.list>>,
    runtimeFlags?: ToolRuntimeFlags,
    configInput?: RegistryConfigInput,
    // altimate_change start — upstream port (v1.18.10 code mode): catalog injected by the
    // Effect facade (honors mocked/replaced MCP layers); Promise-facade callers fall back
    // to the MCP namespace wrapper.
    mcpCatalog?: { tools: Record<string, unknown>; permission?: PermissionV1.Ruleset },
    // altimate_change end
  ) {
    const tools = await all(plugins, configInput, runtimeFlags)
    // altimate_change end
    // altimate_change start — upstream port (v1.18.10 code mode): swap in the per-call MCP
    // catalog description; drop `execute` entirely when the caller's permission ruleset leaves
    // no visible MCP tools (mirrors upstream's describeCodeMode gate).
    let codeModeDescription: string | undefined
    if (codeModeEnabled(runtimeFlags) && tools.some((t) => t.id === "execute")) {
      const { mod } = await loadCodeMode()
      // Session-level rules merge AFTER agent rules (session denials win) — mirrors the
      // runtime enforcement in session/tools.ts's ctx.ask ruleset.
      const ruleset = Permission.merge(agent?.permission ?? [], mcpCatalog?.permission ?? [])
      const catalog = mcpCatalog?.tools ?? ((await MCP.tools()) as Record<string, unknown>)
      const visible = Permission.visibleTools(catalog, ruleset)
      if (Object.keys(visible).length > 0) {
        // Fork MCP entries carry the original client name as `clientName` (`client` is the
        // MCP client OBJECT). Sanitize those so describeCatalog groups flattened keys exactly
        // like the runtime tool tree — otherwise underscore-containing server names split at
        // the wrong boundary and the advertised tools.<server>.<tool> paths don't exist.
        const servers = [
          ...new Set(
            Object.values(visible)
              .map((entry) => (entry as { clientName?: string }).clientName)
              .filter((name): name is string => typeof name === "string" && name.length > 0)
              .map(McpCatalog.sanitize),
          ),
        ]
        codeModeDescription = mod.describeCatalog(visible, servers)
      }
    }
    const toolList = tools.filter((t) => t.id !== "execute" || codeModeDescription !== undefined)
    // altimate_change end
    const result = await Promise.all(
      toolList
        .filter((t) => {
          // Enable websearch/codesearch for zen users OR via enable flag
          if (t.id === "codesearch" || t.id === "websearch") {
            // altimate_change start — upstream_fix: gate on Exa OR Parallel runtime flags.
            return model.providerID === ProviderID.opencode || providerWebSearchEnabled(runtimeFlags)
            // altimate_change end
          }

          // use apply tool in same format as codex
          const usePatch =
            model.modelID.includes("gpt-") && !model.modelID.includes("oss") && !model.modelID.includes("gpt-4")
          if (t.id === "apply_patch") return usePatch
          if (t.id === "edit" || t.id === "write") return !usePatch

          return true
        })
        .map(async (t) => {
          using _ = log.time(t.id)
          // altimate_change start — v1.17.9: Tool.Info.init() returns an Effect of DefWithoutID
          // altimate_change start — upstream_fix: pass caller agent through deferred tool init.
          const tool = await Effect.runPromise(t.init({ agent }))
          // altimate_change end
          // altimate_change end
          const output = {
            // altimate_change start — upstream port (v1.18.10 code mode): per-call MCP catalog description
            description: t.id === "execute" && codeModeDescription ? codeModeDescription : tool.description,
            // altimate_change end
            parameters: tool.parameters,
          }
          await Plugin.trigger("tool.definition", { toolID: t.id }, output)
          return {
            id: t.id,
            // altimate_change start — carry declared origin to the resolvers' source-badge stamping.
            registrySource: t.registrySource,
            // altimate_change end
            // altimate_change start — upstream_fix: hide disabled runtime-gated tool schema fields.
            ...applyRuntimeToolSchemaFlags(t.id, tool, runtimeFlags),
            // altimate_change end
            description: output.description,
            parameters: output.parameters,
          }
        }),
    )
    return result
  }

  // altimate_change start — Effect Context.Service facade (see import marker). The fork keeps the
  // async namespace functions above as the source of truth; this Service delegates to them so the
  // upstream Effect consumers (session/tools, experimental httpapi, debug agent, app-runtime,
  // server node wiring) compile without changing imperative callers.
  export interface Interface {
    readonly ids: () => Effect.Effect<string[]>
    readonly allInfos: () => Effect.Effect<Tool.Info[]>
    readonly register: (tool: Tool.Info) => Effect.Effect<void>
    readonly tools: (model: {
      providerID: ProviderID
      modelID: ModelID
      agent?: Agent.Info
      // altimate_change — upstream port (v1.18.10 code mode): session-level ruleset merged
      // into the code-mode visibility gate (denied MCP tools stay out of execute's description)
      permission?: PermissionV1.Ruleset
    }) => Effect.Effect<Awaited<ReturnType<typeof tools>>>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/ToolRegistry") {}

  // altimate_change start — the async namespace functions read Instance.directory from
  // AsyncLocalStorage. Effect consumers provide the instance via InstanceRef (the Effect
  // reference), not the ALS — e.g. tool-registry tests using store.provide(). Restore the
  // ALS from InstanceRef before invoking the async fn so `Instance.state` resolves.
  const bridge = <T>(fn: () => Promise<T>): Effect.Effect<T> =>
    Effect.gen(function* () {
      const instance = yield* InstanceRef
      return yield* Effect.promise(() => (instance ? Instance.restore(instance, fn) : fn()))
    })
  // altimate_change end

  export const layer = Layer.effect(
    Service,
    // altimate_change start — capture the Plugin Effect Service at build time so a swapped
    // Plugin.Service layer (e.g. tests) is honored. The plugin list resolved here is passed to
    // the async namespace functions instead of the process-wide Plugin.list() facade.
    Effect.gen(function* () {
      const pluginSvc = yield* Effect.serviceOption(Plugin.Service)
      const runtimeFlags = yield* Effect.serviceOption(RuntimeFlags.Service)
      const configSvc = yield* Effect.serviceOption(Config.Service)
      // altimate_change start — upstream port (v1.18.10 code mode): injected MCP catalog for
      // the execute-tool description (must use the graph's MCP.Service, not the Promise facade,
      // so replaced/mocked layers are honored)
      const mcpSvc = yield* Effect.serviceOption(MCP.Service)
      // altimate_change end
      const resolvePlugins = (): Effect.Effect<Awaited<ReturnType<typeof Plugin.list>> | undefined> =>
        Option.isSome(pluginSvc) ? pluginSvc.value.list() : Effect.succeed(undefined)
      const resolveConfigInput = (): Effect.Effect<RegistryConfigInput | undefined> =>
        Option.isSome(configSvc)
          ? Effect.gen(function* () {
              const dirs = yield* configSvc.value.directories()
              const matches = scanCustomTools(dirs)
              if (matches.length) yield* configSvc.value.waitForDependencies()
              const config = yield* configSvc.value.get()
              return { matches, config }
            })
          : Effect.succeed(undefined)
      const bridgeWithPlugins = <T>(
        fn: (plugins?: Awaited<ReturnType<typeof Plugin.list>>, configInput?: RegistryConfigInput) => Promise<T>,
      ): Effect.Effect<T> =>
        Effect.gen(function* () {
          const plugins = yield* resolvePlugins()
          const configInput = yield* resolveConfigInput()
          return yield* bridge(() => fn(plugins, configInput))
        })
      return Service.of({
        // altimate_change start — upstream port (v1.18.10 code mode): thread flags into ids/allInfos
        ids: () =>
          bridgeWithPlugins((plugins, configInput) => ids(plugins, configInput, Option.getOrUndefined(runtimeFlags))),
        allInfos: () =>
          bridgeWithPlugins((plugins, configInput) =>
            allInfos(plugins, configInput, Option.getOrUndefined(runtimeFlags)),
          ),
        // altimate_change end
        register: (tool) => bridge(() => register(tool)),
        tools: (model) =>
          Effect.gen(function* () {
            // altimate_change start — upstream port (v1.18.10 code mode): resolve the MCP
            // catalog through the injected service before crossing the Promise bridge
            const flags = Option.getOrUndefined(runtimeFlags)
            const mcpCatalog =
              flags?.experimentalCodeMode && Option.isSome(mcpSvc)
                ? {
                    tools: (yield* mcpSvc.value.tools()) as Record<string, unknown>,
                    permission: model.permission,
                  }
                : undefined
            // altimate_change end
            return yield* bridgeWithPlugins((plugins, configInput) =>
              tools(
                { providerID: model.providerID, modelID: model.modelID },
                model.agent,
                plugins,
                flags,
                configInput,
                // altimate_change — upstream port (v1.18.10 code mode)
                mcpCatalog,
              ),
            )
          }),
      })
    }),
    // altimate_change end
  )

  export const defaultLayer = layer

  // altimate_change start — declare Plugin.node so swapped Plugin.Service layers reach this layer;
  // lazy deps: Plugin/Config are cyclic fork facades
  export const node = LayerNode.make({
    name: "opencode/tool-registry",
    layer: layer,
    deps: LayerNode.lazy(() => [Plugin.node, RuntimeFlags.node, Config.node, MCP.node]),
  })
  // altimate_change end
  // altimate_change end — closes the Effect Context.Service facade block
}
