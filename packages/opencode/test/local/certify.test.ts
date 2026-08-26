import { describe, expect, test } from "bun:test"

import { certificateCacheKey, flagsHash } from "../../src/local/certify"

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
