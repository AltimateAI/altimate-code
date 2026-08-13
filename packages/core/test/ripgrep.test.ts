import { describe, expect, test as bunTest } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { RipgrepBinary } from "@opencode-ai/core/ripgrep/binary"
import { AppProcess } from "@opencode-ai/core/process"
import { RelativePath } from "@opencode-ai/core/schema"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Ripgrep.defaultLayer)

describe("Ripgrep", () => {
  it.live("keeps ignored files out of catch-all find results", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "node_modules", "pkg"), { recursive: true }))
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "src")))
          yield* Effect.promise(() => Bun.$`git init -q ${tmp.path}`)
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".gitignore"), "node_modules/\n"))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "node_modules", "pkg", "index.js"), "ignored\n"))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "src", "index.js"), "included\n"))

          const files = yield* (yield* Ripgrep.Service).find({ cwd: tmp.path, pattern: "*", limit: 10 })
          expect(files.map((item) => item.path)).toContain(RelativePath.make("src/index.js"))
          expect(files.map((item) => item.path)).not.toContain(RelativePath.make("node_modules/pkg/index.js"))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("never includes git metadata", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, ".opencode")))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".opencode", "config"), "needle\n"))
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, ".git")))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".git", "config"), "needle\n"))
          const ripgrep = yield* Ripgrep.Service

          const files = yield* ripgrep.find({ cwd: tmp.path, pattern: "**/*", limit: 10 })
          expect(files.map((item) => item.path)).toContain(RelativePath.make(".opencode/config"))
          expect(files.map((item) => item.path)).not.toContain(RelativePath.make(".git/config"))

          const observed: string[] = []
          const limited = yield* ripgrep.find({
            cwd: tmp.path,
            pattern: "**/*",
            limit: 1,
            onEntry: (entry) => Effect.sync(() => observed.push(entry.path)),
          })
          expect(observed).toEqual(limited.map((item) => item.path))

          const matches = yield* ripgrep.grep({ cwd: tmp.path, pattern: "needle", include: "config", limit: 10 })
          expect(matches.map((item) => item.entry.path)).toContain(RelativePath.make(".opencode/config"))
          expect(matches.map((item) => item.entry.path)).not.toContain(RelativePath.make(".git/config"))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  // altimate_change start — upstream_fix: preserve all debug rg search --glob entries
  it.live("grep accepts multiple include globs", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "one.ts"), "needle\n"))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "two.sql"), "needle\n"))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "three.md"), "needle\n"))

          const matches = yield* (yield* Ripgrep.Service).grep({
            cwd: tmp.path,
            pattern: "needle",
            include: ["*.ts", "*.sql"],
            limit: 10,
          })

          expect(matches.map((item) => item.entry.path).sort()).toEqual([
            RelativePath.make("one.ts"),
            RelativePath.make("two.sql"),
          ])
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  // upstream_fix: a ripgrep `--json` match record embeds the whole matched line, so a minified
  // bundle or single-line JSON fixture emits a record far past any per-record ceiling. That used to
  // fail the stream, taking every unrelated match in the search down with it.
  it.live("keeps matching unrelated files when one file has an oversized line", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "a-small.txt"), "needle here\n"))
          // Well past the old 64 KiB ceiling, well under the current sanity limit.
          yield* Effect.promise(() =>
            fs.writeFile(path.join(tmp.path, "b-minified.js"), "x".repeat(100_000) + "needle" + "y".repeat(100_000)),
          )

          const matches = yield* (yield* Ripgrep.Service).grep({ cwd: tmp.path, pattern: "needle", limit: 10 })

          // Both the bystander and the oversized file are reported; neither is lost to a failure.
          expect(matches.map((item) => item.entry.path).sort()).toEqual([
            RelativePath.make("a-small.txt"),
            RelativePath.make("b-minified.js"),
          ])
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  // upstream_fix: ripgrep emits `{"bytes": "<base64>"}` instead of `{"text": ...}` for a line that
  // is not valid UTF-8. The schema modelled only the `text` arm, so one stray byte failed the whole
  // search — the same abort-everything shape as the oversized record. This drives real ripgrep;
  // the exact decoding is pinned by the stubbed case below.
  it.live("returns matches from files containing non-UTF8 lines", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "a-plain.txt"), "needle here\n"))
          yield* Effect.promise(() =>
            fs.writeFile(path.join(tmp.path, "b-binary.txt"), Buffer.from("needle \xff\xfe tail\n", "binary")),
          )
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "c-plain.txt"), "needle here\n"))

          const matches = yield* (yield* Ripgrep.Service).grep({ cwd: tmp.path, pattern: "needle", limit: 10 })

          // The non-UTF8 file is reported like any other rather than dropped or fatal.
          expect(matches.map((item) => item.entry.path).sort()).toEqual([
            RelativePath.make("a-plain.txt"),
            RelativePath.make("b-binary.txt"),
            RelativePath.make("c-plain.txt"),
          ])
          // Undecodable bytes become U+FFFD, so the surrounding text stays readable.
          const binary = matches.find((item) => item.entry.path === RelativePath.make("b-binary.txt"))
          expect(binary?.text).toContain("needle")
          expect(binary?.text).toContain("tail")
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  // Real ripgrep cannot be coerced into emitting a chosen bad record — `--` makes the next arg the
  // pattern — so these cases drive the parser through a stub `rg` that prints exactly the NDJSON
  // given. Only the executable is stubbed: the real spawn, decode, line splitting, parse, collection
  // and output mapping all still run. Plain `bunTest` because these supply their own Ripgrep layer,
  // which the ambient `testEffect(Ripgrep.defaultLayer)` would otherwise shadow.
  const matchRecord = (file: string, overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: "match",
      data: {
        path: { text: `./${file}` },
        lines: { text: "needle\n" },
        line_number: 1,
        absolute_offset: 0,
        submatches: [{ match: { text: "needle" }, start: 0, end: 6 }],
        ...overrides,
      },
    })

  const grepWithStubbedRecords = (records: string[]) =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const data = path.join(tmp.path, "records.jsonl")
          yield* Effect.promise(() => fs.writeFile(data, records.join("\n") + "\n"))
          const stub = path.join(tmp.path, "rg")
          yield* Effect.promise(() => fs.writeFile(stub, `#!/bin/sh\ncat ${JSON.stringify(data)}\n`))
          yield* Effect.promise(() => fs.chmod(stub, 0o755))

          return yield* Effect.gen(function* () {
            const rg = yield* Ripgrep.Service
            return yield* rg.grep({ cwd: tmp.path, pattern: "needle", limit: 100 })
          }).pipe(
            Effect.provide(
              Ripgrep.layer.pipe(
                Layer.provide(
                  Layer.succeed(RipgrepBinary.Service, RipgrepBinary.Service.of({ filepath: Effect.succeed(stub) })),
                ),
                Layer.provide(AppProcess.defaultLayer),
              ),
            ),
          )
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    )

  bunTest("skips an unparseable record without failing the search", async () => {
    const matches = await Effect.runPromise(
      grepWithStubbedRecords([
        matchRecord("a.txt"),
        '{"type":"match","data":{"path":{"text":"./b.t', // truncated mid-JSON
        matchRecord("c.txt"),
      ]),
    )

    // The malformed middle record is dropped; the records on either side survive.
    expect(matches.map((item) => item.entry.path)).toEqual([RelativePath.make("a.txt"), RelativePath.make("c.txt")])
  })

  // The size ceiling is asserted on a record built to exceed it, rather than inferred from a large
  // file — that keeps the case independent of whether a given ripgrep build emits the match at all.
  bunTest("skips an oversized record and keeps parsing the records after it", async () => {
    const matches = await Effect.runPromise(
      grepWithStubbedRecords([
        matchRecord("a.txt"),
        matchRecord("b-huge.txt", { lines: { text: "needle" + "x".repeat(17 * 1024 * 1024) } }),
        matchRecord("c.txt"),
      ]),
    )

    expect(matches.map((item) => item.entry.path)).toEqual([RelativePath.make("a.txt"), RelativePath.make("c.txt")])
  })

  // A path is an identifier the caller reopens, so it must never be lossily decoded. Such a record
  // is skipped rather than reported under a U+FFFD-mangled path that names no real file.
  bunTest("skips a match whose path is not valid UTF-8, keeping the rest", async () => {
    const matches = await Effect.runPromise(
      grepWithStubbedRecords([
        matchRecord("a.txt"),
        matchRecord("ignored", { path: { bytes: Buffer.from("./b\xff.txt", "binary").toString("base64") } }),
        matchRecord("c.txt"),
      ]),
    )

    expect(matches.map((item) => item.entry.path)).toEqual([RelativePath.make("a.txt"), RelativePath.make("c.txt")])
  })

  // `Buffer.from` maps unconvertible base64 to an empty buffer instead of throwing, which would turn
  // a corrupt record into a schema-valid EMPTY match. It must be skipped, not silently emptied.
  bunTest("skips a record whose bytes field is not valid base64", async () => {
    const matches = await Effect.runPromise(
      grepWithStubbedRecords([
        matchRecord("a.txt"),
        matchRecord("b.txt", { lines: { bytes: "!!!not base64!!!" } }),
        matchRecord("c.txt"),
      ]),
    )

    expect(matches.map((item) => item.entry.path)).toEqual([RelativePath.make("a.txt"), RelativePath.make("c.txt")])
  })

  bunTest("decodes a non-UTF8 match line to replacement characters", async () => {
    const matches = await Effect.runPromise(
      grepWithStubbedRecords([
        matchRecord("a.txt", {
          lines: { bytes: Buffer.from("needle \xff\xfe tail\n", "binary").toString("base64") },
          submatches: [{ match: { bytes: Buffer.from("needle", "binary").toString("base64") }, start: 0, end: 6 }],
        }),
      ]),
    )

    expect(matches).toHaveLength(1)
    // Content is display text, so lossy decoding keeps the match usable rather than dropping it.
    expect(matches[0].text).toBe("needle �� tail\n")
    expect(matches[0].submatches[0].text).toBe("needle")
  })
  // altimate_change end
})
