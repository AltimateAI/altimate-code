import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

import type { HardwareInfo } from "./hardware"
import type { ModelRecipe, RecipeTier } from "./recipes"

const execFileAsync = promisify(execFile)

export type PreflightExec = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>

const defaultExec: PreflightExec = async (file, args) => {
  const result = await execFileAsync(file, args, { maxBuffer: 4 * 1024 * 1024 })
  return { stdout: String(result.stdout), stderr: String(result.stderr) }
}

export interface PreflightCheck {
  name: string
  ok: boolean
  fatal: boolean
  detail: string
}

export interface PreflightResult {
  checks: PreflightCheck[]
  passed: boolean
}

// Disk estimates include the artifact plus extraction/runtime headroom.
// When the artifacts are already cached locally only working headroom is needed.
const LLAMA_DISK_GB = 24
const DOCKER_DISK_GB = 45
const CACHED_DISK_GB = 4

async function artifactsCached(tier: RecipeTier, model: Pick<ModelRecipe, "id" | "revision">, directory: string) {
  if (tier.engine === "docker-sglang") {
    const repo = tier.model_hf.replace("/", "--")
    const snapshot = path.join(os.homedir(), ".cache", "huggingface", "hub", `models--${repo}`, "snapshots", tier.model_revision)
    return fs
      .stat(snapshot)
      .then((entry) => entry.isDirectory())
      .catch(() => false)
  }
  if (tier.engine === "llama.cpp") {
    // Must key on this tier's exact target file (matching fetchModelArtifacts'
    // models/<model.id>/<model.revision>/<basename(tier.file)> layout), not
    // "any .gguf anywhere under models/" — otherwise a cached file from a
    // different model or revision falsely discounts the disk-space estimate
    // for the multi-GB download that is about to happen.
    const target = path.join(directory, "models", model.id, model.revision, path.basename(tier.file))
    return fs
      .stat(target)
      .then((entry) => entry.isFile())
      .catch(() => false)
  }
  return false
}

async function freeDiskGb(directory: string, exec: PreflightExec) {
  const probe = async (target: string) => {
    const result = await exec("df", ["-k", target])
    const line = result.stdout.trim().split("\n").at(-1)
    const fields = line?.split(/\s+/) ?? []
    // POSIX df -k: Filesystem 1K-blocks Used Available ...
    const availableKb = Number(fields[3])
    if (!Number.isFinite(availableKb)) throw new Error(`unparseable df output for ${target}`)
    return availableKb / 1024 ** 2
  }
  return probe(directory).catch(() => probe(os.homedir()))
}

async function memAvailableGb(readFile: typeof fs.readFile) {
  const raw = await readFile("/proc/meminfo", "utf8").catch(() => "")
  const match = /MemAvailable:\s+(\d+)\s+kB/.exec(String(raw))
  if (!match) return undefined
  return Number(match[1]) / 1024 ** 2
}

async function vulkanLoaderPresent(exec: PreflightExec) {
  for (const ldconfig of ["ldconfig", "/sbin/ldconfig"]) {
    try {
      const result = await exec(ldconfig, ["-p"])
      return { known: true, present: result.stdout.includes("libvulkan.so.1") }
    } catch {
      // try the next ldconfig location
    }
  }
  return { known: false, present: false }
}

export async function runPreflight(input: {
  tier: RecipeTier
  model: Pick<ModelRecipe, "id" | "revision">
  hardware: HardwareInfo
  availableGb: number
  directory: string
  exec?: PreflightExec
  readFile?: typeof fs.readFile
  platform?: NodeJS.Platform
}): Promise<PreflightResult> {
  const exec = input.exec ?? defaultExec
  const readFile = input.readFile ?? fs.readFile
  const platform = input.platform ?? process.platform
  const checks: PreflightCheck[] = []

  checks.push({
    name: "accelerator_memory",
    ok: input.availableGb >= input.tier.min_vram_gb,
    fatal: true,
    detail: `${input.availableGb.toFixed(1)}GB usable vs ${input.tier.min_vram_gb}GB required by ${input.tier.name}`,
  })

  const cached = await artifactsCached(input.tier, input.model, input.directory)
  const diskNeed = cached ? CACHED_DISK_GB : input.tier.engine === "docker-sglang" ? DOCKER_DISK_GB : LLAMA_DISK_GB
  const diskFree = await freeDiskGb(input.directory, exec).catch(() => undefined)
  checks.push({
    name: "disk_space",
    ok: diskFree === undefined ? true : diskFree >= diskNeed,
    fatal: diskFree !== undefined,
    detail:
      diskFree === undefined
        ? "could not measure free disk space; continuing"
        : `${diskFree.toFixed(0)}GB free vs ~${diskNeed}GB needed${cached ? " (artifacts already cached)" : " for artifacts"}`,
  })

  if (input.tier.engine === "llama.cpp" && platform === "linux") {
    const vulkan = await vulkanLoaderPresent(exec)
    checks.push({
      name: "vulkan_loader",
      ok: !vulkan.known || vulkan.present,
      fatal: vulkan.known,
      detail: vulkan.present
        ? "libvulkan.so.1 found"
        : vulkan.known
          ? "libvulkan.so.1 missing — install your distro's Vulkan loader (e.g. `apt install libvulkan1`) and a GPU driver with a Vulkan ICD"
          : "ldconfig unavailable; skipping Vulkan loader check",
    })
  }

  if (input.tier.engine === "docker-sglang") {
    const daemon = await exec("docker", ["version", "--format", "{{.Server.Version}}"]).catch(() => undefined)
    checks.push({
      name: "docker_daemon",
      ok: daemon !== undefined,
      fatal: true,
      detail: daemon ? `docker server ${daemon.stdout.trim()}` : "docker daemon unreachable — install and start Docker",
    })

    let nvidiaRuntime = false
    if (daemon) {
      const info = await exec("docker", ["info", "--format", "{{json .Runtimes}}"]).catch(() => undefined)
      nvidiaRuntime = info !== undefined && info.stdout.includes("nvidia")
    }
    checks.push({
      name: "nvidia_container_runtime",
      ok: nvidiaRuntime,
      fatal: true,
      detail: nvidiaRuntime
        ? "nvidia runtime registered with docker"
        : "nvidia container runtime missing — install nvidia-container-toolkit and restart docker",
    })

    const available = await memAvailableGb(readFile)
    checks.push({
      name: "free_memory",
      ok: available === undefined || available >= 40,
      fatal: false,
      detail:
        available === undefined
          ? "could not read MemAvailable; continuing"
          : `${available.toFixed(0)}GB available now — model load needs ~40GB; stop other workloads if the server fails to start`,
    })
  }

  return { checks, passed: checks.every((check) => check.ok || !check.fatal) }
}

export function formatPreflight(result: PreflightResult) {
  return result.checks.map((check) => `${check.ok ? "✓" : check.fatal ? "✗" : "!"} ${check.name.replaceAll("_", " ")}: ${check.detail}`)
}
