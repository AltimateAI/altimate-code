import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect, test } from "bun:test"

import { tmpdir } from "../fixture/fixture"
import {
  ChecksumMismatchError,
  MissingChecksumError,
  downloadWithResume,
  sha256File,
  verifySha256,
} from "../../src/local/fetch"

const sha = (value: string) => createHash("sha256").update(value).digest("hex")

describe("local artifact sha256 verification", () => {
  test("hashes and verifies a temporary file", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "artifact.gguf")
    await fs.writeFile(file, "verified bytes")
    expect(await sha256File(file)).toBe(sha("verified bytes"))
    await expect(verifySha256(file, sha("verified bytes"))).resolves.toBe(sha("verified bytes"))
  })

  test("refuses a checksum mismatch", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "artifact.gguf")
    await fs.writeFile(file, "wrong bytes")
    await expect(verifySha256(file, sha("expected bytes"))).rejects.toBeInstanceOf(ChecksumMismatchError)
  })

  test("fails closed on a TODO checksum", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "artifact.gguf")
    await fs.writeFile(file, "bytes")
    await expect(verifySha256(file, "TODO_MODEL_SHA256")).rejects.toBeInstanceOf(MissingChecksumError)
  })

  test("resumes with HTTP Range using a mocked response", async () => {
    await using tmp = await tmpdir()
    const destination = path.join(tmp.path, "artifact.gguf")
    await fs.writeFile(`${destination}.partial`, "hello ")
    let calls = 0
    const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
      calls++
      expect(new Headers(init?.headers).get("range")).toBe("bytes=6-")
      return new Response("world", {
        status: 206,
        headers: { "content-range": "bytes 6-10/11", "content-length": "5" },
      })
    }
    const result = await downloadWithResume({
      url: "https://example.invalid/artifact.gguf",
      destination,
      sha256: sha("hello world"),
      fetchImpl,
    })
    expect(calls).toBe(1)
    expect(result.resumed).toBe(true)
    expect(await fs.readFile(destination, "utf8")).toBe("hello world")
  })

  test("a checksum mismatch after HTTP 416 deletes the stale partial instead of getting stuck forever", async () => {
    await using tmp = await tmpdir()
    const destination = path.join(tmp.path, "artifact.gguf")
    const partial = `${destination}.partial`
    await fs.writeFile(partial, "stale wrong bytes")
    const fetchImpl = async () => new Response(null, { status: 416 })

    await expect(
      downloadWithResume({
        url: "https://example.invalid/artifact.gguf",
        destination,
        sha256: sha("expected different bytes"),
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(ChecksumMismatchError)
    // Without cleanup, a retry resumes from the same offset, gets 416 again,
    // and fails identically forever.
    await expect(fs.stat(partial)).rejects.toThrow()
  })

  test("a response with no Content-Length reports an unknown total instead of coercing it to 0", async () => {
    await using tmp = await tmpdir()
    const destination = path.join(tmp.path, "artifact.gguf")
    const progress: Array<{ received: number; total?: number }> = []
    const fetchImpl = async () => new Response("hello world", { status: 200 }) // deliberately no content-length

    const result = await downloadWithResume({
      url: "https://example.invalid/artifact.gguf",
      destination,
      sha256: sha("hello world"),
      fetchImpl,
      onProgress: (progressUpdate) => progress.push(progressUpdate),
    })
    expect(result.bytes).toBe("hello world".length)
    expect(progress.length).toBeGreaterThan(0)
    expect(progress.every((p) => p.total === undefined)).toBe(true)
  })
})
