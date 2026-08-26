import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

import type { DockerRecipeTier } from "./recipes"

const execFileAsync = promisify(execFile)

export const LOCAL_CONTAINER_NAME = "altimate-local-model"

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

export async function dockerContainerRunning(exec: DockerExec = defaultExec) {
  try {
    const result = await exec("docker", ["inspect", "-f", "{{.State.Running}}", LOCAL_CONTAINER_NAME])
    return result.stdout.trim() === "true"
  } catch {
    return false
  }
}

export async function removeDockerContainer(exec: DockerExec = defaultExec) {
  const exists = await exec("docker", ["inspect", "-f", "{{.Id}}", LOCAL_CONTAINER_NAME])
    .then(() => true)
    .catch(() => false)
  if (!exists) return { existed: false, removed: false }
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
  onProgress?: (line: string) => void
}) {
  const exec = input.exec ?? defaultExec
  await removeDockerContainer(exec)
  const hfCache = path.join(os.homedir(), ".cache", "huggingface")
  await exec("docker", buildDockerRunArgs({ tier: input.tier, modelID: input.modelID, port: input.port, hfCache }), 30 * 60_000)
  const pidRaw = await exec("docker", ["inspect", "-f", "{{.State.Pid}}", LOCAL_CONTAINER_NAME])
  const pid = Number(pidRaw.stdout.trim())
  if (!Number.isInteger(pid) || pid <= 0) {
    await removeDockerContainer(exec)
    throw new Error("SGLang container started but did not report a pid")
  }

  // First run downloads the weights inside the container; allow a long window
  // and surface container log lines so the wait is legible.
  const deadline = Date.now() + (input.timeoutMs ?? 45 * 60_000)
  let lastLine = ""
  while (Date.now() < deadline) {
    if (await dockerHealthy(input.port, input.fetchImpl)) return { pid, container: LOCAL_CONTAINER_NAME }
    if (!(await dockerContainerRunning(exec))) {
      const logs = await exec("docker", ["logs", "--tail", "25", LOCAL_CONTAINER_NAME])
        .then((result) => result.stderr + result.stdout)
        .catch(() => "")
      await removeDockerContainer(exec)
      throw new Error(`SGLang container exited before becoming healthy.\n${logs.slice(-2000)}`)
    }
    const line = await containerLogTail(exec)
    if (line && line !== lastLine) {
      lastLine = line
      input.onProgress?.(line)
    }
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
  await removeDockerContainer(exec)
  throw new Error("SGLang container did not become healthy in time")
}
