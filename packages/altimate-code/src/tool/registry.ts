import { QuestionTool } from "./question"
import { BashTool } from "./bash"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { BatchTool } from "./batch"
import { ReadTool } from "./read"
import { TaskTool } from "./task"
import { TodoWriteTool, TodoReadTool } from "./todo"
import { WebFetchTool } from "./webfetch"
import { WriteTool } from "./write"
import { InvalidTool } from "./invalid"
import { SkillTool } from "./skill"
import type { Agent } from "../agent/agent"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { Config } from "../config/config"
import path from "path"
import { type ToolContext as PluginToolContext, type ToolDefinition } from "@altimateai/altimate-code-plugin"
import z from "zod"
import { Plugin } from "../plugin"
import { Flag } from "@/flag/flag"
import { Log } from "@/util/log"
import { Truncate } from "./truncation"
import { PlanExitTool, PlanEnterTool } from "./plan"
import { ApplyPatchTool } from "./apply_patch"
import { SqlExecuteTool } from "./sql-execute"
import { SchemaInspectTool } from "./schema-inspect"
import { SqlAnalyzeTool } from "./sql-analyze"
import { SqlOptimizeTool } from "./sql-optimize"
import { SqlTranslateTool } from "./sql-translate"
import { LineageCheckTool } from "./lineage-check"
import { WarehouseListTool } from "./warehouse-list"
import { WarehouseTestTool } from "./warehouse-test"
import { WarehouseAddTool } from "./warehouse-add"
import { WarehouseRemoveTool } from "./warehouse-remove"
import { WarehouseDiscoverTool } from "./warehouse-discover"
import { DbtRunTool } from "./dbt-run"
import { DbtManifestTool } from "./dbt-manifest"
import { DbtProfilesTool } from "./dbt-profiles"
import { DbtLineageTool } from "./dbt-lineage"
import { SchemaIndexTool } from "./schema-index"
import { SchemaSearchTool } from "./schema-search"
import { SchemaCacheStatusTool } from "./schema-cache-status"
import { SqlExplainTool } from "./sql-explain"
import { SqlFormatTool } from "./sql-format"
import { SqlFixTool } from "./sql-fix"
import { SqlAutocompleteTool } from "./sql-autocomplete"
import { SqlDiffTool } from "./sql-diff"
import { FinopsQueryHistoryTool } from "./finops-query-history"
import { FinopsAnalyzeCreditsTool } from "./finops-analyze-credits"
import { FinopsExpensiveQueriesTool } from "./finops-expensive-queries"
import { FinopsWarehouseAdviceTool } from "./finops-warehouse-advice"
import { FinopsUnusedResourcesTool } from "./finops-unused-resources"
import { FinopsRoleGrantsTool, FinopsRoleHierarchyTool, FinopsUserRolesTool } from "./finops-role-access"
import { SchemaDetectPiiTool } from "./schema-detect-pii"
import { SchemaTagsTool, SchemaTagsListTool } from "./schema-tags"
import { SqlRewriteTool } from "./sql-rewrite"

import { SchemaDiffTool } from "./schema-diff"
import { AltimateCoreValidateTool } from "./altimate-core-validate"
import { AltimateCoreLintTool } from "./altimate-core-lint"
import { AltimateCoreSafetyTool } from "./altimate-core-safety"
import { AltimateCoreTranspileTool } from "./altimate-core-transpile"
import { AltimateCoreCheckTool } from "./altimate-core-check"
// Phase 1 (P0)
import { AltimateCoreFixTool } from "./altimate-core-fix"
import { AltimateCorePolicyTool } from "./altimate-core-policy"

import { AltimateCoreSemanticsTool } from "./altimate-core-semantics"
import { AltimateCoreTestgenTool } from "./altimate-core-testgen"
// Phase 2 (P1)
import { AltimateCoreEquivalenceTool } from "./altimate-core-equivalence"
import { AltimateCoreMigrationTool } from "./altimate-core-migration"
import { AltimateCoreSchemaDiffTool } from "./altimate-core-schema-diff"
import { AltimateCoreRewriteTool } from "./altimate-core-rewrite"
import { AltimateCoreCorrectTool } from "./altimate-core-correct"
import { AltimateCoreGradeTool } from "./altimate-core-grade"

// Phase 3 (P2)
import { AltimateCoreClassifyPiiTool } from "./altimate-core-classify-pii"
import { AltimateCoreQueryPiiTool } from "./altimate-core-query-pii"
import { AltimateCoreResolveTermTool } from "./altimate-core-resolve-term"
import { AltimateCoreColumnLineageTool } from "./altimate-core-column-lineage"
import { AltimateCoreTrackLineageTool } from "./altimate-core-track-lineage"
import { AltimateCoreFormatTool } from "./altimate-core-format"
import { AltimateCoreExtractMetadataTool } from "./altimate-core-extract-metadata"
import { AltimateCoreCompareTool } from "./altimate-core-compare"
import { AltimateCoreCompleteTool } from "./altimate-core-complete"
import { AltimateCoreOptimizeContextTool } from "./altimate-core-optimize-context"
import { AltimateCoreOptimizeForQueryTool } from "./altimate-core-optimize-for-query"
import { AltimateCorePruneSchemaTool } from "./altimate-core-prune-schema"
import { AltimateCoreImportDdlTool } from "./altimate-core-import-ddl"
import { AltimateCoreExportDdlTool } from "./altimate-core-export-ddl"
import { AltimateCoreFingerprintTool } from "./altimate-core-fingerprint"
import { AltimateCoreIntrospectionSqlTool } from "./altimate-core-introspection-sql"
import { AltimateCoreParseDbtTool } from "./altimate-core-parse-dbt"
import { AltimateCoreIsSafeTool } from "./altimate-core-is-safe"
import { ProjectScanTool } from "./project-scan"
import { Glob } from "../util/glob"

export namespace ToolRegistry {
  const log = Log.create({ service: "tool.registry" })

  export const state = Instance.state(async () => {
    const custom = [] as Tool.Info[]

    const matches = await Config.directories().then((dirs) =>
      dirs.flatMap((dir) =>
        Glob.scanSync("{tool,tools}/*.{js,ts}", { cwd: dir, absolute: true, dot: true, symlink: true }),
      ),
    )
    if (matches.length) await Config.waitForDependencies()
    for (const match of matches) {
      const namespace = path.basename(match, path.extname(match))
      const mod = await import(match)
      for (const [id, def] of Object.entries<ToolDefinition>(mod)) {
        custom.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def))
      }
    }

    const plugins = await Plugin.list()
    for (const plugin of plugins) {
      for (const [id, def] of Object.entries(plugin.tool ?? {})) {
        custom.push(fromPlugin(id, def))
      }
    }

    return { custom }
  })

  function fromPlugin(id: string, def: ToolDefinition): Tool.Info {
    return {
      id,
      init: async (initCtx) => ({
        parameters: z.object(def.args),
        description: def.description,
        execute: async (args, ctx) => {
          const pluginCtx = {
            ...ctx,
            directory: Instance.directory,
            worktree: Instance.worktree,
          } as unknown as PluginToolContext
          const result = await def.execute(args as any, pluginCtx)
          const out = await Truncate.output(result, {}, initCtx?.agent)
          return {
            title: "",
            output: out.truncated ? out.content : result,
            metadata: { truncated: out.truncated, outputPath: out.truncated ? out.outputPath : undefined },
          }
        },
      }),
    }
  }

  export async function register(tool: Tool.Info) {
    const { custom } = await state()
    const idx = custom.findIndex((t) => t.id === tool.id)
    if (idx >= 0) {
      custom.splice(idx, 1, tool)
      return
    }
    custom.push(tool)
  }

  async function all(): Promise<Tool.Info[]> {
    const custom = await state().then((x) => x.custom)
    const config = await Config.get()
    const question = ["app", "cli", "desktop"].includes(Flag.ALTIMATE_CLI_CLIENT) || Flag.ALTIMATE_CLI_ENABLE_QUESTION_TOOL

    return [
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
      SkillTool,
      ApplyPatchTool,
      ...(config.experimental?.batch_tool === true ? [BatchTool] : []),
      ...(Flag.ALTIMATE_CLI_EXPERIMENTAL_PLAN_MODE && Flag.ALTIMATE_CLI_CLIENT === "cli" ? [PlanExitTool, PlanEnterTool] : []),
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
      DbtRunTool,
      DbtManifestTool,
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
      SchemaDiffTool,
      AltimateCoreValidateTool,
      AltimateCoreLintTool,
      AltimateCoreSafetyTool,
      AltimateCoreTranspileTool,
      AltimateCoreCheckTool,
      // Phase 1 (P0)
      AltimateCoreFixTool,
      AltimateCorePolicyTool,
      AltimateCoreSemanticsTool,
      AltimateCoreTestgenTool,
      // Phase 2 (P1)
      AltimateCoreEquivalenceTool,
      AltimateCoreMigrationTool,
      AltimateCoreSchemaDiffTool,
      AltimateCoreRewriteTool,
      AltimateCoreCorrectTool,
      AltimateCoreGradeTool,
      // Phase 3 (P2)
      AltimateCoreClassifyPiiTool,
      AltimateCoreQueryPiiTool,
      AltimateCoreResolveTermTool,
      AltimateCoreColumnLineageTool,
      AltimateCoreTrackLineageTool,
      AltimateCoreFormatTool,
      AltimateCoreExtractMetadataTool,
      AltimateCoreCompareTool,
      AltimateCoreCompleteTool,
      AltimateCoreOptimizeContextTool,
      AltimateCoreOptimizeForQueryTool,
      AltimateCorePruneSchemaTool,
      AltimateCoreImportDdlTool,
      AltimateCoreExportDdlTool,
      AltimateCoreFingerprintTool,
      AltimateCoreIntrospectionSqlTool,
      AltimateCoreParseDbtTool,
      AltimateCoreIsSafeTool,
      ProjectScanTool,
      ...custom,
    ]
  }

  export async function ids() {
    return all().then((x) => x.map((t) => t.id))
  }

  export async function tools(
    model: {
      providerID: string
      modelID: string
    },
    agent?: Agent.Info,
  ) {
    const tools = await all()
    const result = await Promise.all(
      tools
        .filter((t) => {
          // use apply tool in same format as codex
          const usePatch =
            model.modelID.includes("gpt-") && !model.modelID.includes("oss") && !model.modelID.includes("gpt-4")
          if (t.id === "apply_patch") return usePatch
          if (t.id === "edit" || t.id === "write") return !usePatch

          return true
        })
        .map(async (t) => {
          using _ = log.time(t.id)
          const tool = await t.init({ agent })
          const output = {
            description: tool.description,
            parameters: tool.parameters,
          }
          await Plugin.trigger("tool.definition", { toolID: t.id }, output)
          return {
            id: t.id,
            ...tool,
            description: output.description,
            parameters: output.parameters,
          }
        }),
    )
    return result
  }
}
