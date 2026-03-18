import type { Config } from "./config"
import { bufferLog } from "./log-buffer"
export { getRecentDbtLogs, clearDbtLogs } from "./log-buffer"
import {
  DBTProjectIntegrationAdapter,
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
    getInstallDepsOnProjectInitialization: () => DEFAULT_CONFIGURATION_VALUES.installDepsOnProjectInitialization,
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
    debug: () => {},
    info: (_name: string, msg: string) => bufferLog(`[dbt] ${msg}`),
    warn: (_name: string, msg: string) => bufferLog(`[dbt:warn] ${msg}`),
    error: (_name: string, msg: string, e: unknown) => {
      const err = e instanceof Error ? e.message : String(e)
      bufferLog(`[dbt:error] ${msg} ${err}`)
    },
    dispose: () => {},
  }
}

function env(cfg: Config): RuntimePythonEnvironment {
  const vars = { ...process.env }
  return {
    pythonPath: cfg.pythonPath,
    getEnvironmentVariables: () => vars,
  }
}

export async function create(cfg: Config): Promise<DBTProjectIntegrationAdapter> {
  const config = configuration(cfg)
  const term = terminal()
  const factory = new DBTCommandFactory(config)

  const http = new AltimateHttpClient(term, config)
  const client = new DbtIntegrationClient(http, term)

  const runtime = env(cfg)
  const provider = {
    getCurrentEnvironment: () => runtime,
    onEnvironmentChanged: () => () => {},
  }
  const exec = new CommandProcessExecutionFactory(term)
  const infra = new DBTCommandExecutionInfrastructure(runtime, term)
  const python = new PythonDBTCommandExecutionStrategy(exec, runtime, term, config)
  const cli = (cwd: string, path: string) => new CLIDBTCommandExecutionStrategy(exec, runtime, term, cwd, path)

  const core = (root: string, diag: DBTDiagnosticData[], defer: DeferConfig, changed: () => void): DBTProjectIntegration =>
    new DBTCoreProjectIntegration(infra, runtime, provider, python, cli, term, config, client, root, diag, defer, changed)

  const cloud = (root: string, diag: DBTDiagnosticData[], defer: DeferConfig, changed: () => void): DBTProjectIntegration =>
    new DBTCloudProjectIntegration(infra, factory, cli, runtime, provider, term, root, diag, defer, changed)

  const command = (root: string, diag: DBTDiagnosticData[], defer: DeferConfig, changed: () => void): DBTProjectIntegration =>
    new DBTCoreCommandProjectIntegration(infra, runtime, provider, python, cli, term, config, client, root, diag, defer, changed)

  const fusion = (root: string, diag: DBTDiagnosticData[], defer: DeferConfig, changed: () => void): DBTProjectIntegration =>
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
    new ExposureParser(term),
    new FunctionParser(term),
    new DocParser(term),
    term,
    new ModelDepthParser(term, client, config),
  )

  await adapter.initialize()
  return adapter
}
