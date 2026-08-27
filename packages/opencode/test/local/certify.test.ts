import path from "node:path"
import { describe, expect, test } from "bun:test"

import { tmpdir } from "../fixture/fixture"
import { certificateCacheKey, certify, check, flagsHash } from "../../src/local/certify"
import type { LocalPaths } from "../../src/local/paths"

function testPaths(root: string): LocalPaths {
  return {
    root,
    bin: path.join(root, "bin"),
    models: path.join(root, "models"),
    downloads: path.join(root, "downloads"),
    certificates: path.join(root, "certificates"),
    state: path.join(root, "state.json"),
    pid: path.join(root, "server.pid"),
    log: path.join(root, "server.log"),
    environment: path.join(root, "environment.json"),
    recipes: path.join(root, "recipes.json"),
    recipesMeta: path.join(root, "recipes.meta.json"),
  }
}

// Answers the certify() probe sequence in order: tool_call_round_trip sends
// two requests (the tool call, then the tool-result continuation), followed
// by one request each for reasoning_render and prompt_prefill_8k.
function passingFetchImpl() {
  let call = 0
  return async () => {
    call++
    if (call === 1) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [{ id: "call_1", function: { name: "local_add", arguments: '{"a":2,"b":3}' } }],
              },
            },
          ],
        }),
        { status: 200 },
      )
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 })
  }
}

const base = {
  modelSha256: "a".repeat(64),
  runtimeVersion: "llama.cpp b10516",
  flags: ["--ctx-size", "131072", "--parallel", "1"],
  reasoningEffort: "medium",
  temperature: 1,
}

describe("local certificate cache keying", () => {
  test("is deterministic and sha256-shaped", () => {
    const key = certificateCacheKey(base)
    expect(key).toMatch(/^[a-f0-9]{64}$/)
    expect(certificateCacheKey({ ...base, flags: [...base.flags] })).toBe(key)
  })

  test("changes with model bytes, runtime, flags, reasoning effort, or temperature", () => {
    const key = certificateCacheKey(base)
    expect(certificateCacheKey({ ...base, modelSha256: "b".repeat(64) })).not.toBe(key)
    expect(certificateCacheKey({ ...base, runtimeVersion: "llama.cpp b10517" })).not.toBe(key)
    expect(certificateCacheKey({ ...base, flags: [...base.flags, "--jinja"] })).not.toBe(key)
    // The Docker recipe's `flags` don't encode either of these — without
    // them in the key, a refreshed recipe changing just reasoning effort or
    // temperature would silently reuse a certificate that never ran under
    // the new configuration.
    expect(certificateCacheKey({ ...base, reasoningEffort: "xhigh" })).not.toBe(key)
    expect(certificateCacheKey({ ...base, temperature: 0.5 })).not.toBe(key)
  })

  test("flags hash preserves argument order", () => {
    expect(flagsHash(["--ctx-size", "131072"])).not.toBe(flagsHash(["131072", "--ctx-size"]))
  })
})

describe("certify caching", () => {
  test("certificate_sha256 is unchanged between a fresh run and a cache hit", async () => {
    await using tmp = await tmpdir()
    const paths = testPaths(tmp.path)
    const request = {
      baseURL: "http://127.0.0.1:42625/v1",
      modelID: "test-model",
      modelSha256: "a".repeat(64),
      runtimeVersion: "llama.cpp b10516",
      flags: ["--ctx-size", "131072"],
      reasoningEffort: "medium",
      temperature: 1,
      paths,
    }

    const fresh = await certify({ ...request, fetchImpl: passingFetchImpl() })
    expect(fresh.passed).toBe(true)
    expect(fresh.cached).toBe(false)

    // No fetchImpl calls should happen on the cache-hit path — if this throws,
    // the cache was not honored.
    const cached = await certify({
      ...request,
      fetchImpl: async () => {
        throw new Error("must not probe again on a cache hit")
      },
    })
    expect(cached.cached).toBe(true)
    // The whole point: a consumer that validates the digest against the
    // returned object must accept both a fresh result and a cached one. If
    // `cached` were part of the signed payload, these would differ.
    expect(cached.certificate_sha256).toBe(fresh.certificate_sha256)
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
