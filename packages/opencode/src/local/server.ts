import { closeSync, openSync } from "node:fs"
import fs from "node:fs/promises"
import net from "node:net"
import { spawn } from "node:child_process"
import path from "node:path"
import { once } from "node:events"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

import type { LlamaRecipeTier } from "./recipes"
import { dockerContainerRunning, dockerHealthy, removeDockerContainer, type DockerExec } from "./docker"
import type { RuntimeInfo } from "./runtime"
import { ensureLocalDirectories, getLocalPaths, type LocalPaths } from "./paths"

const execFileAsync = promisify(execFile)

export interface ServerState {
  schema: 1
  engine?: "llama.cpp" | "docker-sglang"
  pid: number
  host: "127.0.0.1"
  port: number
  baseURL: string
  modelID: string
  modelPath: string
  modelSha256: string
  mtpSha256?: string
  runtimePath: string
  runtimeVersion: string
  tier: string
  flags: string[]
  reasoningEffort: string
  temperature: number
  startedAt: string
  logPath: string
}

export interface ServerStatus {
  state?: ServerState
  processAlive: boolean
  healthy: boolean
  stale: boolean
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

async function bind(port: number) {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => {
      const address = server.address()
      const selected = typeof address === "object" && address ? address.port : 0
      server.close((error) => (error ? reject(error) : resolve(selected)))
    })
  })
}

// Bind success is NOT proof a port is free: Bun-based dev servers listen with
// SO_REUSEPORT, so a second bind on the same 127.0.0.1 port silently succeeds
// and the two processes then share incoming connections (observed: health
// polls landing on an unrelated admin app instead of llama-server). A port
// only counts as free when binding succeeds AND nothing answers HTTP on it.
async function respondsToHttp(port: number, fetchImpl: Fetch = fetch) {
  try {
    await fetchImpl(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(750) })
    return true
  } catch {
    return false
  }
}

export async function pickPort(
  preferred = 42625,
  bindPort: (port: number) => Promise<number> = bind,
  probe: (port: number) => Promise<boolean> = respondsToHttp,
) {
  const candidates = preferred > 0 ? [preferred, preferred + 1, preferred + 2, preferred + 3] : []
  for (const candidate of candidates) {
    const selected = await bindPort(candidate).catch(() => 0)
    if (selected && !(await probe(selected))) return selected
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const selected = await bindPort(0)
    if (!selected) break
    if (!(await probe(selected))) return selected
  }
  throw new Error("Could not find a local port that is both bindable and silent")
}

export async function readServerState(paths = getLocalPaths()): Promise<ServerState | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(paths.state, "utf8")) as ServerState
    if (parsed.schema !== 1 || !Number.isInteger(parsed.pid) || !Number.isInteger(parsed.port)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

export async function writeServerState(state: ServerState, paths = getLocalPaths()) {
  await ensureLocalDirectories(paths)
  const temp = `${paths.state}.${process.pid}.tmp`
  await fs.writeFile(temp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 })
  await fs.rename(temp, paths.state)
  await fs.writeFile(paths.pid, `${state.pid}\n`, { mode: 0o600 })
}

async function clearServerState(paths: LocalPaths) {
  await Promise.all([fs.unlink(paths.state).catch(() => {}), fs.unlink(paths.pid).catch(() => {})])
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// process.kill throws ESRCH if the process already exited between our last
// liveness check and this call — a real race under a fast-crashing or
// already-terminating llama-server. Swallowing it here (rather than at each
// call site) keeps that TOCTOU window from turning into an uncaught
// exception that skips the state cleanup that must always follow.
function tryKill(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(pid, signal)
  } catch {
    // Already exited — nothing to signal.
  }
}

// altimate_change start — upstream_fix: split out so the win32 PowerShell invocation can be
// unit-tested (args array only, no PowerShell execution) from CI that doesn't run on Windows.
export function windowsProcessCommandArgs(pid: number): string[] {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    // PowerShell's default host wraps string output at the (fake, redirected-console) buffer
    // width — commonly 80 or 120 columns — inserting a newline mid-string. A command line longer
    // than that would get split, breaking the `.includes(runtimePath)` / `.includes(modelPath)`
    // substring checks in managedProcess() below with a false negative. 32767 matches Windows'
    // own max command-line length, so no real command line can exceed it.
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine | Out-String -Width 32767`,
  ]
}
// altimate_change end

async function processCommand(pid: number) {
  if (process.platform === "linux") {
    return fs
      .readFile(`/proc/${pid}/cmdline`, "utf8")
      .then((value) => value.replaceAll("\0", " "))
      .catch(() => "")
  }
  if (process.platform === "win32") {
    // Native Windows has no `ps`. PowerShell's CIM cmdlets are the standard
    // way to read another process's full command line (tasklist only
    // exposes the image name, and `wmic` is deprecated/removed on newer
    // Windows). Without this, the command lookup always returned "", so
    // managedProcess() below always reported false and `altimate local
    // stop` refused to signal a live, managed llama-server.exe.
    return execFileAsync("powershell", windowsProcessCommandArgs(pid))
      .then((result) => result.stdout)
      .catch(() => "")
  }
  return execFileAsync("ps", ["-p", String(pid), "-o", "command="])
    .then((result) => result.stdout)
    .catch(() => "")
}

async function managedProcess(state: ServerState) {
  if (!processAlive(state.pid)) return false
  const command = await processCommand(state.pid)
  // Match the exact recorded runtime binary path (works with a custom
  // ALTIMATE_LOCAL_LLAMA_SERVER binary name) plus the model path, instead of
  // a hard-coded "llama-server" substring: that both false-negatives on a
  // renamed binary and false-positives on any unrelated process whose
  // command line happens to mention both strings.
  return command.includes(state.runtimePath) && command.includes(state.modelPath)
}

export async function checkHealth(port: number, fetchImpl: Fetch = fetch) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) })
    if (!response.ok) return false
    const body = (await response.json()) as { status?: unknown }
    return body.status === "ok"
  } catch {
    return false
  }
}

export async function getServerStatus(
  options: { paths?: LocalPaths; fetchImpl?: Fetch; dockerExec?: DockerExec } = {},
): Promise<ServerStatus> {
  const paths = options.paths ?? getLocalPaths()
  const state = await readServerState(paths)
  if (!state) return { processAlive: false, healthy: false, stale: false }
  if (state.engine === "docker-sglang") {
    const running = await dockerContainerRunning(options.dockerExec)
    const healthy = running && (await dockerHealthy(state.port, options.fetchImpl))
    return { state, processAlive: running, healthy, stale: !running }
  }
  // Raw PID liveness alone is not identity: if the recorded pid gets
  // recycled by the OS onto an unrelated process, a bare `processAlive`
  // check reports "alive" and a subsequent health probe on the recorded
  // port could hit an unrelated loopback service, marking a dead server
  // healthy. managedProcess() also checks the command line against the
  // recorded runtime + model path.
  const alive = await managedProcess(state)
  const healthy = alive && (await checkHealth(state.port, options.fetchImpl))
  return { state, processAlive: alive, healthy, stale: !alive }
}

function recipeFlags(input: { tier: LlamaRecipeTier; mtpPath?: string }) {
  const flags = [
    "--n-gpu-layers",
    "99",
    "--ctx-size",
    String(input.tier.ctx),
    "--parallel",
    String(input.tier.parallel),
    "--reasoning-budget",
    "-1",
    "--chat-template-kwargs",
    JSON.stringify({ reasoning_effort: input.tier.agent.reasoning_effort }),
    "-ctk",
    input.tier.kv,
    "-ctv",
    input.tier.kv,
    ...input.tier.flags,
  ]
  if (input.mtpPath && input.tier.mtp) {
    flags.push(
      "--model-draft",
      input.mtpPath,
      "--spec-type",
      "draft-mtp",
      "--spec-draft-n-max",
      String(input.tier.mtp.draft_max),
    )
  }
  return flags
}

export function buildServerArguments(input: {
  modelID: string
  modelPath: string
  port: number
  tier: LlamaRecipeTier
  mtpPath?: string
}) {
  const flags = recipeFlags(input)
  return {
    flags,
    args: [
      "--model",
      input.modelPath,
      "--alias",
      input.modelID,
      "--host",
      "127.0.0.1",
      "--port",
      String(input.port),
      ...flags,
    ],
  }
}

async function waitForHealth(input: { port: number; pid: number; timeoutMs: number; fetchImpl?: Fetch }) {
  const deadline = Date.now() + input.timeoutMs
  while (Date.now() < deadline) {
    if (!processAlive(input.pid)) throw new Error("llama-server exited before becoming healthy")
    if (await checkHealth(input.port, input.fetchImpl)) return
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`llama-server did not become healthy within ${Math.round(input.timeoutMs / 1000)} seconds`)
}

export async function startServer(input: {
  runtime: RuntimeInfo
  modelID: string
  modelPath: string
  modelSha256: string
  mtpPath?: string
  mtpSha256?: string
  tier: LlamaRecipeTier
  port?: number
  timeoutMs?: number
  paths?: LocalPaths
  fetchImpl?: Fetch
}) {
  const paths = input.paths ?? getLocalPaths()
  const desiredFlags = [
    ...recipeFlags({ tier: input.tier, mtpPath: input.mtpPath }),
    ...(input.mtpSha256 ? [`mtp-sha256=${input.mtpSha256}`] : []),
  ]
  const current = await getServerStatus({ paths, fetchImpl: input.fetchImpl })
  if (current.healthy && current.state) {
    const same =
      current.state.modelID === input.modelID &&
      current.state.modelSha256 === input.modelSha256 &&
      current.state.runtimeVersion === input.runtime.version &&
      current.state.tier === input.tier.name &&
      JSON.stringify(current.state.flags) === JSON.stringify(desiredFlags) &&
      (input.port === undefined || input.port === current.state.port)
    if (same) return current.state
    throw new Error(
      "A local server with different model, runtime, port, or flags is already running. Run `altimate local stop` first.",
    )
  }
  if (current.processAlive && current.state) {
    throw new Error("The managed llama-server process is running but unhealthy. Run `altimate local stop` first.")
  }
  if (current.stale) await clearServerState(paths)

  await ensureLocalDirectories(paths)
  const port = input.port && input.port > 0 ? await pickPort(input.port) : await pickPort()
  const built = buildServerArguments({
    modelID: input.modelID,
    modelPath: input.modelPath,
    port,
    tier: input.tier,
    mtpPath: input.mtpPath,
  })
  const log = openSync(paths.log, "a", 0o600)
  const child = spawn(input.runtime.path, built.args, {
    detached: true,
    stdio: ["ignore", log, log],
    env: {
      ...process.env,
      LD_LIBRARY_PATH: [path.dirname(input.runtime.path), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
    },
  })
  try {
    await Promise.race([once(child, "spawn"), once(child, "error").then(([error]) => Promise.reject(error))])
  } finally {
    closeSync(log)
  }
  child.unref()
  if (!child.pid) throw new Error("llama-server did not report a pid")

  const state: ServerState = {
    schema: 1,
    pid: child.pid,
    host: "127.0.0.1",
    port,
    baseURL: `http://127.0.0.1:${port}/v1`,
    modelID: input.modelID,
    modelPath: input.modelPath,
    modelSha256: input.modelSha256,
    mtpSha256: input.mtpSha256,
    runtimePath: input.runtime.path,
    runtimeVersion: input.runtime.version,
    tier: input.tier.name,
    flags: desiredFlags,
    reasoningEffort: input.tier.agent.reasoning_effort,
    temperature: input.tier.agent.temperature,
    startedAt: new Date().toISOString(),
    logPath: paths.log,
  }
  try {
    await writeServerState(state, paths)
    await waitForHealth({ port, pid: child.pid, timeoutMs: input.timeoutMs ?? 180_000, fetchImpl: input.fetchImpl })
    return state
  } catch (error) {
    // Covers state-write failures too (e.g. ENOSPC right after the model
    // download): a spawned server must never outlive its tracking state.
    // Same escalation as stopServer — a child that ignores SIGTERM would
    // otherwise be orphaned with its state already cleared. tryKill absorbs
    // the child exiting on its own between the liveness check and the
    // signal (ESRCH), so that race can't skip clearServerState below and
    // replace `error` with a kill-time exception.
    try {
      if (processAlive(child.pid)) {
        tryKill(child.pid, "SIGTERM")
        const deadline = Date.now() + 10_000
        while (processAlive(child.pid) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        if (processAlive(child.pid)) tryKill(child.pid, "SIGKILL")
      }
    } finally {
      await clearServerState(paths)
    }
    throw error
  }
}

export async function stopServer(options: { paths?: LocalPaths; graceMs?: number; dockerExec?: DockerExec } = {}) {
  const paths = options.paths ?? getLocalPaths()
  const state = await readServerState(paths)
  if (!state) return { stopped: false, reason: "not-running" as const }
  if (state.engine === "docker-sglang") {
    const running = await dockerContainerRunning(options.dockerExec)
    // Throws on rm failure — state stays so the container is not orphaned.
    await removeDockerContainer(options.dockerExec)
    await clearServerState(paths)
    if (!running) return { stopped: false, reason: "stale" as const }
    return { stopped: true, reason: "stopped" as const, pid: state.pid }
  }
  if (!processAlive(state.pid)) {
    await clearServerState(paths)
    return { stopped: false, reason: "stale" as const }
  }
  if (!(await managedProcess(state))) {
    throw new Error(`Refusing to signal pid ${state.pid}: it is not the managed llama-server process`)
  }

  // tryKill absorbs the process exiting on its own between the managedProcess
  // check above (or the liveness poll below) and the signal call — without
  // it, that race throws ESRCH and skips clearServerState, leaving stale
  // state.json behind for an already-dead server.
  tryKill(state.pid, "SIGTERM")
  const deadline = Date.now() + (options.graceMs ?? 10_000)
  while (processAlive(state.pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (processAlive(state.pid)) tryKill(state.pid, "SIGKILL")
  await clearServerState(paths)
  return { stopped: true, reason: "stopped" as const, pid: state.pid }
}
