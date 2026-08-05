import { describe, expect, test } from "bun:test"
import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from "@zip.js/zip.js"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { FSUtil } from "../src/fs-util"
import { RipgrepBinary } from "../src/ripgrep/binary"

// Regression coverage for the Windows `grep` outage: ripgrep's Windows zip was extracted by
// shelling out to `powershell.exe -Command Expand-Archive`. When PowerShell did not resolve,
// cross-spawn re-spawned through cmd.exe, whose "is not recognized as an internal or external
// command" reply became the thrown error verbatim — and because RipgrepBinary.filepath is
// Effect.cached, one failed extraction broke grep for the rest of the session.
// Extraction must stay in-process: no spawn, no external tool.

async function zipWith(
  entries: Array<{ name: string; body: Uint8Array | string }>,
  options?: { level?: number },
): Promise<ArrayBuffer> {
  const writer = new ZipWriter(new BlobWriter("application/zip"))
  for (const entry of entries) {
    await writer.add(
      entry.name,
      typeof entry.body === "string" ? new TextReader(entry.body) : new Uint8ArrayReader(entry.body),
      options,
    )
  }
  const blob = await writer.close()
  return blob.arrayBuffer()
}

/** Index of `needle` within `haystack`, or -1. */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect as Effect.Effect<A, E, never>)

describe("RipgrepBinary.unzipExecutable", () => {
  test("extracts rg.exe from the nested release layout", async () => {
    const payload = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03])
    const zip = await zipWith([
      { name: "ripgrep-15.1.0-x86_64-pc-windows-msvc/doc/README.md", body: "docs" },
      { name: "ripgrep-15.1.0-x86_64-pc-windows-msvc/rg.exe", body: payload },
    ])

    const result = await run(RipgrepBinary.unzipExecutable(zip))

    expect(Array.from(result)).toEqual(Array.from(payload))
  })

  test("accepts a flattened archive with rg.exe at the root", async () => {
    const payload = new Uint8Array([1, 2, 3, 4])
    const zip = await zipWith([{ name: "rg.exe", body: payload }])

    const result = await run(RipgrepBinary.unzipExecutable(zip))

    expect(Array.from(result)).toEqual(Array.from(payload))
  })

  test("does not mistake a similarly-named file for the executable", async () => {
    const zip = await zipWith([
      { name: "ripgrep-15.1.0-x86_64-pc-windows-msvc/rg.exe.sig", body: "signature" },
      { name: "ripgrep-15.1.0-x86_64-pc-windows-msvc/notrg.exe", body: new Uint8Array([9, 9]) },
      { name: "ripgrep-15.1.0-x86_64-pc-windows-msvc/rg.exe", body: new Uint8Array([7, 7]) },
    ])

    const result = await run(RipgrepBinary.unzipExecutable(zip))

    expect(Array.from(result)).toEqual([7, 7])
  })

  test("fails with a named error when the archive has no rg.exe", async () => {
    const zip = await zipWith([{ name: "ripgrep-15.1.0-x86_64-pc-windows-msvc/README.md", body: "nope" }])

    const exit = await run(Effect.result(RipgrepBinary.unzipExecutable(zip)))

    expect(exit._tag).toBe("Failure")
    expect(String((exit as { failure: Error }).failure.message)).toContain("did not contain rg.exe")
  })

  test("rejects an empty rg.exe rather than writing a zero-byte binary", async () => {
    const zip = await zipWith([{ name: "rg.exe", body: new Uint8Array(0) }])

    const exit = await run(Effect.result(RipgrepBinary.unzipExecutable(zip)))

    expect(exit._tag).toBe("Failure")
    expect(String((exit as { failure: Error }).failure.message)).toContain("empty rg.exe")
  })

  test("rejects a CRC-corrupt entry instead of persisting a broken binary", async () => {
    // Without checkSignature, zip.js decodes corrupt data "successfully"; those bytes get written
    // to Global.Path.bin and trusted by every later session, breaking grep until the cache is cleared.
    const payload = new Uint8Array([0xca, 0xfe, 0xba, 0xbe, 0xde, 0xad, 0xbe, 0xef, 0x11, 0x22, 0x33, 0x44])
    // level 0 stores the payload verbatim, so it can be located and corrupted precisely.
    const zip = await zipWith([{ name: "rg.exe", body: payload }], { level: 0 })
    const bytes = new Uint8Array(zip)
    const at = indexOfBytes(bytes, payload)
    expect(at).toBeGreaterThan(-1)
    bytes[at + 3] ^= 0xff

    const exit = await run(Effect.result(RipgrepBinary.unzipExecutable(bytes.buffer)))

    expect(exit._tag).toBe("Failure")
  })

  test("surfaces a decode failure as a typed error rather than throwing raw", async () => {
    const garbage = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]).buffer

    const exit = await run(Effect.result(RipgrepBinary.unzipExecutable(garbage)))

    expect(exit._tag).toBe("Failure")
  })
})

// Serial: `asWindows` redefines `process.platform` and `process.arch` process-wide, so a
// concurrently-running test would observe the wrong platform.
describe.serial("RipgrepBinary.filepath — Windows install path", () => {
  /** Pretend to be 64-bit Windows so `filepath` selects the zip platform entry. */
  const asWindows = async <T>(fn: () => Promise<T>): Promise<T> => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!
    const arch = Object.getOwnPropertyDescriptor(process, "arch")!
    Object.defineProperty(process, "platform", { value: "win32", configurable: true })
    Object.defineProperty(process, "arch", { value: "x64", configurable: true })
    try {
      return await fn()
    } finally {
      Object.defineProperty(process, "platform", platform)
      Object.defineProperty(process, "arch", arch)
    }
  }

  /** Minimal FSUtil recording what the install path does. Only the methods `filepath` uses. */
  function fsStub() {
    const writes = new Map<string, Uint8Array>()
    const renames: Array<[string, string]> = []
    const removed: string[] = []
    const service = {
      isFile: () => Effect.succeed(false),
      ensureDir: () => Effect.void,
      writeWithDirs: (p: string, content: Uint8Array) =>
        Effect.sync(() => {
          writes.set(p, content)
        }),
      rename: (from: string, to: string) =>
        Effect.sync(() => {
          renames.push([from, to])
          const body = writes.get(from)
          if (body) {
            writes.delete(from)
            writes.set(to, body)
          }
        }),
      remove: (p: string) =>
        Effect.sync(() => {
          removed.push(p)
        }),
      chmod: () => Effect.void,
      copyFile: () => Effect.void,
      makeTempDirectoryScoped: () => Effect.succeed("/tmp/unused"),
    }
    return { writes, renames, removed, layer: Layer.succeed(FSUtil.Service)(service as never) }
  }

  /** A spawner that fails the test if anything tries to launch a process. */
  function spawnerStub(onSpawn: (cmd: string) => void) {
    return Layer.succeed(ChildProcessSpawner)({
      spawn: (command: any) =>
        Effect.sync(() => {
          onSpawn(String(command?.command ?? command))
          throw new Error("spawn must not be called")
        }),
    } as never)
  }

  function httpStub(body: ArrayBuffer) {
    return Layer.succeed(HttpClient.HttpClient)(
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status: 200 }))),
      ),
    )
  }

  test("extracts and installs rg.exe with no process spawn, via a temp file it renames", async () => {
    const payload = new Uint8Array([0x4d, 0x5a, 0x42, 0x43])
    const zip = await zipWith([{ name: "ripgrep-15.1.0-x86_64-pc-windows-msvc/rg.exe", body: payload }])

    const spawned: string[] = []
    const fs = fsStub()

    const resolved = await asWindows(() =>
      Effect.runPromise(
        Effect.gen(function* () {
          const binary = yield* RipgrepBinary.Service
          return yield* binary.filepath
        }).pipe(
          Effect.provide(
            RipgrepBinary.layer.pipe(
              Layer.provide(fs.layer),
              Layer.provide(httpStub(zip)),
              Layer.provide(spawnerStub((c) => spawned.push(c))),
            ),
          ),
        ) as Effect.Effect<string, unknown, never>,
      ),
    )

    // The whole point of the fix: the Windows zip path must not shell out.
    expect(spawned).toEqual([])
    expect(resolved.endsWith("rg.exe")).toBe(true)
    // Installed atomically: written to a staging path, then renamed onto the target.
    expect(fs.renames.length).toBe(1)
    const [staged, published] = fs.renames[0]!
    expect(published).toBe(resolved)
    expect(staged.startsWith(`${resolved}.`)).toBe(true)
    expect(staged.endsWith(".tmp")).toBe(true)
    // Unique per attempt — a shared `${target}.tmp` lets concurrent cold-cache processes
    // publish each other's partial downloads.
    expect(staged).not.toBe(`${resolved}.tmp`)
    expect(staged).toContain(`.${process.pid}.`)
    expect(Array.from(fs.writes.get(resolved) ?? [])).toEqual(Array.from(payload))
  })
})
