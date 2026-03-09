import { PlanExitTool } from "./plan"
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
import { type ToolContext as PluginToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import z from "zod"
import { Plugin } from "../plugin"
import { WebSearchTool } from "./websearch"
import { CodeSearchTool } from "./codesearch"
import { Flag } from "@/flag/flag"
import { Log } from "@/util/log"
import { LspTool } from "./lsp"
import { Truncate } from "./truncation"

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
import { DbtRunTool } from "../altimate/tools/dbt-run"
import { DbtManifestTool } from "../altimate/tools/dbt-manifest"
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
import { FinopsQueryHistoryTool } from "../altimate/tools/finops-query-history"
import { FinopsAnalyzeCreditsTool } from "../altimate/tools/finops-analyze-credits"
import { FinopsExpensiveQueriesTool } from "../altimate/tools/finops-expensive-queries"
import { FinopsWarehouseAdviceTool } from "../altimate/tools/finops-warehouse-advice"
import { FinopsUnusedResourcesTool } from "../altimate/tools/finops-unused-resources"
import { FinopsRoleGrantsTool, FinopsRoleHierarchyTool, FinopsUserRolesTool } from "../altimate/tools/finops-role-access"
import { SchemaDetectPiiTool } from "../altimate/tools/schema-detect-pii"
import { SchemaTagsTool, SchemaTagsListTool } from "../altimate/tools/schema-tags"
import { SqlRewriteTool } from "../altimate/tools/sql-rewrite"
import { SchemaDiffTool } from "../altimate/tools/schema-diff"
import { AltimateCoreValidateTool } from "../altimate/tools/altimate-core-validate"
import { AltimateCoreLintTool } from "../altimate/tools/altimate-core-lint"
import { AltimateCoreSafetyTool } from "../altimate/tools/altimate-core-safety"
import { AltimateCoreTranspileTool } from "../altimate/tools/altimate-core-transpile"
import { AltimateCoreCheckTool } from "../altimate/tools/altimate-core-check"
import { AltimateCoreFixTool } from "../altimate/tools/altimate-core-fix"
import { AltimateCorePolicyTool } from "../altimate/tools/altimate-core-policy"
import { AltimateCoreSemanticsTool } from "../altimate/tools/altimate-core-semantics"
import { AltimateCoreTestgenTool } from "../altimate/tools/altimate-core-testgen"
import { AltimateCoreEquivalenceTool } from "../altimate/tools/altimate-core-equivalence"
import { AltimateCoreMigrationTool } from "../altimate/tools/altimate-core-migration"
import { AltimateCoreSchemaDiffTool } from "../altimate/tools/altimate-core-schema-diff"
import { AltimateCoreRewriteTool } from "../altimate/tools/altimate-core-rewrite"
import { AltimateCoreCorrectTool } from "../altimate/tools/altimate-core-correct"
import { AltimateCoreGradeTool } from "../altimate/tools/altimate-core-grade"
import { AltimateCoreClassifyPiiTool } from "../altimate/tools/altimate-core-classify-pii"
import { AltimateCoreQueryPiiTool } from "../altimate/tools/altimate-core-query-pii"
import { AltimateCoreResolveTermTool } from "../altimate/tools/altimate-core-resolve-term"
import { AltimateCoreColumnLineageTool } from "../altimate/tools/altimate-core-column-lineage"
import { AltimateCoreTrackLineageTool } from "../altimate/tools/altimate-core-track-lineage"
import { AltimateCoreFormatTool } from "../altimate/tools/altimate-core-format"
import { AltimateCoreExtractMetadataTool } from "../altimate/tools/altimate-core-extract-metadata"
import { AltimateCoreCompareTool } from "../altimate/tools/altimate-core-compare"
import { AltimateCoreCompleteTool } from "../altimate/tools/altimate-core-complete"
import { AltimateCoreOptimizeContextTool } from "../altimate/tools/altimate-core-optimize-context"
import { AltimateCoreOptimizeForQueryTool } from "../altimate/tools/altimate-core-optimize-for-query"
import { AltimateCorePruneSchemaTool } from "../altimate/tools/altimate-core-prune-schema"
import { AltimateCoreImportDdlTool } from "../altimate/tools/altimate-core-import-ddl"
import { AltimateCoreExportDdlTool } from "../altimate/tools/altimate-core-export-ddl"
import { AltimateCoreFingerprintTool } from "../altimate/tools/altimate-core-fingerprint"
import { AltimateCoreIntrospectionSqlTool } from "../altimate/tools/altimate-core-introspection-sql"
import { AltimateCoreParseDbtTool } from "../altimate/tools/altimate-core-parse-dbt"
import { AltimateCoreIsSafeTool } from "../altimate/tools/altimate-core-is-safe"
import { ProjectScanTool } from "../altimate/tools/project-scan"
// altimate_change end

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
      const mod = await import(pathToFileURL(match).href)
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
    const question = ["app", "cli", "desktop"].includes(Flag.OPENCODE_CLIENT) || Flag.OPENCODE_ENABLE_QUESTION_TOOL

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
      // TodoReadTool,
      WebSearchTool,
      CodeSearchTool,
      SkillTool,
      ApplyPatchTool,
      ...(Flag.OPENCODE_EXPERIMENTAL_LSP_TOOL ? [LspTool] : []),
      ...(config.experimental?.batch_tool === true ? [BatchTool] : []),
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
      AltimateCoreFixTool,
      AltimateCorePolicyTool,
      AltimateCoreSemanticsTool,
      AltimateCoreTestgenTool,
      AltimateCoreEquivalenceTool,
      AltimateCoreMigrationTool,
      AltimateCoreSchemaDiffTool,
      AltimateCoreRewriteTool,
      AltimateCoreCorrectTool,
      AltimateCoreGradeTool,
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
      // altimate_change end
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
          // Enable websearch/codesearch for zen users OR via enable flag
          if (t.id === "codesearch" || t.id === "websearch") {
            return model.providerID === "opencode" || Flag.OPENCODE_ENABLE_EXA
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
