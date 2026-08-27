import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect, test } from "bun:test"

import { tmpdir } from "../fixture/fixture"
import { runPreflight } from "../../src/local/preflight"
import { BUNDLED_RECIPES, type LlamaRecipeTier } from "../../src/local/recipes"
import type { HardwareInfo } from "../../src/local/hardware"

const model = BUNDLED_RECIPES.models[0]!
const llamaTier = model.tiers.find((tier) => tier.name === "gpu-24gb-discrete")! as LlamaRecipeTier
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
// ~10GB free: enough for the "already cached" 4GB estimate but not the ~24GB
// fresh-download estimate, so these two outcomes are distinguishable.
const DF_10GB = { stdout: "Filesystem 1K-blocks Used Available Use% Mounted\n/dev/sda1 999999999 1 10485760 1% /\n", stderr: "" }
const VULKAN_OK = { stdout: "libvulkan.so.1 (libc6,x86-64) => /lib/libvulkan.so.1\n", stderr: "" }

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
      model: { id: model.id, revision: model.revision },
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
      model: { id: model.id, revision: model.revision },
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
      model: { id: model.id, revision: model.revision },
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
      model: { id: model.id, revision: model.revision },
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
      model: { id: model.id, revision: model.revision },
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
      model: { id: model.id, revision: model.revision },
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

  test("a cached gguf from a different model/revision does not discount the disk estimate", async () => {
    await using tmp = await tmpdir()
    // A .gguf exists on disk, but for an unrelated model/revision — not the
    // one this tier is about to download.
    const other = path.join(tmp.path, "models", "some-other-model", "deadbeef", "other.gguf")
    await fs.mkdir(path.dirname(other), { recursive: true })
    await fs.writeFile(other, "not the target artifact")

    const result = await runPreflight({
      tier: llamaTier,
      model: { id: model.id, revision: model.revision },
      hardware: nvidia,
      availableGb: 22.5,
      directory: tmp.path,
      platform: "linux",
      exec: exec({ df: DF_10GB, ldconfig: VULKAN_OK }),
    })
    const disk = result.checks.find((check) => check.name === "disk_space")!
    expect(disk.detail).not.toContain("already cached")
    expect(disk.ok).toBe(false)
  })

  test("the exact target gguf being cached discounts the disk estimate", async () => {
    await using tmp = await tmpdir()
    const target = path.join(tmp.path, "models", model.id, model.revision, path.basename(llamaTier.file))
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, "the target artifact")

    const result = await runPreflight({
      tier: llamaTier,
      model: { id: model.id, revision: model.revision },
      hardware: nvidia,
      availableGb: 22.5,
      directory: tmp.path,
      platform: "linux",
      exec: exec({ df: DF_10GB, ldconfig: VULKAN_OK }),
    })
    const disk = result.checks.find((check) => check.name === "disk_space")!
    expect(disk.detail).toContain("already cached")
    expect(disk.ok).toBe(true)
  })

  test("docker tier: cached HF weights alone do not discount the estimate when the SGLang image is missing", async () => {
    await using tmp = await tmpdir()
    if (dockerTier.engine !== "docker-sglang") throw new Error("expected docker tier fixture")
    const home = tmp.path
    const repo = dockerTier.model_hf.replace("/", "--")
    const snapshot = path.join(home, ".cache", "huggingface", "hub", `models--${repo}`, "snapshots", dockerTier.model_revision)
    await fs.mkdir(snapshot, { recursive: true })

    const result = await runPreflight({
      tier: dockerTier,
      model: { id: model.id, revision: model.revision },
      hardware: spark,
      availableGb: 119,
      directory: tmp.path,
      platform: "linux",
      home,
      exec: exec({
        df: DF_10GB, // enough for the "cached" 4GB floor but not the ~45GB fresh-download estimate
        "docker version": { stdout: "27.1.1\n", stderr: "" },
        "docker info": { stdout: '{"nvidia":{"path":"nvidia-container-runtime"}}\n', stderr: "" },
        "docker image inspect": new Error("no such image"), // weights cached, but the image was never pulled
      }),
      readFile: (async () => "MemAvailable: 41943040 kB\n") as never,
    })
    const disk = result.checks.find((check) => check.name === "disk_space")!
    expect(disk.detail).not.toContain("already cached")
    expect(disk.ok).toBe(false)
  })

  test("docker tier: HF weights and the SGLang image both cached discounts the estimate", async () => {
    await using tmp = await tmpdir()
    if (dockerTier.engine !== "docker-sglang") throw new Error("expected docker tier fixture")
    const home = tmp.path
    const repo = dockerTier.model_hf.replace("/", "--")
    const snapshot = path.join(home, ".cache", "huggingface", "hub", `models--${repo}`, "snapshots", dockerTier.model_revision)
    await fs.mkdir(snapshot, { recursive: true })

    const result = await runPreflight({
      tier: dockerTier,
      model: { id: model.id, revision: model.revision },
      hardware: spark,
      availableGb: 119,
      directory: tmp.path,
      platform: "linux",
      home,
      exec: exec({
        df: DF_10GB,
        "docker version": { stdout: "27.1.1\n", stderr: "" },
        "docker info": { stdout: '{"nvidia":{"path":"nvidia-container-runtime"}}\n', stderr: "" },
        "docker image inspect": { stdout: "sha256:deadbeef\n", stderr: "" },
      }),
      readFile: (async () => "MemAvailable: 41943040 kB\n") as never,
    })
    const disk = result.checks.find((check) => check.name === "disk_space")!
    expect(disk.detail).toContain("already cached")
    expect(disk.ok).toBe(true)
  })
})
