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

  // Regression: a completed destination file that fails its pinned checksum (disk corruption, an
  // older interrupted downloader that skipped verification, ...) used to be left in place, so a
  // retry hit the same stat+verify and failed identically forever instead of redownloading.
  test("a corrupt completed artifact is deleted and redownloaded instead of getting stuck forever", async () => {
    await using tmp = await tmpdir()
    const destination = path.join(tmp.path, "artifact.gguf")
    await fs.writeFile(destination, "corrupt bytes")
    let calls = 0
    const fetchImpl = async () => {
      calls++
      return new Response("good bytes", { status: 200, headers: { "content-length": "10" } })
    }

    const result = await downloadWithResume({
      url: "https://example.invalid/artifact.gguf",
      destination,
      sha256: sha("good bytes"),
      fetchImpl,
    })
    expect(calls).toBe(1) // redownloaded exactly once, not retried in a loop
    expect(result.resumed).toBe(false)
    expect(await fs.readFile(destination, "utf8")).toBe("good bytes")
  })

  // A repeat mismatch on the redownload must still fail closed (not loop forever) and clean up
  // after itself — same guarantee the existing download path already provides.
  test("a corrupt completed artifact that fails checksum again after redownload still errors and cleans up", async () => {
    await using tmp = await tmpdir()
    const destination = path.join(tmp.path, "artifact.gguf")
    await fs.writeFile(destination, "corrupt bytes")
    const fetchImpl = async () => new Response("still wrong bytes", { status: 200 })

    await expect(
      downloadWithResume({
        url: "https://example.invalid/artifact.gguf",
        destination,
        sha256: sha("expected bytes"),
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(ChecksumMismatchError)
    await expect(fs.stat(destination)).rejects.toThrow()
    await expect(fs.stat(`${destination}.partial`)).rejects.toThrow()
  })

  // A proxy that ignores our Range header but still answers 206 with an
  // absent/mismatched Content-Range must not leave the stale partial in place:
  // every retry would resend the same Range request against the same offset
  // and hit this same failure forever.
  test("an invalid Content-Range on a resumed request clears the partial instead of getting stuck forever", async () => {
    await using tmp = await tmpdir()
    const destination = path.join(tmp.path, "artifact.gguf")
    const partial = `${destination}.partial`
    await fs.writeFile(partial, "hello ")
    const fetchImpl = async () =>
      new Response("ignored", { status: 206, headers: { "content-range": "bytes 0-4/999" } }) // mismatched offset

    await expect(
      downloadWithResume({
        url: "https://example.invalid/artifact.gguf",
        destination,
        sha256: sha("hello world"),
        fetchImpl,
      }),
    ).rejects.toThrow(/invalid Content-Range/)
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
