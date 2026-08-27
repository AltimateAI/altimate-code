import type { Argv } from "yargs"

import { certify, certificateCacheKey, type LocalCertificate } from "./certify"
import { describeHardware, detectHardware, matchHardwareToTier } from "./hardware"
import { fetchModelArtifacts, type DownloadProgress } from "./fetch"
import { loadRecipes, refreshRecipes, selectModel, type DockerRecipeTier, type LlamaRecipeTier, type ModelRecipe } from "./recipes"
import { formatPreflight, runPreflight } from "./preflight"
import { withLifecycleLock } from "./lock"
import { runtimeAsset } from "./runtime"
import { startDockerServer } from "./docker"
import { pickPort, writeServerState } from "./server"
import { getLocalPaths, ensureLocalDirectories } from "./paths"
import { ensureLlamaServer } from "./runtime"
import { getServerStatus, startServer, stopServer, type ServerState } from "./server"
import { readEgressGuard, wireLocalProvider } from "./wire"

export interface LocalArgs {
  model?: string
  egressGuard?: boolean
  port?: number
  ctx?: number
  parallel?: number
  kv?: string
  mtp?: boolean
  effort?: "low" | "medium" | "xhigh"
  temperature?: number
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

async function task(run: () => Promise<void>) {
  try {
    await run()
  } catch (error) {
    console.error(`Error: ${message(error)}`)
    process.exitCode = 1
  }
}

function replaceFlag(flags: string[], name: string, value: string) {
  const index = flags.indexOf(name)
  if (index >= 0 && index + 1 < flags.length) flags[index + 1] = value
}

// Exported for unit testing — setup()'s full pipeline (recipe loading,
// hardware detection, preflight, download, server start) has no dedicated
// test seam, but the override-validation logic here is pure and worth
// testing directly.
export function withOverrides(tier: LlamaRecipeTier, args: LocalArgs): LlamaRecipeTier {
  const result = structuredClone(tier)
  if (args.ctx !== undefined) result.ctx = args.ctx
  if (args.parallel !== undefined) result.parallel = args.parallel
  if (
    !Number.isInteger(result.ctx) ||
    !Number.isInteger(result.parallel) ||
    result.ctx <= 0 ||
    result.parallel <= 0 ||
    result.ctx % result.parallel !== 0
  ) {
    throw new Error("--ctx and --parallel must be positive integers, with --ctx dividing evenly across --parallel slots")
  }
  if (args.kv) result.kv = args.kv
  if (args.effort) result.agent.reasoning_effort = args.effort
  if (args.temperature !== undefined) {
    if (!Number.isFinite(args.temperature) || args.temperature < 0)
      throw new Error("--temperature must be non-negative")
    result.agent.temperature = args.temperature
    replaceFlag(result.flags, "--temp", String(args.temperature))
  }
  if (args.mtp === false) result.mtp = undefined
  return result
}

function progressLogger() {
  const last = new Map<string, number>()
  return (artifact: string, progress: DownloadProgress) => {
    const percent = progress.total ? Math.floor((progress.received / progress.total) * 100) : undefined
    const marker = percent ?? Math.floor(progress.received / (256 * 1024 * 1024))
    if (last.get(artifact) === marker) return
    last.set(artifact, marker)
    const received = (progress.received / 1024 ** 3).toFixed(1)
    const total = progress.total ? ` / ${(progress.total / 1024 ** 3).toFixed(1)}GB` : "GB"
    console.log(`Downloading ${artifact}: ${received}${total}${percent === undefined ? "" : ` (${percent}%)`}`)
  }
}

function printCertificate(certificate: LocalCertificate) {
  for (const [name, result] of Object.entries(certificate.checks)) {
    console.log(`${result.ok ? "✓" : "✗"} ${name.replaceAll("_", " ")}: ${result.detail}`)
  }
}

function certificationInput(state: ServerState) {
  return {
    baseURL: state.baseURL,
    modelID: state.modelID,
    modelSha256: state.modelSha256,
    runtimeVersion: state.runtimeVersion,
    flags: state.flags,
    reasoningEffort: state.reasoningEffort,
    temperature: state.temperature,
  }
}

function printReady(wired: { file: string; guarded: string[]; defaultModelIsLocal: boolean }, modelID: string) {
  console.log(`✓ Ready. Configured local/${modelID} in ${wired.file}`)
  if (!wired.defaultModelIsLocal) {
    console.log(`  ! Your default model is still set to something else — sessions keep using it, not local/${modelID}.`)
    console.log(`    Switch with: altimate --model local/${modelID}, or set "model" in ${wired.file}.`)
  }
  if (wired.guarded.length > 0) {
    console.log(`  Egress guard: ${wired.guarded.join(", ")} now ask before leaving this machine.`)
    console.log("  Local runs have no per-token cost. Disable the guard with --no-egress-guard.")
  }
  console.log("  Note: the first turn of each session prefills the full context — on laptops")
  console.log("  this can take a few minutes; later turns reuse the cache and stream normally.")
  console.log('  Try: altimate "profile the orders table and suggest tests"')
}

async function setupDocker(model: ModelRecipe, tier: DockerRecipeTier, args: LocalArgs) {
  console.log(`◇ Recommended: ${model.name} ${tier.quant} · SGLang + EAGLE in the pinned container · ${tier.ctx} context`)
  const port = await pickPort(args.port && args.port > 0 ? args.port : 8095)
  console.log("◇ Starting SGLang container (first run downloads the weights — this can take a while)")
  const started = await startDockerServer({
    tier,
    modelID: model.id,
    port,
    onProgress: (line) => console.log(`  ${line}`),
  })
  const state: ServerState = {
    schema: 1,
    engine: "docker-sglang",
    pid: started.pid,
    host: "127.0.0.1",
    port,
    baseURL: `http://127.0.0.1:${port}/v1`,
    modelID: model.id,
    modelPath: tier.model_hf,
    modelSha256: tier.image_digest.slice("sha256:".length),
    runtimePath: `${tier.image}@${tier.image_digest}`,
    runtimeVersion: `sglang ${tier.image}`,
    tier: tier.name,
    flags: [
      "--model-path",
      `${tier.model_hf}@${tier.model_revision}`,
      "--context-length",
      String(tier.ctx),
      ...tier.server_args,
    ],
    reasoningEffort: tier.agent.reasoning_effort,
    temperature: tier.agent.temperature,
    startedAt: new Date().toISOString(),
    logPath: `docker logs ${started.container}`,
  }
  try {
    await writeServerState(state)
  } catch (error) {
    // A running container without tracking state is an orphan: reap it.
    const { removeDockerContainer } = await import("./docker")
    await removeDockerContainer().catch(() => {})
    throw error
  }
  console.log(`◇ Local server healthy: ${state.baseURL}`)

  const certificate = await certify(certificationInput(state))
  printCertificate(certificate)
  if (!certificate.passed)
    throw new Error("Local certification failed. Run `altimate local doctor --show` for details.")
  const wired = await wireLocalProvider({
    baseURL: state.baseURL,
    modelID: model.id,
    tier: { ctx: tier.ctx, parallel: 1, agent: tier.agent },
    egressGuard: args.egressGuard,
  })
  printReady(wired, model.id)
}

async function setup(args: LocalArgs) {
  const loaded = await loadRecipes()
  if (loaded.warning) console.warn(loaded.warning)
  const model = selectModel(loaded.recipes, args.model)
  const hardware = await detectHardware()
  console.log(`◇ Detected: ${describeHardware(hardware)}`)
  const match = matchHardwareToTier(hardware, model)
  if (!match.tier) throw new Error(`${match.reason}. No Phase 1 recipe matches this machine.`)
  const matched = match.tier
  if (matched.engine !== "llama.cpp" && matched.engine !== "docker-sglang") {
    console.log(`◇ Recommended: ${matched.name}`)
    throw new Error(matched.guidance)
  }
  // Validate CLI overrides before anything else, including stopping a
  // working existing server below — a bad --ctx/--parallel must fail before
  // any destructive step, not after.
  const tier = matched.engine === "llama.cpp" ? withOverrides(matched, args) : matched

  const paths = getLocalPaths()
  await ensureLocalDirectories(paths)
  const preflight = await runPreflight({
    tier,
    model: { id: model.id, revision: model.revision },
    hardware,
    availableGb: match.availableGb,
    directory: paths.root,
  })
  for (const line of formatPreflight(preflight)) console.log(`◇ ${line}`)
  if (!preflight.passed) {
    const fatal = preflight.checks.filter((check) => !check.ok && check.fatal)
    throw new Error(`This machine cannot run the ${matched.name} recipe yet: ${fatal.map((check) => check.detail).join("; ")}`)
  }

  // Only stop a working existing server once we're confident the
  // replacement will actually be attempted (guidance-only engines and
  // preflight failures are both handled above): a failed new setup must not
  // leave the user with no working server when they had one before
  // re-running this command.
  const existing = await getServerStatus()
  if (existing.state) {
    console.log(`◇ Stopping existing managed server (${existing.state.tier}) before reconfiguring`)
    await stopServer()
  }

  if (tier.engine === "docker-sglang") {
    await setupDocker(model, tier, args)
    return
  }
  // No runtime build for this platform-arch (e.g. Intel macOS) must fail
  // BEFORE the multi-GB model download, not after.
  runtimeAsset({})
  console.log(
    `◇ Recommended: ${model.name} ${tier.quant} · ${Math.floor(tier.ctx / tier.parallel)} context/slot · ` +
      `${tier.agent.tool_retrieval ? "tool-slim" : "all tools"} · ${tier.mtp ? "MTP speculative" : "no MTP"}`,
  )

  const logProgress = progressLogger()
  const artifacts = await fetchModelArtifacts({
    model,
    tier,
    mtp: args.mtp,
    onProgress: logProgress,
  })
  console.log(`◇ Model verified: ${artifacts.model.path}`)
  const runtime = await ensureLlamaServer({ onProgress: (progress) => logProgress("runtime", progress) })
  console.log(`◇ Runtime: ${runtime.version} (${runtime.source})`)
  const state = await startServer({
    runtime,
    modelID: model.id,
    modelPath: artifacts.model.path,
    modelSha256: artifacts.model.sha256,
    mtpPath: artifacts.mtp?.path,
    mtpSha256: artifacts.mtp?.sha256,
    tier,
    port: args.port,
  })
  console.log(`◇ Local server healthy: ${state.baseURL}`)

  const certificate = await certify(certificationInput(state))
  printCertificate(certificate)
  if (!certificate.passed)
    throw new Error("Local certification failed. Run `altimate local doctor --show` for details.")
  const wired = await wireLocalProvider({
    baseURL: state.baseURL,
    modelID: model.id,
    tier,
    egressGuard: args.egressGuard,
  })
  printReady(wired, model.id)
}

const LocalStatusCommand = {
  command: "status",
  describe: "show the managed local model server status",
  async handler() {
    await task(async () => {
      const status = await getServerStatus()
      if (!status.state) {
        console.log("Local model server: stopped")
        return
      }
      console.log(
        `Local model server: ${status.healthy ? "healthy" : status.processAlive ? "unhealthy" : "stopped (stale state)"}`,
      )
      console.log(`PID: ${status.state.pid}`)
      console.log(`Endpoint: ${status.state.baseURL}`)
      console.log(`Model: local/${status.state.modelID} (${status.state.tier})`)
      console.log(`Runtime: ${status.state.runtimeVersion}`)
      console.log(`Started: ${status.state.startedAt}`)
      const key = certificateCacheKey({
        modelSha256: status.state.modelSha256,
        runtimeVersion: status.state.runtimeVersion,
        flags: status.state.flags,
        reasoningEffort: status.state.reasoningEffort,
        temperature: status.state.temperature,
      })
      console.log(`Certificate: ${key}`)
      const guard = await readEgressGuard()
      console.log("Egress guard (network tools):")
      for (const [permission, action] of Object.entries(guard)) {
        console.log(`  ${permission}: ${action}`)
      }
      console.log("Local runs: no per-token cost")
    })
  },
}

const LocalStopCommand = {
  command: "stop",
  describe: "stop the managed local model server",
  async handler() {
    await task(async () => {
      const result = await withLifecycleLock(() => stopServer())
      if (result.stopped) console.log(`Stopped local model server (pid ${result.pid}).`)
      else if (result.reason === "stale") console.log("Removed stale local server state; no process was running.")
      else console.log("Local model server is not running.")
    })
  },
}

const LocalDoctorCommand = {
  command: "doctor",
  describe: "re-run local model certification",
  builder: (yargs: Argv) =>
    yargs.option("show", {
      type: "boolean",
      default: false,
      describe: "print the certificate JSON",
    }),
  async handler(args: { show?: boolean }) {
    await task(async () => {
      const status = await getServerStatus()
      if (!status.state || !status.healthy)
        throw new Error("Local model server is not healthy. Run `altimate local` first.")
      const certificate = await certify({ ...certificationInput(status.state), force: true })
      if (args.show) console.log(JSON.stringify(certificate, null, 2))
      else printCertificate(certificate)
      if (!certificate.passed) {
        process.exitCode = 1
        return
      }
      console.log("✓ Local certification passed.")
    })
  },
}

const LocalModelsCommand = {
  command: "models",
  describe: "list the local model registry",
  async handler() {
    await task(async () => {
      const loaded = await loadRecipes()
      if (loaded.warning) console.warn(loaded.warning)
      const hardware = await detectHardware()
      for (const model of loaded.recipes.models) {
        const match = matchHardwareToTier(hardware, model)
        const fit = match.tier ? `matches this machine (${match.tier.name})` : "no matching tier here"
        const isDefault = model === loaded.recipes.models[0] ? " · default" : ""
        console.log(`${model.id} — ${model.name}${isDefault}`)
        console.log(`  tiers: ${model.tiers.map((tier) => `${tier.name} (${tier.quant})`).join(", ")}`)
        console.log(`  ${fit}`)
      }
      console.log("Run `altimate local --model <id>` to set one up.")
    })
  },
}

const LocalUpdateCommand = {
  command: "update",
  describe: "refresh the pinned local model recipes",
  async handler() {
    await task(async () => {
      const result = await refreshRecipes()
      if (result.warning) console.warn(result.warning)
      console.log(`Local recipes: ${result.source} (schema ${result.recipes.schema})`)
      console.log("Run `altimate local` to apply the selected recipe and model artifact.")
    })
  },
}

export const LocalCommand = {
  command: "local",
  describe: "set up and run the certified local data agent",
  builder: (yargs: Argv) =>
    yargs
      .command(LocalStatusCommand)
      .command(LocalStopCommand)
      .command(LocalDoctorCommand)
      .command(LocalModelsCommand)
      .command(LocalUpdateCommand)
      .option("model", { type: "string", describe: "registry model id (see `altimate local models`)" })
      .option("egress-guard", {
        type: "boolean",
        default: true,
        describe: "make network tools (websearch/webfetch/codesearch) ask before leaving this machine",
      })
      .option("port", { type: "number", describe: "preferred llama-server port (auto-picks if unavailable)" })
      .option("ctx", { type: "number", describe: "aggregate llama.cpp context size" })
      .option("parallel", { type: "number", describe: "llama.cpp parallel slot count" })
      .option("kv", { type: "string", describe: "K/V cache type" })
      .option("mtp", { type: "boolean", default: true, describe: "enable MTP speculative decoding" })
      .option("effort", {
        type: "string",
        choices: ["low", "medium", "xhigh"] as const,
        describe: "reasoning effort",
      })
      .option("temperature", { type: "number", describe: "client and server sampling temperature" }),
  async handler(args: LocalArgs) {
    await task(() => withLifecycleLock(() => setup(args)))
  },
}
