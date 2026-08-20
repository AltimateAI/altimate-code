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
import { RipgrepRecords } from "./ripgrep-records"

export namespace Ripgrep {
  const log = Log.create({ service: "ripgrep" })
  // altimate_change start — upstream_fix: record parsing lives in ./ripgrep-records so it can be
  // tested directly, without exporting an implementation detail through this namespace and without
  // a stub binary whose per-process memoisation leaks into other test files. `Match` stays exported
  // here because server/routes/file.ts builds the `/find` response schema from it.
  export const Match = RipgrepRecords.Match
  const parseRecords = RipgrepRecords.parseRecords
  // altimate_change end

  export type Result = RipgrepRecords.Result
  export type Match = RipgrepRecords.Match
  export type Begin = RipgrepRecords.Begin
  export type End = RipgrepRecords.End
  export type Summary = RipgrepRecords.Summary
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
