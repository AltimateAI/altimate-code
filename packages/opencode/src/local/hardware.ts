import fs from "node:fs/promises"
import os from "node:os"

import type { ModelRecipe, RecipeTier } from "./recipes"
import { RUNTIME_ASSETS } from "./runtime"

const GIB = 1024 ** 3

export interface HardwareInfo {
  platform: NodeJS.Platform
  arch: string
  name: string
  memoryGb: number
  accelerator: "metal" | "nvidia" | "cpu" | "unknown"
  acceleratorMemoryGb?: number
  unifiedMemory: boolean
}

export interface TierMatch {
  tier?: RecipeTier
  availableGb: number
  reason: string
}

type Run = (command: string[]) => Promise<{ exitCode: number; stdout: string }>

async function run(command: string[]) {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "ignore" })
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
  return { exitCode, stdout }
}

function gb(bytes: number) {
  return Math.round((bytes / GIB) * 10) / 10
}

function parseNvidia(output: string) {
  const rows = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const split = line.lastIndexOf(",")
      if (split < 0) return undefined
      const name = line.slice(0, split).trim()
      if (!name) return undefined
      // DGX Spark (GB10) reports memory.total as [N/A]; keep the GPU with
      // unknown memory instead of discarding it (tier match falls back to
      // system memory, and the GB10 tier matches on name alone).
      const memoryMiB = Number(line.slice(split + 1).trim())
      return { name, memoryMiB: Number.isFinite(memoryMiB) && memoryMiB > 0 ? memoryMiB : undefined }
    })
    .filter((row): row is { name: string; memoryMiB: number | undefined } => Boolean(row))
  if (rows.length === 0) return undefined
  const known = rows.filter((row): row is { name: string; memoryMiB: number } => typeof row.memoryMiB === "number")
  return {
    name: rows.map((row) => row.name).join(" + "),
    memoryGb:
      known.length > 0
        ? Math.round((known.reduce((sum, row) => sum + row.memoryMiB, 0) / 1024) * 10) / 10
        : undefined,
  }
}

function parseMeminfo(input: string) {
  const match = input.match(/^MemTotal:\s+(\d+)\s+kB$/m)
  return match ? gb(Number(match[1]) * 1024) : 0
}

export async function detectHardware(
  options: {
    platform?: NodeJS.Platform
    arch?: string
    run?: Run
    readFile?: (path: string, encoding: BufferEncoding) => Promise<string>
  } = {},
): Promise<HardwareInfo> {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const execute = options.run ?? run
  const readFile = options.readFile ?? ((file, encoding) => fs.readFile(file, encoding))

  if (platform === "darwin") {
    const [memory, brand] = await Promise.all([
      execute(["sysctl", "-n", "hw.memsize"]),
      execute(["sysctl", "-n", "machdep.cpu.brand_string"]),
    ])
    const bytes = Number(memory.stdout.trim())
    if (memory.exitCode !== 0 || !Number.isFinite(bytes) || bytes <= 0) {
      throw new Error("Could not detect macOS memory with sysctl hw.memsize")
    }
    const appleSilicon = arch === "arm64"
    return {
      platform,
      arch,
      name: brand.stdout.trim() || `macOS ${arch}`,
      memoryGb: gb(bytes),
      accelerator: appleSilicon ? "metal" : "unknown",
      acceleratorMemoryGb: appleSilicon ? gb(bytes) : undefined,
      unifiedMemory: appleSilicon,
    }
  }

  if (platform === "linux") {
    const nvidia = await execute([
      "nvidia-smi",
      "--query-gpu=name,memory.total",
      "--format=csv,noheader,nounits",
    ]).catch(() => ({ exitCode: 1, stdout: "" }))
    const gpu = nvidia.exitCode === 0 ? parseNvidia(nvidia.stdout) : undefined
    const meminfo = await readFile("/proc/meminfo", "utf8").catch(() => "")
    const memoryGb = parseMeminfo(meminfo)
    if (gpu) {
      return {
        platform,
        arch,
        name: gpu.name,
        memoryGb,
        accelerator: "nvidia",
        acceleratorMemoryGb: gpu.memoryGb,
        unifiedMemory: false,
      }
    }
    return {
      platform,
      arch,
      name: `Linux ${arch}`,
      memoryGb,
      accelerator: "cpu",
      unifiedMemory: false,
    }
  }

  // No dedicated probe below (e.g. win32): os.totalmem() is a plain Node API
  // that works cross-platform without shelling out, and reports real system
  // RAM instead of the 0 that made every advertised tier unreachable here.
  return {
    platform,
    arch,
    name: `${platform} ${arch}`,
    memoryGb: gb(os.totalmem()),
    accelerator: "unknown",
    unifiedMemory: false,
  }
}

function named(model: ModelRecipe, name: string) {
  return model.tiers.find((tier) => tier.name === name)
}

export function matchHardwareToTier(hardware: HardwareInfo, model: ModelRecipe): TierMatch {
  const availableGb = hardware.unifiedMemory ? hardware.memoryGb : (hardware.acceleratorMemoryGb ?? hardware.memoryGb)

  if (hardware.accelerator === "nvidia" && /\bGB10\b/i.test(hardware.name)) {
    const spark = named(model, "dgx-spark-128gb")
    if (spark) return { tier: spark, availableGb, reason: "DGX Spark (GB10) detected" }
  }

  if (hardware.accelerator === "nvidia" && (hardware.acceleratorMemoryGb ?? 0) >= 80) {
    const tier = named(model, "datacenter-80gb")
    if (tier) return { tier, availableGb, reason: "80GB+ NVIDIA accelerator detected" }
  }

  if (hardware.platform === "darwin" && hardware.arch === "arm64" && hardware.memoryGb >= 64) {
    const tier = named(model, "mac-64gb-unified")
    if (tier) return { tier, availableGb, reason: "64GB+ Apple unified memory detected" }
  }

  if (hardware.accelerator === "nvidia" && !hardware.unifiedMemory) {
    const gpu = named(model, "gpu-24gb-discrete")
    if (gpu && (hardware.acceleratorMemoryGb ?? 0) >= gpu.min_vram_gb) {
      return { tier: gpu, availableGb, reason: "discrete NVIDIA GPU: context sized to fit VRAM alone" }
    }
  }

  const laptop = named(model, "laptop-24gb")
  // The laptop tier's 131K context assumes unified memory; discrete cards that
  // reached here are below the discrete tier's floor and must not inherit it.
  const discreteNvidia = hardware.accelerator === "nvidia" && !hardware.unifiedMemory
  // This is a hardware-only fallback with no platform gate, so it can match
  // platforms llama.cpp has no published runtime for (e.g. Intel macOS):
  // require a RUNTIME_ASSETS entry before letting it proceed to a download.
  const runtimeAvailable =
    laptop?.engine !== "llama.cpp" || Boolean(RUNTIME_ASSETS[`${hardware.platform}-${hardware.arch}`])
  // Treating system RAM as usable accelerator memory only holds when RAM
  // actually IS the accelerator's memory, i.e. Apple Silicon's unified
  // memory (darwin). Without this gate, a Linux host where nvidia-smi found
  // no GPU falls through here reporting accelerator "cpu" — and would still
  // pass on system RAM alone, downloading ~16GB for effectively-unusable CPU
  // inference. AMD/Intel GPUs on Linux aren't detected yet (nvidia-smi is
  // the only probe run today), so they're also excluded here for now; that's
  // a real gap tracked as a roadmap item, not something this fallback should
  // paper over with an untrustworthy RAM guess.
  const unifiedMemoryFallback = hardware.platform === "darwin"
  if (laptop && !discreteNvidia && unifiedMemoryFallback && runtimeAvailable && availableGb >= laptop.min_vram_gb) {
    return { tier: laptop, availableGb, reason: `${availableGb}GB available memory meets the laptop tier` }
  }

  if (laptop && !discreteNvidia && unifiedMemoryFallback && !runtimeAvailable && availableGb >= laptop.min_vram_gb) {
    return {
      availableGb,
      reason: `No Phase 1 llama.cpp runtime is available for ${hardware.platform}-${hardware.arch}`,
    }
  }

  if (laptop && !discreteNvidia && !unifiedMemoryFallback && availableGb >= laptop.min_vram_gb) {
    return {
      availableGb,
      reason: `No confirmed GPU accelerator was detected on ${hardware.platform} (reported "${hardware.accelerator}"); AMD/Intel GPU detection is not implemented yet, so a RAM-only fallback is not offered here to avoid downloading a recipe this host cannot usefully run`,
    }
  }

  return {
    availableGb,
    reason: `The smallest bundled recipe needs ${laptop?.min_vram_gb ?? 20}GB of usable accelerator or unified memory`,
  }
}

export function describeHardware(hardware: HardwareInfo) {
  const memory = hardware.unifiedMemory
    ? `${hardware.memoryGb}GB unified memory`
    : hardware.acceleratorMemoryGb
      ? `${hardware.acceleratorMemoryGb}GB VRAM, ${hardware.memoryGb}GB RAM`
      : `${hardware.memoryGb}GB RAM`
  return `${hardware.name} (${memory})`
}
