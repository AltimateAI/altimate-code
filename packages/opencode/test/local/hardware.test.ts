import { describe, expect, test } from "bun:test"

import { detectHardware, matchHardwareToTier, type HardwareInfo } from "../../src/local/hardware"
import { BUNDLED_RECIPES, firstModel } from "../../src/local/recipes"

const model = firstModel(BUNDLED_RECIPES)

function hardware(input: Partial<HardwareInfo>): HardwareInfo {
  return {
    platform: "linux",
    arch: "x64",
    name: "test machine",
    memoryGb: 32,
    accelerator: "cpu",
    unifiedMemory: false,
    ...input,
  }
}

describe("local hardware tier matching", () => {
  test("routes a discrete 24GB NVIDIA card to the VRAM-fitted tier", () => {
    const match = matchHardwareToTier(hardware({ accelerator: "nvidia", acceleratorMemoryGb: 24 }), model)
    expect(match.tier?.name).toBe("gpu-24gb-discrete")
  })

  test("matches a 24GB unified-memory laptop to the laptop tier", () => {
    const match = matchHardwareToTier(hardware({ memoryGb: 24, unifiedMemory: true, accelerator: "metal" }), model)
    expect(match.tier?.name).toBe("laptop-24gb")
  })

  test("discrete 16GB NVIDIA card gets no tier (below discrete floor)", () => {
    const match = matchHardwareToTier(hardware({ accelerator: "nvidia", acceleratorMemoryGb: 16, memoryGb: 16 }), model)
    expect(match.tier).toBeUndefined()
  })

  test("detects GB10 with [N/A] memory as an NVIDIA accelerator and matches the DGX tier", async () => {
    const detected = await detectHardware({
      platform: "linux",
      arch: "arm64",
      run: async (argv: string[]) =>
        argv[0] === "nvidia-smi"
          ? { exitCode: 0, stdout: "NVIDIA GB10, [N/A]\n" }
          : { exitCode: 1, stdout: "" },
      readFile: async () => "MemTotal: 125829120 kB\n",
    })
    expect(detected.accelerator).toBe("nvidia")
    expect(detected.name).toBe("NVIDIA GB10")
    expect(detected.acceleratorMemoryGb).toBeUndefined()
    const match = matchHardwareToTier(detected, model)
    expect(match.tier?.name).toBe("dgx-spark-128gb")
  })

  test("routes DGX Spark (GB10) to its guidance tier", () => {
    const match = matchHardwareToTier(
      hardware({ accelerator: "nvidia", name: "NVIDIA GB10", acceleratorMemoryGb: 119, memoryGb: 119 }),
      model,
    )
    expect(match.tier?.name).toBe("dgx-spark-128gb")
  })

  test("prefers the unified-memory recipe on a 64GB Apple Silicon Mac", () => {
    const match = matchHardwareToTier(
      hardware({
        platform: "darwin",
        arch: "arm64",
        memoryGb: 64,
        accelerator: "metal",
        acceleratorMemoryGb: 64,
        unifiedMemory: true,
      }),
      model,
    )
    expect(match.tier?.name).toBe("mac-64gb-unified")
  })

  test("returns the datacenter guidance stub for an 80GB NVIDIA GPU", () => {
    const match = matchHardwareToTier(hardware({ accelerator: "nvidia", acceleratorMemoryGb: 80 }), model)
    expect(match.tier?.name).toBe("datacenter-80gb")
    expect(match.tier?.engine).toBe("vllm")
  })

  test("falls back to system memory when no GPU probe succeeds", () => {
    const match = matchHardwareToTier(hardware({ memoryGb: 32 }), model)
    expect(match.tier?.name).toBe("laptop-24gb")
  })

  test("returns no match below the minimum", () => {
    const match = matchHardwareToTier(hardware({ memoryGb: 16 }), model)
    expect(match.tier).toBeUndefined()
    expect(match.reason).toContain("20GB")
  })

  test("refuses the laptop fallback on a platform-arch with no published llama.cpp runtime", () => {
    // Intel macOS has enough memory to clear the laptop tier's floor but
    // RUNTIME_ASSETS only ships darwin-arm64 — must not match a tier whose
    // runtime can never be installed.
    const match = matchHardwareToTier(hardware({ platform: "darwin", arch: "x64", memoryGb: 32 }), model)
    expect(match.tier).toBeUndefined()
    expect(match.reason).toContain("darwin-x64")
  })
})
