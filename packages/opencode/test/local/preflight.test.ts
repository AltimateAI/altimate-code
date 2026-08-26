import { describe, expect, test } from "bun:test"

import { runPreflight } from "../../src/local/preflight"
import { BUNDLED_RECIPES } from "../../src/local/recipes"
import type { HardwareInfo } from "../../src/local/hardware"

const model = BUNDLED_RECIPES.models[0]!
const llamaTier = model.tiers.find((tier) => tier.name === "gpu-24gb-discrete")!
const dockerTier = model.tiers.find((tier) => tier.name === "dgx-spark-128gb")!

const nvidia: HardwareInfo = {
  platform: "linux",
  arch: "x64",
  name: "NVIDIA L4",
  memoryGb: 31,
  accelerator: "nvidia",
  acceleratorMemoryGb: 22.5,
  unifiedMemory: false,
}

const spark: HardwareInfo = {
  platform: "linux",
  arch: "arm64",
  name: "NVIDIA GB10",
  memoryGb: 119,
  accelerator: "nvidia",
  unifiedMemory: false,
}

const DF_OK = { stdout: "Filesystem 1K-blocks Used Available Use% Mounted\n/dev/sda1 999999999 1 524288000 1% /\n", stderr: "" }
const DF_FULL = { stdout: "Filesystem 1K-blocks Used Available Use% Mounted\n/dev/sda1 999999999 1 1048576 1% /\n", stderr: "" }

function exec(table: Record<string, { stdout: string; stderr: string } | Error>) {
  return async (file: string, args: string[]) => {
    const key = [file, ...args].join(" ")
    for (const [prefix, result] of Object.entries(table)) {
      if (key.startsWith(prefix)) {
        if (result instanceof Error) throw result
        return result
      }
    }
    throw new Error(`unexpected exec: ${key}`)
  }
}

describe("runPreflight", () => {
  test("llama tier on linux fails fatally without the Vulkan loader", async () => {
    const result = await runPreflight({
      tier: llamaTier,
      hardware: nvidia,
      availableGb: 22.5,
      directory: "/tmp",
      platform: "linux",
      exec: exec({ df: DF_OK, ldconfig: { stdout: "libc.so.6 => /lib/libc.so.6\n", stderr: "" } }),
    })
    expect(result.passed).toBe(false)
    const vulkan = result.checks.find((check) => check.name === "vulkan_loader")!
    expect(vulkan.ok).toBe(false)
    expect(vulkan.fatal).toBe(true)
    expect(vulkan.detail).toContain("libvulkan1")
  })

  test("llama tier passes with loader present and enough disk", async () => {
    const result = await runPreflight({
      tier: llamaTier,
      hardware: nvidia,
      availableGb: 22.5,
      directory: "/tmp",
      platform: "linux",
      exec: exec({ df: DF_OK, ldconfig: { stdout: "libvulkan.so.1 (libc6,x86-64) => /lib/libvulkan.so.1\n", stderr: "" } }),
    })
    expect(result.passed).toBe(true)
  })

  test("insufficient disk is fatal before any download", async () => {
    const result = await runPreflight({
      tier: llamaTier,
      hardware: nvidia,
      availableGb: 22.5,
      directory: "/tmp",
      platform: "darwin",
      exec: exec({ df: DF_FULL }),
    })
    expect(result.passed).toBe(false)
    expect(result.checks.find((check) => check.name === "disk_space")!.ok).toBe(false)
  })

  test("docker tier fails fatally when the daemon is unreachable", async () => {
    const result = await runPreflight({
      tier: dockerTier,
      hardware: spark,
      availableGb: 119,
      directory: "/tmp",
      platform: "linux",
      exec: exec({ df: DF_OK, docker: new Error("no daemon") }),
      readFile: (async () => "MemAvailable: 104857600 kB\n") as never,
    })
    expect(result.passed).toBe(false)
    expect(result.checks.find((check) => check.name === "docker_daemon")!.ok).toBe(false)
    expect(result.checks.find((check) => check.name === "nvidia_container_runtime")!.ok).toBe(false)
  })

  test("docker tier passes with nvidia runtime; low free memory is a warning only", async () => {
    const result = await runPreflight({
      tier: dockerTier,
      hardware: spark,
      availableGb: 119,
      directory: "/tmp",
      platform: "linux",
      exec: exec({
        df: DF_OK,
        "docker version": { stdout: "27.1.1\n", stderr: "" },
        "docker info": { stdout: '{"nvidia":{"path":"nvidia-container-runtime"}}\n', stderr: "" },
      }),
      readFile: (async () => "MemAvailable: 12582912 kB\n") as never,
    })
    expect(result.passed).toBe(true)
    const memory = result.checks.find((check) => check.name === "free_memory")!
    expect(memory.ok).toBe(false)
    expect(memory.fatal).toBe(false)
  })

  test("capacity below the tier floor is fatal", async () => {
    const result = await runPreflight({
      tier: dockerTier,
      hardware: { ...spark, memoryGb: 64 },
      availableGb: 64,
      directory: "/tmp",
      platform: "linux",
      exec: exec({
        df: DF_OK,
        "docker version": { stdout: "27.1.1\n", stderr: "" },
        "docker info": { stdout: '{"nvidia":{}}\n', stderr: "" },
      }),
      readFile: (async () => "MemAvailable: 41943040 kB\n") as never,
    })
    expect(result.passed).toBe(false)
    expect(result.checks.find((check) => check.name === "accelerator_memory")!.ok).toBe(false)
  })
})
