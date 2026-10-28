import { describe, expect, test } from "bun:test"
import { retryParseManifest } from "../src/manifest-retry"

function source(results: Array<unknown | undefined>) {
  let calls = 0
  return {
    get calls() {
      return calls
    },
    parseManifest: async () => results[Math.min(calls++, results.length - 1)] as { nodes: number } | undefined,
  }
}

describe("retryParseManifest", () => {
  test("a manifest that is whole on the first read is read once", async () => {
    const s = source([{ nodes: 1 }])
    retryParseManifest(s, { baseDelayMs: 1 })
    expect(await s.parseManifest()).toEqual({ nodes: 1 })
    expect(s.calls).toBe(1)
  })

  test("a manifest caught mid-rewrite is read again until it is whole", async () => {
    const s = source([undefined, undefined, { nodes: 2 }])
    retryParseManifest(s, { baseDelayMs: 1 })
    expect(await s.parseManifest()).toEqual({ nodes: 2 })
    expect(s.calls).toBe(3)
  })

  test("gives up after the attempt limit and reports the absence", async () => {
    const s = source([undefined])
    retryParseManifest(s, { attempts: 4, baseDelayMs: 1 })
    expect(await s.parseManifest()).toBeUndefined()
    expect(s.calls).toBe(4)
  })
})
