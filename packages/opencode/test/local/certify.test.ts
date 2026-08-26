import { describe, expect, test } from "bun:test"

import { certificateCacheKey, check, flagsHash } from "../../src/local/certify"

const base = {
  modelSha256: "a".repeat(64),
  runtimeVersion: "llama.cpp b10516",
  flags: ["--ctx-size", "131072", "--parallel", "1"],
}

describe("local certificate cache keying", () => {
  test("is deterministic and sha256-shaped", () => {
    const key = certificateCacheKey(base)
    expect(key).toMatch(/^[a-f0-9]{64}$/)
    expect(certificateCacheKey({ ...base, flags: [...base.flags] })).toBe(key)
  })

  test("changes with model bytes, runtime, or flags", () => {
    const key = certificateCacheKey(base)
    expect(certificateCacheKey({ ...base, modelSha256: "b".repeat(64) })).not.toBe(key)
    expect(certificateCacheKey({ ...base, runtimeVersion: "llama.cpp b10517" })).not.toBe(key)
    expect(certificateCacheKey({ ...base, flags: [...base.flags, "--jinja"] })).not.toBe(key)
  })

  test("flags hash preserves argument order", () => {
    expect(flagsHash(["--ctx-size", "131072"])).not.toBe(flagsHash(["131072", "--ctx-size"]))
  })
})

describe("check", () => {
  test("measures duration across the full awaited run, not just up to the call", async () => {
    const result = await check(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40))
      return "done"
    })
    expect(result.ok).toBe(true)
    expect(result.detail).toBe("done")
    // A regression that computes duration_ms before awaiting `run()` reports
    // near-zero here regardless of the 40ms delay above.
    expect(result.duration_ms).toBeGreaterThanOrEqual(20)
  })

  test("still reports duration on failure", async () => {
    const result = await check(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      throw new Error("boom")
    })
    expect(result.ok).toBe(false)
    expect(result.detail).toBe("boom")
    expect(result.duration_ms).toBeGreaterThanOrEqual(0)
  })
})
