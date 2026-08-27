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

export interface ContainerReaper {
  // Aborted the instant a signal arrives (before the async removeDockerContainer
  // call below even starts) — callers in the untracked window can check this to
  // avoid returning a "success" that races the reaper's own container removal.
  readonly signal: AbortSignal
  uninstall(): void
}

// The container is created (and can spend up to 45 minutes downloading weights
// or occupying the GPU) before setupDocker ever writes state.json — that only
// happens once startDockerServer returns. An interrupt (Ctrl-C) during that
// window kills the CLI but leaves the labeled container running, invisible to
// `altimate local stop`/`status` because they only act on tracked state.
// Reaping it here — via the same ownership-checked removeDockerContainer used
// everywhere else — closes that window without needing state to exist yet.
export function installContainerReaper(
  exec: DockerExec,
  onExit: (code: number) => void = (code) => process.exit(code),
  signalSource: Pick<NodeJS.EventEmitter, "on" | "off"> = process,
): ContainerReaper {
  const controller = new AbortController()
  let cleaningUp = false
  let exited = false
  const finishOnce = (code: number) => {
    if (exited) return
    exited = true
    onExit(code)
  }
  const handler = (signal: NodeJS.Signals) => {
    const code = signal === "SIGINT" ? 130 : 143
    controller.abort()
    if (cleaningUp) {
      // A second signal while `docker rm` is still in flight (up to its 120s
      // exec timeout, longer if the daemon is wedged) must not be swallowed —
      // force immediate exit instead of making the user wait it out.
      finishOnce(code)
      return
    }
    cleaningUp = true
    removeDockerContainer(exec)
      .catch((error) => {
        console.error(
          `Failed to remove the local model container during shutdown: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
      .finally(() => finishOnce(code))
  }
  signalSource.on("SIGINT", handler)
  signalSource.on("SIGTERM", handler)
  return {
    signal: controller.signal,
    uninstall: () => {
      signalSource.off("SIGINT", handler)
      signalSource.off("SIGTERM", handler)
    },
  }
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
  // Test-only seams (default to `process`/`process.exit`): let tests inject
  // a fake signal source and a non-terminating exit callback instead of
  // emitting real SIGINT/SIGTERM on — and calling process.exit() in — the
  // shared test process.
  signalSource?: Pick<NodeJS.EventEmitter, "on" | "off">
  onSignalExit?: (code: number) => void
}) {
  const exec = input.exec ?? defaultExec
  const pollIntervalMs = input.pollIntervalMs ?? 3000
  await removeDockerContainer(exec)
  const hfCache = path.join(os.homedir(), ".cache", "huggingface")
  await exec("docker", buildDockerRunArgs({ tier: input.tier, modelID: input.modelID, port: input.port, hfCache }), 30 * 60_000)
  // The container now exists but is untracked (state.json isn't written until
  // setupDocker records this function's return value) for as long as the
  // pid-inspect and health-wait steps below take — up to 45 minutes on a slow
  // first-run weight download. Reap the (ownership-checked) labeled container
  // on Ctrl-C/SIGTERM for that whole window, not just the explicit failure
  // paths already handled by the try/catches below.
  const reaper = installContainerReaper(exec, input.onSignalExit, input.signalSource)
  try {
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
        if (await dockerHealthy(input.port, input.fetchImpl)) {
          // A signal can arrive while the dockerHealthy call above is
          // in-flight: the reaper aborts synchronously the instant it fires,
          // before its own removeDockerContainer starts, so this check right
          // after resuming from the await catches it before we hand back a
          // "success" that races the reaper's in-flight removal — returning
          // here would let setupDocker write state.json and wire the config
          // for a container the reaper is concurrently deleting.
          if (reaper.signal.aborted) {
            throw new Error(
              "Startup was interrupted by a shutdown signal just as the server became healthy; the container is being removed.",
            )
          }
          return { pid, container: LOCAL_CONTAINER_NAME }
        }
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
      let cleanupError: unknown
      try {
        await removeDockerContainer(exec)
      } catch (removeError) {
        cleanupError = removeError
      }
      if (cleanupError !== undefined) {
        // Swallowing this used to hide it entirely behind the original
        // polling error: the container can still be running, untracked, and
        // the failure message gave no hint that cleanup itself also failed.
        const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        const original = error instanceof Error ? error : new Error(String(error))
        throw new Error(
          `${original.message}\n\nAdditionally, removing the container during cleanup failed and it may still be running untracked: ${cleanupMessage}`,
          { cause: original },
        )
      }
      throw error
    }
  } finally {
    reaper.uninstall()
  }
}
