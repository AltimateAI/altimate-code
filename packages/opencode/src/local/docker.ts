import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

import type { DockerRecipeTier } from "./recipes"

const execFileAsync = promisify(execFile)

export const LOCAL_CONTAINER_NAME = "altimate-local-model"
// Stamped on every container `altimate local` creates so removeDockerContainer
// can verify ownership before force-removing whatever currently holds this
// fixed, globally-visible name — without it, an unrelated workload that
// happens to use the same container name would be destroyed on the next
// `altimate local` / `stop` run.
export const LOCAL_MANAGEMENT_LABEL_KEY = "ai.altimate.local-model"
export const LOCAL_MANAGEMENT_LABEL_VALUE = "managed"

export type DockerExec = (file: string, args: string[], timeoutMs?: number) => Promise<{ stdout: string; stderr: string }>

const defaultExec: DockerExec = async (file, args, timeoutMs = 60_000) => {
  const result = await execFileAsync(file, args, { maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs })
  return { stdout: String(result.stdout), stderr: String(result.stderr) }
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export function buildDockerRunArgs(input: { tier: DockerRecipeTier; modelID: string; port: number; hfCache: string }) {
  const tier = input.tier
  return [
    "run",
    "-d",
    "--name",
    LOCAL_CONTAINER_NAME,
    "--label",
    `${LOCAL_MANAGEMENT_LABEL_KEY}=${LOCAL_MANAGEMENT_LABEL_VALUE}`,
    "--gpus",
    "all",
    "--ipc=host",
    "-p",
    `127.0.0.1:${input.port}:${tier.container_port}`,
    "-v",
    `${input.hfCache}:/root/.cache/huggingface`,
    `${tier.image}@${tier.image_digest}`,
    "python3",
    "-m",
    "sglang.launch_server",
    "--model-path",
    tier.model_hf,
    "--revision",
    tier.model_revision,
    "--served-model-name",
    input.modelID,
    "--tp",
    "1",
    "--context-length",
    String(tier.ctx),
    ...tier.server_args,
    "--host",
    "0.0.0.0",
    "--port",
    String(tier.container_port),
  ]
}

// SGLang's /health returns 200 with an empty body, unlike llama-server's
// {"status":"ok"} — any 2xx counts as healthy here.
export async function dockerHealthy(port: number, fetchImpl: Fetch = fetch) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) })
    return response.ok
  } catch {
    return false
  }
}

// Docker's own "not found" errors are the only ones that legitimately mean
// "container absent" — any other exec failure (daemon down, permission
// denied, timeout) must propagate instead of being read as absence, or a
// caller can conclude the container is gone/stopped while it is still
// running.
function isContainerNotFoundError(error: unknown): boolean {
  const stderr = typeof (error as { stderr?: unknown })?.stderr === "string" ? (error as { stderr: string }).stderr : ""
  const message = error instanceof Error ? error.message : String(error)
  return /no such (object|container|image)/i.test(stderr) || /no such (object|container|image)/i.test(message)
}

export async function dockerContainerRunning(exec: DockerExec = defaultExec) {
  try {
    const result = await exec("docker", ["inspect", "-f", "{{.State.Running}}", LOCAL_CONTAINER_NAME])
    return result.stdout.trim() === "true"
  } catch (error) {
    if (isContainerNotFoundError(error)) return false
    throw error
  }
}

export async function removeDockerContainer(exec: DockerExec = defaultExec) {
  let exists: boolean
  try {
    await exec("docker", ["inspect", "-f", "{{.Id}}", LOCAL_CONTAINER_NAME])
    exists = true
  } catch (error) {
    if (!isContainerNotFoundError(error)) throw error
    exists = false
  }
  if (!exists) return { existed: false, removed: false }

  // Force-removing by this fixed, globally-visible name is only safe if we
  // created it: verify the management label every `altimate local` docker
  // run stamps (see buildDockerRunArgs) before touching a container that
  // some unrelated workload might happen to also be using under this name.
  // Left unguarded (unlike the existence check above): a docker/exec failure
  // here is a real error to propagate, not evidence of "not ours" — only an
  // empty/mismatched label value means that.
  const label = await exec("docker", [
    "inspect",
    "-f",
    `{{index .Config.Labels "${LOCAL_MANAGEMENT_LABEL_KEY}"}}`,
    LOCAL_CONTAINER_NAME,
  ])
  if (label.stdout.trim() !== LOCAL_MANAGEMENT_LABEL_VALUE) {
    throw new Error(
      `A container named "${LOCAL_CONTAINER_NAME}" already exists but was not created by \`altimate local\` — refusing to force-remove a container this tool does not own. Remove it manually if that is safe.`,
    )
  }

  // rm failure must NOT look like success: callers keep state so the
  // container is never orphaned silently.
  await exec("docker", ["rm", "-f", LOCAL_CONTAINER_NAME], 120_000)
  return { existed: true, removed: true }
}

async function containerLogTail(exec: DockerExec) {
  return exec("docker", ["logs", "--tail", "1", LOCAL_CONTAINER_NAME])
    .then((result) => (result.stderr || result.stdout).trim().split("\n").at(-1) ?? "")
    .catch(() => "")
}

export async function startDockerServer(input: {
  tier: DockerRecipeTier
  modelID: string
  port: number
  exec?: DockerExec
  fetchImpl?: Fetch
  timeoutMs?: number
  pollIntervalMs?: number
  onProgress?: (line: string) => void
}) {
  const exec = input.exec ?? defaultExec
  const pollIntervalMs = input.pollIntervalMs ?? 3000
  await removeDockerContainer(exec)
  const hfCache = path.join(os.homedir(), ".cache", "huggingface")
  await exec("docker", buildDockerRunArgs({ tier: input.tier, modelID: input.modelID, port: input.port, hfCache }), 30 * 60_000)
  let pidRaw: { stdout: string; stderr: string }
  try {
    pidRaw = await exec("docker", ["inspect", "-f", "{{.State.Pid}}", LOCAL_CONTAINER_NAME])
  } catch (error) {
    // The container is already running (docker run succeeded); an inspect
    // failure here must not leave it orphaned and untracked.
    await removeDockerContainer(exec)
    throw error
  }
  const pid = Number(pidRaw.stdout.trim())
  if (!Number.isInteger(pid) || pid <= 0) {
    await removeDockerContainer(exec)
    throw new Error("SGLang container started but did not report a pid")
  }

  // First run downloads the weights inside the container; allow a long window
  // and surface container log lines so the wait is legible.
  try {
    const deadline = Date.now() + (input.timeoutMs ?? 45 * 60_000)
    let lastLine = ""
    while (Date.now() < deadline) {
      if (await dockerHealthy(input.port, input.fetchImpl)) return { pid, container: LOCAL_CONTAINER_NAME }
      if (!(await dockerContainerRunning(exec))) {
        const logs = await exec("docker", ["logs", "--tail", "25", LOCAL_CONTAINER_NAME])
          .then((result) => result.stderr + result.stdout)
          .catch(() => "")
        throw new Error(`SGLang container exited before becoming healthy.\n${logs.slice(-2000)}`)
      }
      const line = await containerLogTail(exec)
      if (line && line !== lastLine) {
        lastLine = line
        input.onProgress?.(line)
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    }
    throw new Error("SGLang container did not become healthy in time")
  } catch (error) {
    // Any failure while polling — including dockerContainerRunning itself
    // throwing on a transient daemon error, not just the two explicit
    // failure messages above — must not leave an untracked container
    // running: setupDocker only records state once this function succeeds,
    // so anything left behind here is invisible to `status`/`stop`.
    await removeDockerContainer(exec).catch(() => {})
    throw error
  }
}
