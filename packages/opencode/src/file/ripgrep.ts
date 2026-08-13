// altimate_change start — restore the fork's async-generator Ripgrep namespace
// (files/tree/search/Match/filepath). Upstream v1.17.9 moved ripgrep to an
// Effect Service (find/glob/grep) in @opencode-ai/core/ripgrep, but our tools
// (tool/ls, tool/glob, tool/skill, file/index, session/system, server/routes/file)
// consume the old Promise/async-generator API. This shim re-implements that API
// over the same `rg` binary download/lookup so those callers keep working without
// an Effect-context rewrite.
// Ripgrep utility functions
import path from "path"
import { Global } from "../global"
import fs from "fs/promises"
import z from "zod"
import { NamedError } from "@opencode-ai/util/error"
import { lazy } from "../util/lazy"

import { Filesystem } from "../util/filesystem"
import { Process } from "../util/process"
import { which } from "../util/which"
import { text } from "node:stream/consumers"

import { ZipReader, BlobReader, BlobWriter } from "@zip.js/zip.js"
import { Log } from "@/util/log"

export namespace Ripgrep {
  const log = Log.create({ service: "ripgrep" })
  const Stats = z.object({
    elapsed: z.object({
      secs: z.number(),
      nanos: z.number(),
      human: z.string(),
    }),
    searches: z.number(),
    searches_with_match: z.number(),
    bytes_searched: z.number(),
    bytes_printed: z.number(),
    matched_lines: z.number(),
    matches: z.number(),
  })

  const Begin = z.object({
    type: z.literal("begin"),
    data: z.object({
      path: z.object({
        text: z.string(),
      }),
    }),
  })

  export const Match = z.object({
    type: z.literal("match"),
    data: z.object({
      path: z.object({
        text: z.string(),
      }),
      lines: z.object({
        text: z.string(),
      }),
      line_number: z.number(),
      absolute_offset: z.number(),
      submatches: z.array(
        z.object({
          match: z.object({
            text: z.string(),
          }),
          start: z.number(),
          end: z.number(),
        }),
      ),
    }),
  })

  const End = z.object({
    type: z.literal("end"),
    data: z.object({
      path: z.object({
        text: z.string(),
      }),
      binary_offset: z.number().nullable(),
      stats: Stats,
    }),
  })

  const Summary = z.object({
    type: z.literal("summary"),
    data: z.object({
      elapsed_total: z.object({
        human: z.string(),
        nanos: z.number(),
        secs: z.number(),
      }),
      stats: Stats,
    }),
  })

  const Result = z.union([Begin, Match, End, Summary])

  // altimate_change start — upstream_fix: tolerate ripgrep's `{bytes}` arm and malformed lines.
  //
  // This mirrors packages/core/src/ripgrep.ts, but deliberately not in every respect. That parser
  // streams, so it caps the retained line text and rebases submatch offsets; this one buffers all of
  // stdout up front and hands its records straight to the `/find` response, where the raw ripgrep
  // shape is the published contract — so it normalises and skips, and leaves the shape alone. Both
  // report skipped records once per search rather than once per record.
  const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

  /** Mirrors packages/core/src/ripgrep.ts. Bounds parse cost per record on this path too. */
  const MAX_RECORD_BYTES = 16 * 1024 * 1024

  /** Parse one NDJSON record, rewriting `{bytes: base64}` fields into the `{text}` arm. */
  const normalizeRecord = (line: string): unknown => {
    let json: unknown
    try {
      json = JSON.parse(line)
    } catch {
      return undefined
    }
    if (!json || typeof json !== "object") return json
    const read = (value: unknown, key: string): unknown =>
      value !== null && typeof value === "object" && key in value ? Reflect.get(value, key) : undefined
    const data = read(json, "data")
    if (!data || typeof data !== "object") return json
    /** Decode a `{text}`/`{bytes}` field, returning the raw buffer so offsets can be rebased. */
    const decode = (value: unknown): { text: string; raw?: Buffer } | undefined => {
      if (!value || typeof value !== "object") return undefined
      const text = read(value, "text")
      if (typeof text === "string") return { text }
      const bytes = read(value, "bytes")
      // Guarded three ways because `Buffer.from` decodes unconvertible input to an EMPTY buffer
      // instead of throwing, which would turn a corrupt record into a schema-valid empty match:
      // reject the empty string (a matched line is never empty), check the spelling, then require
      // a round-trip so non-canonical padding ("Zh==" and "Zg==" both decode to "f") is rejected.
      if (typeof bytes !== "string" || bytes.length === 0 || !BASE64.test(bytes)) return undefined
      const decoded = Buffer.from(bytes, "base64")
      if (decoded.toString("base64") !== bytes) return undefined
      return { text: decoded.toString("utf8"), raw: decoded }
    }
    const lines = "lines" in data ? decode(read(data, "lines")) : undefined
    // Submatch offsets are BYTE offsets into the RAW line, and a lossy decode widens every
    // undecodable byte to a 3-byte U+FFFD — so they must be rebased onto the decoded text's own
    // UTF-8 encoding or they no longer locate the match. This response shape is published by the
    // `/find` route, so unrebased offsets would be newly wrong output rather than a skipped record.
    // Mirrors packages/core/src/ripgrep.ts.
    const raw = lines?.raw
    // Only rebase an offset addressable in the raw line: `Buffer.subarray` clamps an out-of-range
    // end and truncates a fractional one rather than throwing, so an unchecked rebase would quietly
    // repair a corrupt offset, and the schema would not catch it (`z.number()` accepts any number).
    // An unaddressable offset marks the record corrupt so it is skipped and counted instead.
    let corrupt = false
    const rebase = (offset: unknown): unknown => {
      if (!raw) return offset
      if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0 || offset > raw.length) {
        corrupt = true
        return offset
      }
      return Buffer.byteLength(raw.subarray(0, offset).toString("utf8"), "utf8")
    }
    const submatches = read(data, "submatches")
    // Only rewrite keys the record actually carries — `begin`/`end`/`summary` records reach here too
    // and must keep their exact shape, or the strict union below would reject them.
    // `path` is deliberately left alone: decoding it is lossy, and a path is an identifier the
    // caller reopens, so a U+FFFD-mangled path names a file that does not exist. Such a record
    // stays in the `{bytes}` arm and is skipped. See packages/core/src/ripgrep.ts.
    const normalized = {
      ...json,
      data: {
        ...data,
        ...(lines ? { lines: { text: lines.text } } : {}),
        ...(Array.isArray(submatches)
          ? {
              submatches: submatches.map((submatch) => {
                if (!submatch || typeof submatch !== "object") return submatch
                const match = decode(read(submatch, "match"))
                if (!match) return submatch
                return {
                  ...submatch,
                  match: { text: match.text },
                  start: rebase(read(submatch, "start")),
                  end: rebase(read(submatch, "end")),
                }
              }),
            }
          : {}),
      },
    }
    return corrupt ? undefined : normalized
  }

  /**
   * Turn ripgrep NDJSON lines into match data, skipping records that cannot be used.
   *
   * `JSON.parse` + a strict `Result.parse` on every line meant one unusable record threw out of
   * `search()` and discarded every match already collected from unrelated files — the same defect
   * fixed in packages/core/src/ripgrep.ts. Records are independent, so a bad one is dropped and
   * counted. Exported so the skip paths are testable without a stub ripgrep binary.
   */
  export function parseRecords(lines: string[]): Match["data"][] {
    const matches: Match["data"][] = []
    let skipped = 0
    for (const line of lines) {
      // Bounds parse cost per record. This path buffers all of stdout before splitting, so it does
      // not bound total memory — that needs streaming, tracked separately.
      const parsed =
        Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES ? undefined : Result.safeParse(normalizeRecord(line))
      if (!parsed?.success) {
        skipped++
        continue
      }
      if (parsed.data.type === "match") matches.push(parsed.data.data)
    }
    // Counted and reported once rather than per record: without this a ripgrep protocol change
    // would make `/find` answer `[]`, which is indistinguishable from an honest "no matches".
    if (skipped > 0) log.warn("skipped unusable ripgrep records", { skipped, total: lines.length })
    return matches
  }
  // altimate_change end

  export type Result = z.infer<typeof Result>
  export type Match = z.infer<typeof Match>
  export type Begin = z.infer<typeof Begin>
  export type End = z.infer<typeof End>
  export type Summary = z.infer<typeof Summary>
  const PLATFORM = {
    "arm64-darwin": { platform: "aarch64-apple-darwin", extension: "tar.gz" },
    "arm64-linux": {
      platform: "aarch64-unknown-linux-gnu",
      extension: "tar.gz",
    },
    "x64-darwin": { platform: "x86_64-apple-darwin", extension: "tar.gz" },
    "x64-linux": { platform: "x86_64-unknown-linux-musl", extension: "tar.gz" },
    "arm64-win32": { platform: "aarch64-pc-windows-msvc", extension: "zip" },
    "x64-win32": { platform: "x86_64-pc-windows-msvc", extension: "zip" },
  } as const

  export const ExtractionFailedError = NamedError.create(
    "RipgrepExtractionFailedError",
    z.object({
      filepath: z.string(),
      stderr: z.string(),
    }),
  )

  export const UnsupportedPlatformError = NamedError.create(
    "RipgrepUnsupportedPlatformError",
    z.object({
      platform: z.string(),
    }),
  )

  export const DownloadFailedError = NamedError.create(
    "RipgrepDownloadFailedError",
    z.object({
      url: z.string(),
      status: z.number(),
    }),
  )

  const state = lazy(async () => {
    const system = which("rg")
    if (system) {
      const stat = await fs.stat(system).catch(() => undefined)
      if (stat?.isFile()) return { filepath: system }
      log.warn("bun.which returned invalid rg path", { filepath: system })
    }
    const filepath = path.join(Global.Path.bin, "rg" + (process.platform === "win32" ? ".exe" : ""))

    if (!(await Filesystem.exists(filepath))) {
      const platformKey = `${process.arch}-${process.platform}` as keyof typeof PLATFORM
      const config = PLATFORM[platformKey]
      if (!config) throw new UnsupportedPlatformError({ platform: platformKey })

      const version = "14.1.1"
      const filename = `ripgrep-${version}-${config.platform}.${config.extension}`
      const url = `https://github.com/BurntSushi/ripgrep/releases/download/${version}/${filename}`

      const response = await fetch(url)
      if (!response.ok) throw new DownloadFailedError({ url, status: response.status })

      const arrayBuffer = await response.arrayBuffer()
      const archivePath = path.join(Global.Path.bin, filename)
      await Filesystem.write(archivePath, Buffer.from(arrayBuffer))
      if (config.extension === "tar.gz") {
        const args = ["tar", "-xzf", archivePath, "--strip-components=1"]

        if (platformKey.endsWith("-darwin")) args.push("--include=*/rg")
        if (platformKey.endsWith("-linux")) args.push("--wildcards", "*/rg")

        const proc = Process.spawn(args, {
          cwd: Global.Path.bin,
          stderr: "pipe",
          stdout: "pipe",
        })
        const exit = await proc.exited
        if (exit !== 0) {
          const stderr = proc.stderr ? await text(proc.stderr) : ""
          throw new ExtractionFailedError({
            filepath,
            stderr,
          })
        }
      }
      if (config.extension === "zip") {
        const zipFileReader = new ZipReader(new BlobReader(new Blob([arrayBuffer])))
        const entries = await zipFileReader.getEntries()
        let rgEntry: any
        for (const entry of entries) {
          if (entry.filename.endsWith("rg.exe")) {
            rgEntry = entry
            break
          }
        }

        if (!rgEntry) {
          throw new ExtractionFailedError({
            filepath: archivePath,
            stderr: "rg.exe not found in zip archive",
          })
        }

        const rgBlob = await rgEntry.getData(new BlobWriter())
        if (!rgBlob) {
          throw new ExtractionFailedError({
            filepath: archivePath,
            stderr: "Failed to extract rg.exe from zip archive",
          })
        }
        await Filesystem.write(filepath, Buffer.from(await rgBlob.arrayBuffer()))
        await zipFileReader.close()
      }
      await fs.unlink(archivePath)
      if (!platformKey.endsWith("-win32")) await fs.chmod(filepath, 0o755)
    }

    return {
      filepath,
    }
  })

  export async function filepath() {
    const { filepath } = await state()
    return filepath
  }

  export async function* files(input: {
    cwd: string
    glob?: string[]
    hidden?: boolean
    follow?: boolean
    maxDepth?: number
    signal?: AbortSignal
  }) {
    input.signal?.throwIfAborted()

    const args = [await filepath(), "--files", "--glob=!.git/*"]
    if (input.follow) args.push("--follow")
    if (input.hidden !== false) args.push("--hidden")
    if (input.maxDepth !== undefined) args.push(`--max-depth=${input.maxDepth}`)
    if (input.glob) {
      for (const g of input.glob) {
        args.push(`--glob=${g}`)
      }
    }

    // Guard against invalid cwd to provide a consistent ENOENT error.
    if (!(await fs.stat(input.cwd).catch(() => undefined))?.isDirectory()) {
      throw Object.assign(new Error(`No such file or directory: '${input.cwd}'`), {
        code: "ENOENT",
        errno: -2,
        path: input.cwd,
      })
    }

    const proc = Process.spawn(args, {
      cwd: input.cwd,
      stdout: "pipe",
      stderr: "ignore",
      abort: input.signal,
    })

    if (!proc.stdout) {
      throw new Error("Process output not available")
    }

    let buffer = ""
    const stream = proc.stdout as AsyncIterable<Buffer | string>
    for await (const chunk of stream) {
      input.signal?.throwIfAborted()

      buffer += typeof chunk === "string" ? chunk : chunk.toString()
      // Handle both Unix (\n) and Windows (\r\n) line endings
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ""

      for (const line of lines) {
        if (line) yield line
      }
    }

    if (buffer) yield buffer
    await proc.exited

    input.signal?.throwIfAborted()
  }

  export async function tree(input: { cwd: string; limit?: number; signal?: AbortSignal }) {
    log.info("tree", input)
    const files = await Array.fromAsync(Ripgrep.files({ cwd: input.cwd, signal: input.signal }))
    interface Node {
      name: string
      children: Map<string, Node>
    }

    function dir(node: Node, name: string) {
      const existing = node.children.get(name)
      if (existing) return existing
      const next = { name, children: new Map() }
      node.children.set(name, next)
      return next
    }

    const root: Node = { name: "", children: new Map() }
    for (const file of files) {
      if (file.includes(".opencode")) continue
      const parts = file.split(path.sep)
      if (parts.length < 2) continue
      let node = root
      for (const part of parts.slice(0, -1)) {
        node = dir(node, part)
      }
    }

    function count(node: Node): number {
      let total = 0
      for (const child of node.children.values()) {
        total += 1 + count(child)
      }
      return total
    }

    const total = count(root)
    const limit = input.limit ?? total
    const lines: string[] = []
    const queue: { node: Node; path: string }[] = []
    for (const child of Array.from(root.children.values()).sort((a, b) => a.name.localeCompare(b.name))) {
      queue.push({ node: child, path: child.name })
    }

    let used = 0
    for (let i = 0; i < queue.length && used < limit; i++) {
      const { node, path } = queue[i]
      lines.push(path)
      used++
      for (const child of Array.from(node.children.values()).sort((a, b) => a.name.localeCompare(b.name))) {
        queue.push({ node: child, path: `${path}/${child.name}` })
      }
    }

    if (total > used) lines.push(`[${total - used} truncated]`)

    return lines.join("\n")
  }

  export async function search(input: {
    cwd: string
    pattern: string
    glob?: string[]
    limit?: number
    follow?: boolean
  }) {
    const args = [`${await filepath()}`, "--json", "--hidden", "--glob=!.git/*"]
    if (input.follow) args.push("--follow")

    if (input.glob) {
      for (const g of input.glob) {
        args.push(`--glob=${g}`)
      }
    }

    if (input.limit) {
      args.push(`--max-count=${input.limit}`)
    }

    args.push("--")
    args.push(input.pattern)

    const result = await Process.text(args, {
      cwd: input.cwd,
      nothrow: true,
    })
    if (result.code !== 0) {
      return []
    }

    // Handle both Unix (\n) and Windows (\r\n) line endings
    const lines = result.text.trim().split(/\r?\n/).filter(Boolean)
    // Parse JSON lines from ripgrep output

    // altimate_change start — upstream_fix: a bad record skips itself, not the whole search.
    return parseRecords(lines)
    // altimate_change end
  }
}
// altimate_change end
