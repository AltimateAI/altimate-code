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
import { SqlRecordFeedbackTool } from "./sql-record-feedback"
import { SqlPredictCostTool } from "./sql-predict-cost"
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
import { CiCostGateTool } from "./ci-cost-gate"
import { SchemaDiffTool } from "./schema-diff"
import { SqlGuardValidateTool } from "./sqlguard-validate"
import { SqlGuardLintTool } from "./sqlguard-lint"
import { SqlGuardSafetyTool } from "./sqlguard-safety"
import { SqlGuardTranspileTool } from "./sqlguard-transpile"
import { SqlGuardCheckTool } from "./sqlguard-check"
// Phase 1 (P0)
import { SqlGuardFixTool } from "./sqlguard-fix"
import { SqlGuardPolicyTool } from "./sqlguard-policy"
import { SqlGuardComplexityTool } from "./sqlguard-complexity"
import { SqlGuardSemanticsTool } from "./sqlguard-semantics"
import { SqlGuardTestgenTool } from "./sqlguard-testgen"
// Phase 2 (P1)
import { SqlGuardEquivalenceTool } from "./sqlguard-equivalence"
import { SqlGuardMigrationTool } from "./sqlguard-migration"
import { SqlGuardSchemaDiffTool } from "./sqlguard-schema-diff"
import { SqlGuardRewriteTool } from "./sqlguard-rewrite"
import { SqlGuardCorrectTool } from "./sqlguard-correct"
import { SqlGuardGradeTool } from "./sqlguard-grade"
import { SqlGuardCostTool } from "./sqlguard-cost"
// Phase 3 (P2)
import { SqlGuardClassifyPiiTool } from "./sqlguard-classify-pii"
import { SqlGuardQueryPiiTool } from "./sqlguard-query-pii"
import { SqlGuardResolveTermTool } from "./sqlguard-resolve-term"
import { SqlGuardColumnLineageTool } from "./sqlguard-column-lineage"
import { SqlGuardTrackLineageTool } from "./sqlguard-track-lineage"
import { SqlGuardFormatTool } from "./sqlguard-format"
import { SqlGuardExtractMetadataTool } from "./sqlguard-extract-metadata"
import { SqlGuardCompareTool } from "./sqlguard-compare"
import { SqlGuardCompleteTool } from "./sqlguard-complete"
import { SqlGuardOptimizeContextTool } from "./sqlguard-optimize-context"
import { SqlGuardOptimizeForQueryTool } from "./sqlguard-optimize-for-query"
import { SqlGuardPruneSchemaTool } from "./sqlguard-prune-schema"
import { SqlGuardImportDdlTool } from "./sqlguard-import-ddl"
import { SqlGuardExportDdlTool } from "./sqlguard-export-ddl"
import { SqlGuardFingerprintTool } from "./sqlguard-fingerprint"
import { SqlGuardIntrospectionSqlTool } from "./sqlguard-introspection-sql"
import { SqlGuardParseDbtTool } from "./sqlguard-parse-dbt"
import { SqlGuardIsSafeTool } from "./sqlguard-is-safe"
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
      SqlRecordFeedbackTool,
      SqlPredictCostTool,
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
      CiCostGateTool,
      SchemaDiffTool,
      SqlGuardValidateTool,
      SqlGuardLintTool,
      SqlGuardSafetyTool,
      SqlGuardTranspileTool,
      SqlGuardCheckTool,
      // Phase 1 (P0)
      SqlGuardFixTool,
      SqlGuardPolicyTool,
      SqlGuardComplexityTool,
      SqlGuardSemanticsTool,
      SqlGuardTestgenTool,
      // Phase 2 (P1)
      SqlGuardEquivalenceTool,
      SqlGuardMigrationTool,
      SqlGuardSchemaDiffTool,
      SqlGuardRewriteTool,
      SqlGuardCorrectTool,
      SqlGuardGradeTool,
      SqlGuardCostTool,
      // Phase 3 (P2)
      SqlGuardClassifyPiiTool,
      SqlGuardQueryPiiTool,
      SqlGuardResolveTermTool,
      SqlGuardColumnLineageTool,
      SqlGuardTrackLineageTool,
      SqlGuardFormatTool,
      SqlGuardExtractMetadataTool,
      SqlGuardCompareTool,
      SqlGuardCompleteTool,
      SqlGuardOptimizeContextTool,
      SqlGuardOptimizeForQueryTool,
      SqlGuardPruneSchemaTool,
      SqlGuardImportDdlTool,
      SqlGuardExportDdlTool,
      SqlGuardFingerprintTool,
      SqlGuardIntrospectionSqlTool,
      SqlGuardParseDbtTool,
      SqlGuardIsSafeTool,
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
