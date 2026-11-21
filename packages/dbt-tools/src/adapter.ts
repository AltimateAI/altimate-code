import type { Config } from "./config"
import { bufferLog } from "./log-buffer"
import { recordManifest } from "./stale-manifest"
import { retryParseManifest } from "./manifest-retry"
import { dbtDepsInstaller, ensurePackages, PackageLockTimeoutError, trackedExplicitInstaller } from "./packages"
export { getRecentDbtLogs, clearDbtLogs } from "./log-buffer"
import {
  DBTProjectIntegrationAdapter,
  DBTProjectIntegrationAdapterEvents,
  DEFAULT_CONFIGURATION_VALUES,
  DBTCommandFactory,
  DBTCommandExecutionInfrastructure,
  PythonDBTCommandExecutionStrategy,
  CLIDBTCommandExecutionStrategy,
  ChildrenParentParser,
  NodeParser,
  MacroParser,
  MetricParser,
  GraphParser,
  SourceParser,
  TestParser,
  UnitTestParser,
  SemanticModelParser,
  ExposureParser,
  FunctionParser,
  DocParser,
  ModelDepthParser,
  AltimateHttpClient,
  DbtIntegrationClient,
  DBTCoreProjectIntegration,
  DBTCloudProjectIntegration,
  DBTCoreCommandProjectIntegration,
  DBTFusionCommandProjectIntegration,
  CommandProcessExecutionFactory,
  DbtCloudVariantDetector,
} from "@altimateai/dbt-integration"
import type {
  DBTConfiguration,
  DBTTerminal,
  DBTProjectIntegration,
  DBTDiagnosticData,
  DeferConfig,
  RuntimePythonEnvironment,
} from "@altimateai/dbt-integration"

function configuration(cfg: Config): DBTConfiguration {
  return {
    getDbtCustomRunnerImport: () => DEFAULT_CONFIGURATION_VALUES.dbtCustomRunnerImport,
    getDbtIntegration: () => cfg.dbtIntegration ?? DEFAULT_CONFIGURATION_VALUES.dbtIntegration,
    getRunModelCommandAdditionalParams: () => DEFAULT_CONFIGURATION_VALUES.runModelCommandAdditionalParams,
    getBuildModelCommandAdditionalParams: () => DEFAULT_CONFIGURATION_VALUES.buildModelCommandAdditionalParams,
    getTestModelCommandAdditionalParams: () => DEFAULT_CONFIGURATION_VALUES.testModelCommandAdditionalParams,
    getQueryTemplate: () => DEFAULT_CONFIGURATION_VALUES.queryTemplate,
    getQueryLimit: () => cfg.queryLimit ?? DEFAULT_CONFIGURATION_VALUES.queryLimit,
    getEnableNotebooks: () => DEFAULT_CONFIGURATION_VALUES.enableNotebooks,
    getDisableQueryHistory: () => DEFAULT_CONFIGURATION_VALUES.disableQueryHistory,
    // altimate-dbt installs packages itself (packages.ts: only when missing or out of date,
    // under a cross-process lock). The library's own install runs `dbt deps` unconditionally
    // from every process, and concurrent runs corrupt dbt_packages.
    getInstallDepsOnProjectInitialization: () => false,
    getDisableDepthsCalculation: () => true,
    getWorkingDirectory: () => cfg.projectRoot,
    getAltimateUrl: () => "",
    getIsLocalMode: () => true,
    getAltimateInstanceName: () => undefined,
    getAltimateAiKey: () => undefined,
  }
}

function terminal(): DBTTerminal {
  return {
    show: async () => {},
    log: (msg: string) => bufferLog(`[dbt] ${msg}`),
    trace: () => {},
    // A crash at bridge startup is told only on the bridge's stderr, which the library logs here.
    debug: (name: string, msg: string) => {
      if (name === "PythonBridgeStderr") bufferLog(`[dbt:stderr] ${msg}`)
    },
    info: (_name: string, msg: string) => bufferLog(`[dbt] ${msg}`),
    warn: (_name: string, msg: string) => bufferLog(`[dbt:warn] ${msg}`),
    error: (_name: string, msg: string, e: unknown) => {
      const err = e instanceof Error ? e.message : String(e)
      bufferLog(`[dbt:error] ${msg} ${err}`)
    },
    dispose: () => {},
  }
}

/** What `create` needs besides the saved config. */
export type CreateOptions = {
  /**
   * The folder dbt writes its artifacts to (manifest.json, partial_parse.msgpack, run_results.json) for
   * every command this adapter runs, given to dbt as DBT_TARGET_PATH. Unset, dbt writes to the project's
   * own target-path, which is what a command run for the user should do. A caller that parses and
   * compiles for its own reading passes a folder of its own: dbt rewrites manifest.json on every
   * command, with compiled SQL only for what that command compiled, so writing to the project's target
   * would take the compiled SQL of every other model away from whoever reads that manifest.
   */
  targetPath?: string
  onPackagesInstalled?: () => void
}

function env(cfg: Config, options: CreateOptions): RuntimePythonEnvironment {
  const vars = { ...process.env }
  if (options.targetPath) vars.DBT_TARGET_PATH = options.targetPath
  return {
    pythonPath: cfg.pythonPath,
    getEnvironmentVariables: () => vars,
  }
}

/**
 * Whether this dbt-integration answers a model's lineage, for a caller deciding whether to `create`.
 * Pass the adapter once one has started: a method defined as an instance field isn't on the prototype.
 */
export function hasModelLineage(adapter?: DBTProjectIntegrationAdapter): boolean {
  const target = (adapter ?? DBTProjectIntegrationAdapter.prototype) as { getModelLineage?: unknown }
  return typeof target.getModelLineage === "function"
}

export async function create(cfg: Config, options: CreateOptions = {}): Promise<DBTProjectIntegrationAdapter> {
  const config = configuration(cfg)
  const term = terminal()
  const factory = new DBTCommandFactory(config)

  const http = new AltimateHttpClient(term, config)
  const client = new DbtIntegrationClient(http, term)

  const runtime = env(cfg, options)
  const provider = {
    getCurrentEnvironment: () => runtime,
    onEnvironmentChanged: () => () => {},
  }
  const exec = new CommandProcessExecutionFactory(term)
  const createExecution = exec.createCommandProcessExecution.bind(exec)
  exec.createCommandProcessExecution = (options) => {
    const execution = createExecution(options)
    const install = trackedExplicitInstaller(options)
    if (install) {
      execution.complete = () => install()
      execution.completeWithTerminalOutput = () => install((text) => {
        const formatted = execution.formatText(text)
        term.log(formatted)
        return formatted
      })
    }
    return execution
  }
  const infra = new DBTCommandExecutionInfrastructure(runtime, term)
  const python = new PythonDBTCommandExecutionStrategy(exec, runtime, term, config)
  const cli = (cwd: string, path: string) => new CLIDBTCommandExecutionStrategy(exec, runtime, term, cwd, path)

  const core = (
    root: string,
    diag: DBTDiagnosticData[],
    defer: DeferConfig,
    changed: () => void,
  ): DBTProjectIntegration =>
    new DBTCoreProjectIntegration(
      infra,
      runtime,
      provider,
      python,
      cli,
      term,
      config,
      client,
      root,
      diag,
      defer,
      changed,
    )

  const cloudVariantDetector = new DbtCloudVariantDetector(term)

  const cloud = (
    root: string,
    diag: DBTDiagnosticData[],
    defer: DeferConfig,
    changed: () => void,
  ): DBTProjectIntegration =>
    new DBTCloudProjectIntegration(
      infra,
      factory,
      cli,
      runtime,
      provider,
      term,
      root,
      diag,
      defer,
      changed,
      cloudVariantDetector,
      // Every variant but fusion-stable runs on a dbt Core command engine, which needs these.
      { pythonDBTCommandExecutionStrategy: python, dbtConfiguration: config, dbtIntegrationClient: client },
    )

  const command = (
    root: string,
    diag: DBTDiagnosticData[],
    defer: DeferConfig,
    changed: () => void,
  ): DBTProjectIntegration =>
    new DBTCoreCommandProjectIntegration(
      infra,
      runtime,
      provider,
      python,
      cli,
      term,
      config,
      client,
      root,
      diag,
      defer,
      changed,
    )

  const fusion = (
    root: string,
    diag: DBTDiagnosticData[],
    defer: DeferConfig,
    changed: () => void,
  ): DBTProjectIntegration =>
    new DBTFusionCommandProjectIntegration(infra, factory, cli, runtime, provider, term, root, diag, defer, changed)

  const adapter = new DBTProjectIntegrationAdapter(
    config,
    factory,
    core,
    cloud,
    fusion,
    command,
    cfg.projectRoot,
    undefined,
    new ChildrenParentParser(),
    new NodeParser(term),
    new MacroParser(term),
    new MetricParser(term),
    new GraphParser(term),
    new SourceParser(term),
    new TestParser(term),
    new UnitTestParser(term),
    new ExposureParser(term),
    new FunctionParser(term),
    new DocParser(term),
    term,
    new ModelDepthParser(term, client, config),
    new SemanticModelParser(term),
  )

  // The library's own install is off (see `getInstallDepsOnProjectInitialization`), so every
  // caller of `create` gets packages from here: only when missing or out of date, under a
  // cross-process lock. Other failures are not fatal: the manifest parse reports a missing
  // package with dbt's own error and the next call retries. Waiting too long for another
  // process's install is fatal: continuing would read packages that are being rewritten.
  try {
    const packages = await ensurePackages(cfg.projectRoot, dbtDepsInstaller(cfg))
    if (packages.action === "installed") options.onPackagesInstalled?.()
  } catch (err) {
    if (err instanceof PackageLockTimeoutError) throw err
    bufferLog(`[dbt-tools] package install check failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Before `initialize`, whose parse is the one the commands answer from.
  adapter.on(DBTProjectIntegrationAdapterEvents.MANIFEST_PARSED, recordManifest)
  try {
    retryParseManifest(adapter, { shouldRetry: () => adapter.getTargetPath() !== undefined })
    await adapter.initialize()
  } catch (e) {
    // initialize() can fail after the integration started a Python bridge; stop it.
    await adapter.dispose().catch(() => {})
    throw e
  }
  return adapter
}
